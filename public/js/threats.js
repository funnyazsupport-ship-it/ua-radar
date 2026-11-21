/**
 * Оцінка загроз і навчальна симуляція.
 *
 * Два незалежні режими:
 *
 *   ОЦІНКА (estimate) — працює на реальних даних тривог. Ми знаємо, ДЕ
 *   тривога, і знаємо географію пускових зон. З цього виводимо ймовірний
 *   клас засобу ураження, азимут підльоту та орієнтовний час до цілі.
 *   Це розрахунок, а не спостереження: справжніх радарних треків у
 *   відкритому доступі не існує.
 *
 *   СИМУЛЯЦІЯ (sim) — згенеровані треки для тренувань і перевірки мапи.
 *   Позначені окремо, з даними тривог не змішуються.
 */
window.ThreatEngine = (function () {
  'use strict';

  const R_EARTH = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;

  /* ── геометрія ────────────────────────────────────────────────────── */

  function distKm(a, b) {
    const dLat = rad(b[0] - a[0]);
    const dLon = rad(b[1] - a[1]);
    const la1 = rad(a[0]);
    const la2 = rad(b[0]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function bearing(a, b) {
    const la1 = rad(a[0]);
    const la2 = rad(b[0]);
    const dLon = rad(b[1] - a[1]);
    const y = Math.sin(dLon) * Math.cos(la2);
    const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }

  /** точка на відстані d (км) від p по азимуту brg */
  function destination(p, brg, d) {
    const la1 = rad(p[0]);
    const lo1 = rad(p[1]);
    const t = rad(brg);
    const dr = d / R_EARTH;
    const la2 = Math.asin(Math.sin(la1) * Math.cos(dr) + Math.cos(la1) * Math.sin(dr) * Math.cos(t));
    const lo2 = lo1 + Math.atan2(Math.sin(t) * Math.sin(dr) * Math.cos(la1), Math.cos(dr) - Math.sin(la1) * Math.sin(la2));
    return [deg(la2), ((deg(lo2) + 540) % 360) - 180];
  }

  const compass = (b) => ['Пн', 'ПнСх', 'Сх', 'ПдСх', 'Пд', 'ПдЗх', 'Зх', 'ПнЗх'][Math.round(b / 45) % 8];

  /* ── оцінка загрози за станом тривог ──────────────────────────────── */

  const CFG = window.CFG;

  function typesFor(regionName) {
    const out = [];
    for (const [key, t] of Object.entries(CFG.THREATS)) {
      if (key === 'recon_uav') continue; // не є причиною тривоги сам по собі
      const reach = CFG.REACH[key];
      if (reach && !reach.includes(regionName)) continue;
      let score = 1 / t.priority;
      if (CFG.FRONTLINE_REGIONS.includes(regionName) && (key === 'sam' || key === 'kab' || key === 'ballistic')) score *= 2.2;
      if (key === 'shahed') score *= 1.9; // найчастіший засіб
      if (key === 'cruise_air' || key === 'aeroballistic' || key === 'kh22') score *= 0.55; // рідше, лише під час масованих атак
      out.push({ key, score, def: t });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  function nearestOrigin(type, target) {
    let best = null;
    for (const o of CFG.ORIGINS) {
      if (!o.types.includes(type)) continue;
      const d = distKm(o.ll, target);
      if (!best || d < best.d) best = { origin: o, d };
    }
    return best;
  }

  /**
   * @param {Array} regions нормалізовані області з /api/alerts
   * @param {Object} geoIndex name -> {centroid:[lat,lon]}
   * @returns {{level:number, label:string, vectors:Array, summary:Object}}
   */
  function estimate(regions, geoIndex) {
    // r.permanent — тривога, увімкнена ще у 2022 році на окупованих
    // територіях. Це стан території, а не поточна загроза: у розрахунок
    // не беремо, інакше рівень загрози ніколи не опускається до нуля.
    const active = regions.filter((r) => r.alert && !r.permanent);
    const vectors = [];
    const byType = {};

    for (const r of active) {
      const g = geoIndex[r.name];
      if (!g) continue;
      const target = g.centroid;
      const cand = typesFor(r.name).slice(0, 2);
      const total = cand.reduce((s, c) => s + c.score, 0) || 1;

      cand.forEach((c, i) => {
        const no = nearestOrigin(c.key, target);
        if (!no) return;
        const brg = bearing(no.origin.ll, target);
        // далекі пускові зони показуємо як вектор від кордону по істинному азимуту
        const from = no.origin.far ? destination(target, (brg + 180) % 360, 420) : no.origin.ll;
        const flightKm = no.d;
        const etaMin = (flightKm / c.def.speed) * 60;
        vectors.push({
          id: `${r.name}|${c.key}`,
          region: r.name,
          type: c.key,
          def: c.def,
          from,
          to: target,
          trueOrigin: no.origin,
          clamped: !!no.origin.far,
          bearing: brg,
          approachFrom: compass((brg + 180) % 360),
          distanceKm: Math.round(flightKm),
          etaMin,
          confidence: Math.round((c.score / total) * 100),
          primary: i === 0,
          since: r.since,
        });
        byType[c.key] = (byType[c.key] || 0) + (i === 0 ? 1 : 0);
      });
    }

    const n = active.length;
    let level = 0;
    let label = 'Спокійно';
    if (n > 0) { level = 1; label = 'Локальна тривога'; }
    if (n >= 4) { level = 2; label = 'Масштабна тривога'; }
    if (n >= 10) { level = 3; label = 'Масована атака'; }
    if (n >= 18) { level = 4; label = 'Тривога по всій країні'; }

    const ballisticRisk = vectors.some((v) => v.primary && (v.type === 'ballistic' || v.type === 'aeroballistic' || v.type === 'sam'));

    return {
      level,
      label,
      activeCount: n,
      vectors,
      byType,
      ballisticRisk,
      minEta: vectors.filter((v) => v.primary).reduce((m, v) => (m === null || v.etaMin < m ? v.etaMin : m), null),
    };
  }

  /* ── навчальна симуляція ──────────────────────────────────────────── */

  let sim = { on: false, tracks: [], seq: 0, lastTick: 0, wave: null };

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function spawn(targets, forcedType) {
    const type = forcedType || pick(['shahed', 'shahed', 'shahed', 'cruise_sea', 'cruise_air', 'ballistic', 'aeroballistic', 'kh22', 'cruise_ground']);
    const def = CFG.THREATS[type];
    const target = pick(targets);
    const no = nearestOrigin(type, target.ll);
    if (!no) return null;
    const brg = bearing(no.origin.ll, target.ll);
    const base = no.origin.far ? destination(target.ll, (brg + 180) % 360, 500 + Math.random() * 200) : no.origin.ll;
    // розкидаємо точки старту навколо зони пуску, інакше десяток цілей
    // з одного напрямку малюється однією купою
    const start = destination(base, Math.random() * 360, Math.random() * 70);
    const total = distKm(start, target.ll);
    return {
      id: ++sim.seq,
      type,
      def,
      start,
      target: target.ll,
      targetName: target.n,
      pos: start.slice(),
      progress: 0,
      totalKm: total,
      // невелике боковий знос, щоб маршрут не був ідеально прямим
      jitter: (Math.random() - 0.5) * (type === 'shahed' ? 0.55 : 0.12),
      speed: def.speed * (0.9 + Math.random() * 0.2),
      trail: [start.slice()],
      state: 'inbound',
      born: Date.now(),
      delay: 0, // зсув старту, щоб хвиля заходила не одночасно
    };
  }

  function startSim(targets, intensity) {
    sim.on = true;
    sim.tracks = [];
    sim.lastTick = performance.now();
    const count = intensity === 'massive' ? 34 : intensity === 'medium' ? 14 : 5;
    for (let i = 0; i < count; i++) {
      const t = spawn(targets, intensity === 'massive' && i % 4 === 0 ? 'cruise_air' : null);
      if (!t) continue;
      t.delay = i * 700 + Math.random() * 600;
      sim.tracks.push(t);
    }
    sim.wave = { intensity, startedAt: Date.now() };
    return sim.tracks.length;
  }

  function stopSim() {
    sim.on = false;
    sim.tracks = [];
    sim.wave = null;
  }

  /** @returns {{tracks:Array, events:Array}} */
  function tickSim(targets) {
    const now = performance.now();
    const dtH = Math.min(0.5, (now - sim.lastTick) / 1000) / 3600; // секунди → години
    sim.lastTick = now;
    if (!sim.on) return { tracks: [], events: [] };

    const events = [];
    const timeScale = 150; // 1 с реального часу ≈ 2,5 хв польоту

    for (const t of sim.tracks) {
      if (t.state !== 'inbound') continue;
      if (t.delay && Date.now() - t.born < t.delay) continue;
      const step = t.speed * dtH * timeScale; // км за такт
      t.progress = Math.min(1, t.progress + step / t.totalKm);

      const brg = bearing(t.start, t.target);
      const straight = destination(t.start, brg, t.totalKm * t.progress);
      // знос по синусоїді — імітує реальний ламаний маршрут
      const drift = Math.sin(t.progress * Math.PI) * t.jitter;
      t.pos = destination(straight, (brg + 90) % 360, drift * 90);

      const last = t.trail[t.trail.length - 1];
      if (!last || distKm(last, t.pos) > 6) {
        t.trail.push(t.pos.slice());
        if (t.trail.length > 90) t.trail.shift();
      }

      t.remainKm = Math.round(t.totalKm * (1 - t.progress));
      t.etaMin = (t.remainKm / t.speed) * 60;

      // ППО: шанс збиття зростає ближче до цілі, БпЛА збиваються частіше
      const pk = t.type === 'shahed' ? 0.018 : t.type === 'cruise_sea' || t.type === 'cruise_air' ? 0.012 : 0.0035;
      if (t.progress > 0.35 && Math.random() < pk) {
        t.state = 'intercepted';
        events.push({ kind: 'intercepted', track: t });
        continue;
      }
      if (t.progress >= 1) {
        t.state = 'arrived';
        events.push({ kind: 'arrived', track: t });
      }
    }

    // прибрані треки замінюємо новими, поки хвиля активна
    const alive = sim.tracks.filter((t) => t.state === 'inbound' || Date.now() - (t.endedAt || (t.endedAt = Date.now())) < 4000);
    sim.tracks = alive;
    const inbound = sim.tracks.filter((t) => t.state === 'inbound').length;
    const waveAge = sim.wave ? Date.now() - sim.wave.startedAt : 0;
    const cap = sim.wave && sim.wave.intensity === 'massive' ? 34 : sim.wave && sim.wave.intensity === 'medium' ? 14 : 5;
    if (sim.on && waveAge < 6 * 60_000 && inbound < cap) {
      const t = spawn(targets);
      if (t) sim.tracks.push(t);
    }

    return { tracks: sim.tracks, events };
  }

  return {
    distKm, bearing, destination, compass,
    estimate, typesFor, nearestOrigin,
    startSim, stopSim, tickSim,
    get simOn() { return sim.on; },
    get simWave() { return sim.wave; },
  };
})();
