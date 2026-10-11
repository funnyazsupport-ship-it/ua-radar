/**
 * Робота з контактами моніторингу: числення шляху й підлітний час.
 *
 * Канал доповідає: «Реактивний БпЛА повз Українку на Київ» о 03:12.
 * Далі до наступної доповіді ми цілі не бачимо. Тому:
 *   - положення рахуємо від точки доповіді за паспортною швидкістю класу;
 *   - похибку показуємо колом, що росте з віком доповіді;
 *   - коли розрахунковий час прибуття минув, контакт гасне.
 *
 * Це числення шляху (dead reckoning), а не спостереження. Різниця критична:
 * реальна ціль маневрує, знижується, її збивають.
 */
window.Contacts = (function () {
  'use strict';

  const CFG = window.CFG;
  const TE = window.ThreatEngine;

  /** Частка шляху, на яку розходяться розрахунок і дійсність. */
  const DRIFT = 0.35;
  /** Скільки контакт живе після розрахункового прибуття. */
  const LINGER_MS = 4 * 60_000;

  const def = (type) => CFG.THREATS[type] || CFG.THREATS.unknown;

  /**
   * @param {Object} c контакт із /api/monitor
   * @param {number} now час (з поправкою на сервер)
   * @returns {Object|null} стан контакту або null, якщо він уже не актуальний
   */
  function project(c, now) {
    const d = def(c.type);
    const ageMs = now - c.at;
    if (ageMs < 0) return null;
    const ageMin = ageMs / 60_000;
    const travelledKm = (d.speed * ageMs) / 3_600_000;

    const to = c.to && c.to.ll;
    const from = c.from && c.from.ll;

    // Подія пуску або зльоту: цікавить рубіж досяжності.
    // Але «Пуски КАБ на Суми» — це ціль, а не точка пуску, тож рубіж
    // малюємо лише коли місце справді є відомим районом пуску.
    const isLaunchEvent = (c.action === 'launch' || c.action === 'takeoff') && (c.site || from);
    if (isLaunchEvent) {
      const origin = c.site ? to || from : from;
      if (!origin) return null;
      if (travelledKm > d.range * 1.3) return null;
      return {
        c, def: d, kind: 'launch', ageMin,
        pos: origin,
        reachKm: Math.min(travelledKm, d.range),
        maxRangeKm: d.range,
        label: c.site || (c.from && c.from.n) || (c.to && c.to.n) || '—',
      };
    }

    // влучання — статична позначка, живе недовго
    if (c.action === 'impact') {
      const pos = to || from;
      if (!pos || ageMs > 15 * 60_000) return null;
      return { c, def: d, kind: 'impact', ageMin, pos };
    }

    if (c.action === 'clear') return null;

    // відомі і точка спостереження, і ціль — рахуємо шлях між ними
    if (from && to) {
      const totalKm = TE.distKm(from, to);
      const f = totalKm > 0 ? travelledKm / totalKm : 1;
      if (f > 1 && ageMs - (totalKm / d.speed) * 3_600_000 > LINGER_MS) return null;
      const frac = Math.min(1, f);
      const brg = TE.bearing(from, to);
      const pos = TE.destination(from, brg, totalKm * frac);
      const remainKm = Math.max(0, totalKm - travelledKm);
      return {
        c, def: d, kind: 'track', ageMin, pos,
        heading: brg,
        remainKm,
        etaMin: (remainKm / d.speed) * 60,
        totalKm,
        frac,
        uncertaintyKm: Math.min(travelledKm * DRIFT, 60),
        target: c.to.n,
        arrived: frac >= 1,
      };
    }

    // відома тільки ціль — позначаємо саме її, без вигаданої траєкторії
    if (to) {
      if (ageMs > 25 * 60_000) return null;
      return {
        c, def: d, kind: 'inbound', ageMin, pos: to,
        heading: c.heading,
        target: c.to.n,
        uncertaintyKm: Math.min(travelledKm * DRIFT, 45),
      };
    }

    // відома тільки точка спостереження і курс — ведемо по курсу
    if (from) {
      if (ageMs > 25 * 60_000) return null;
      const brg = c.heading;
      const pos = brg == null ? from : TE.destination(from, brg, travelledKm);
      return {
        c, def: d, kind: brg == null ? 'spot' : 'track', ageMin, pos,
        heading: brg,
        uncertaintyKm: Math.min(travelledKm * DRIFT, 60),
        origin: c.from.n,
      };
    }

    return null; // лише область — на мапі показувати нічого
  }

  /**
   * Куди і за скільки долетить, якщо пуск стався з цієї точки.
   * Саме на це питання відповідає панель після «Зліт МіГ-31К».
   *
   * @returns {Array} міста в межах дальності, відсортовані за часом підльоту
   */
  function reachTable(originLL, type, sinceMs, now) {
    const d = def(type);
    const elapsedMin = Math.max(0, (now - sinceMs) / 60_000);
    const rows = [];
    for (const city of CFG.CITIES) {
      if (city.occ) continue;
      const km = TE.distKm(originLL, city.ll);
      if (km > d.range) continue;
      const flightMin = (km / d.speed) * 60;
      rows.push({
        city: city.n,
        ll: city.ll,
        pop: city.pop,
        distanceKm: Math.round(km),
        flightMin,
        leftMin: flightMin - elapsedMin,
        reached: flightMin <= elapsedMin,
      });
    }
    return rows.sort((a, b) => a.flightMin - b.flightMin);
  }

  /** Зведення по активних контактах для шапки. */
  function summary(states) {
    const byType = {};
    let inbound = 0;
    let minEta = null;
    let launches = 0;
    for (const s of states) {
      byType[s.c.type] = (byType[s.c.type] || 0) + (s.c.count || 1);
      if (s.kind === 'launch') launches++;
      if (s.kind === 'track' || s.kind === 'inbound') {
        inbound += s.c.count || 1;
        if (s.etaMin != null && (minEta === null || s.etaMin < minEta)) minEta = s.etaMin;
      }
    }
    return { byType, inbound, minEta, launches, total: states.length };
  }

  return { project, reachTable, summary, def, DRIFT };
})();
