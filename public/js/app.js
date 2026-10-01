/**
 * UA-RADAR — головний модуль: мапа, шари, опитування, інтерфейс.
 */
(function () {
  'use strict';

  const CFG = window.CFG;
  const TE = window.ThreatEngine;
  const CT = window.Contacts;
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };

  const POLL_MS = 6_000;
  /** Порожньо — свій домен; інакше адреса машини із server.js. */
  const BASE = CFG.apiBase();
  const api = (p) => BASE + p;
  /** Тривога, що триває довше за це, — не подія, а стан окупованої території. */
  const PERMANENT_AFTER = 14 * 24 * 3600_000;

  const S = {
    geo: null,
    index: {},        // назва області -> { centroid, cities, feature }
    regions: [],
    events: [],
    simEvents: [],
    est: null,
    selected: null,
    sound: false,
    clockSkew: 0,     // серверний час мінус локальний
    layers: { alerts: true, contacts: true, raions: true, detail: false, front: true, cities: true, npp: false, origins: false, labels: true },
    cities: [],         // повний перелік міст для мапи
    contacts: [],       // сирі контакти з /api/monitor
    tracks: [],         // зшиті траєкторії з сервера
    intercepts: [],     // збиті цілі
    watch: null,        // місто, за яким стежимо
    ai: null,           // оцінка обстановки від моделі
    trackStats: null,
    contactStates: [],  // після числення шляху
    feed: [],           // стрічка повідомлень каналів
    channels: [],
    monitorTs: 0,
    monitorErr: null,
    selectedContact: null,
    userMoved: false,   // людина сама рухала мапу — не переставляємо кадр
    levels: {},        // назва області -> рівень тривоги
    raionPainted: new Set(),
    ext: { raionLevels: [], tracks: [], sources: [] },
    failures: 0,
  };

  /* ═══════════════ утиліти ═══════════════ */

  const now = () => Date.now() + S.clockSkew;

  function fmtDur(ms) {
    if (ms == null || ms < 0) return '—';
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const p = (v) => String(v).padStart(2, '0');
    return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
  }

  function fmtEta(min) {
    if (min == null) return '—';
    if (min < 1) return '<1 хв';
    if (min < 60) return Math.round(min) + ' хв';
    const h = Math.floor(min / 60);
    return `${h} год ${Math.round(min % 60)} хв`;
  }

  const fmtTime = (t) => new Date(t).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });

  function fmtPop(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + ' млн';
    if (n >= 1e3) return Math.round(n / 1e3) + ' тис';
    return String(n);
  }

  const shortName = (n) => n.replace(' область', '').replace('м. ', '');

  function pointInRing(pt, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /** pt у [lon, lat] */
  function pointInFeature(pt, feature) {
    const g = feature.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const poly of polys) {
      if (pointInRing(pt, poly[0])) {
        let inHole = false;
        for (let k = 1; k < poly.length; k++) if (pointInRing(pt, poly[k])) inHole = true;
        if (!inHole) return true;
      }
    }
    return false;
  }

  function threatIcon(def, size) {
    const s = size || 14;
    // evenodd — щоб вирізи всередині силуету (ромб «невідомий тип») читались
    return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" style="color:${def.color}"><path d="${def.icon}" fill="currentColor" fill-rule="evenodd"/></svg>`;
  }

  /* ═══════════════ мапа ═══════════════ */

  let map, layerBase, layerOblast, layerLabels, layerFront, layerCities, layerNpp, layerOrigins, layerTracks, layerContacts, layerReach, layerRaions, layerDetail;
  const oblastPaths = {};   // назва -> leaflet layer
  const oblastLabels = {};  // назва -> marker
  const trackViews = {};    // id -> { marker, trail }

  function buildMap() {
    map = L.map('map', {
      center: CFG.MAP.center,
      zoom: CFG.MAP.zoom,
      minZoom: CFG.MAP.minZoom,
      maxZoom: CFG.MAP.maxZoom,
      maxBounds: CFG.MAP.bounds,
      maxBoundsViscosity: 0.65,
      zoomControl: false,
      attributionControl: true,
      preferCanvas: false,
      // дробовий зум: інакше fitBounds округлює вниз і країна займає
      // половину кадру на високих вікнах
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 90,
    });
    L.control.zoom({ position: 'topleft' }).addTo(map);
    map.attributionControl.addAttribution(CFG.MAP.attribution);

    map.createPane('grid').style.zIndex = 210;
    map.createPane('base').style.zIndex = 230;
    map.createPane('front').style.zIndex = 250;
    map.createPane('oblast').style.zIndex = 350;
    map.createPane('raion').style.zIndex = 360;
    map.getPane('raion').style.pointerEvents = 'none';
    map.createPane('reach').style.zIndex = 420;
    map.getPane('grid').style.pointerEvents = 'none';
    map.getPane('base').style.pointerEvents = 'none';

    // детальна підкладка: за замовчуванням вимкнена, потрібна на зумі
    layerDetail = L.tileLayer(CFG.MAP.detailTiles, {
      maxZoom: CFG.MAP.maxZoom,
      attribution: CFG.MAP.detailAttribution,
      className: 'detail-tiles',
      opacity: 0.85,
    });

    injectPatterns();
    buildGraticule();
    layerBase = L.layerGroup([], { pane: 'base' }).addTo(map);
    layerFront = L.layerGroup([], { pane: 'front' }).addTo(map);
    layerTracks = L.layerGroup().addTo(map);
    layerReach = L.layerGroup([], { pane: 'reach' }).addTo(map);
    layerContacts = L.layerGroup().addTo(map);
    layerCities = L.layerGroup().addTo(map);
    layerNpp = L.layerGroup();
    layerOrigins = L.layerGroup();
    layerLabels = L.layerGroup().addTo(map);

    map.on('click', () => closeDetail());

    // на малому зумі підписи областей накладаються на обласні центри,
    // тому там лишаємо тільки ті області, де зараз тривога
    const syncZoom = () => {
      const z = map.getZoom();
      document.body.classList.toggle('zoom-lo', z < 7);
      // на телефоні країна вміщається на зумі ~4,8 — там читаються
      // тільки назви мільйонників
      document.body.classList.toggle('zoom-xs', z < 5.5);
      // ранг міста, підписи якого вже вміщаються
      // на типовому зумі (вся країна) мають читатись усі обласні
      // центри й великі міста, а не лише мільйонники
      document.body.dataset.z = z < 5.2 ? '1' : z < 7 ? '2' : z < 8.5 ? '3' : '4';
      // прозорість заливки залежить від зуму — перефарбовуємо
      if (S.regions.length) restyleOblasts();
    };
    map.on('zoomend', syncZoom);
    syncZoom();
  }

  /**
   * Leaflet застосовує options.className лише при створенні шару, тож
   * перемикати клас на льоту доводиться прямо на SVG-елементі.
   */
  function setPathClass(lyr, cls) {
    const path = lyr && lyr._path;
    if (!path) return;
    const base = lyr.options && lyr.options.interactive === false ? '' : 'leaflet-interactive';
    const next = (base + ' ' + (cls || '')).trim();
    if (path.getAttribute('class') !== next) path.setAttribute('class', next);
  }

  /** Сітка координат — орієнтир і радарне тло. */
  function buildGraticule() {
    const g = L.layerGroup([], { pane: 'grid' }).addTo(map);
    const st = { pane: 'grid', color: '#15202b', weight: 0.6, opacity: 1, interactive: false };
    for (let lat = 42; lat <= 56; lat += 2) L.polyline([[lat, 16], [lat, 48]], st).addTo(g);
    for (let lon = 18; lon <= 46; lon += 2) L.polyline([[41, lon], [56, lon]], st).addTo(g);
  }

  /** Сусідні держави та моря — локальна підкладка замість растрових тайлів. */
  function renderBase(fc) {
    layerBase.clearLayers();
    L.geoJSON(fc, {
      pane: 'base',
      interactive: false,
      style: (f) =>
        f.properties.ua
          ? { color: '#2b3b4d', weight: 1.4, fillColor: '#0c141c', fillOpacity: 1, interactive: false }
          : { color: '#26394c', weight: 0.9, fillColor: '#131d28', fillOpacity: 1, interactive: false },
    }).addTo(layerBase);

    for (const l of CFG.NEIGHBOUR_LABELS) {
      L.marker(l.ll, {
        interactive: false,
        icon: L.divIcon({
          className: '',
          html: `<div class="country-label${l.sea ? ' sea' : ''}">${l.n}</div>`,
          iconSize: [0, 0],
        }),
      }).addTo(layerBase);
    }
  }

  /* ── шар областей ── */

  function oblastStyle(feature) {
    const name = feature.properties.name;
    const r = S.regions.find((x) => x.name === name);
    const on = r && r.alert;
    if (!S.layers.alerts) {
      return { pane: 'oblast', color: '#2a3746', weight: 1, fillColor: '#0f151d', fillOpacity: 0.35, className: 'ob' };
    }
    if (on && r.permanent) {
      // окупована територія: тривога стоїть роками — показуємо як стан, не як подію
      return { pane: 'oblast', color: '#7a2b45', weight: 1, fillColor: '#8c2846', fillOpacity: 0.3, className: 'ob' };
    }

    const lv = S.levels[name];
    if (on || (lv && lv.rank >= 2)) {
      // колір за рівнем: червоний — ракетна небезпека, жовтий — БпЛА
      const level = lv ? lv.level : 'alert';
      const col = LEVELS[level].color;

      // Якщо в області вже промальовані райони — вони й несуть сигнал,
      // а область лишається лише контуром. Інакше дві заливки
      // складаються і на зумі все зливається в суцільну пляму.
      const detailed = S.raionPainted && S.raionPainted.has(name);
      const z = map ? map.getZoom() : 6;

      // Де промальовані райони — область лишається контуром, сигнал
      // несуть вони. Інакше штрихуємо саму область.
      let fill = detailed ? (z >= 7.5 ? 0.05 : 0.12) : 0.85;
      if (z >= 9.5) fill = Math.min(fill, detailed ? 0.05 : 0.5);

      return {
        pane: 'oblast',
        color: col,
        weight: level === 'red' ? 2 : 1.5,
        fillColor: detailed ? col : `url(#hatch-${level})`,
        fillOpacity: fill,
        className: 'ob ob-on ob-' + (detailed ? 'muted' : level),
      };
    }
    return { pane: 'oblast', color: '#2f4a3e', weight: 1, fillColor: '#12261e', fillOpacity: 0.45, className: 'ob' };
  }

  /** Прапорець, поки мапу рухає код, а не людина. */
  let programmatic = false;

  function fitUkraine(animate) {
    if (!layerOblast) return;
    programmatic = true;
    S.userMoved = false;
    // анімація зуму спирається на CSS-перехід: якщо вкладка прихована й
    // не малюється, перехід не завершується і кадр «зависає». Тому в
    // невидимій вкладці рухаємо мапу без анімації.
    const anim = !!animate && !document.hidden;
    map.fitBounds(layerOblast.getBounds(), { padding: [16, 16], animate: anim });
    setTimeout(() => { programmatic = false; }, anim ? 700 : 60);
  }

  /**
   * Мапу рухала людина — далі не втручаємось.
   * Без цього будь-яка зміна розміру вікна скидала зум назад на всю
   * країну, і мапа «не слухалась».
   */
  function markUserMove() {
    if (!programmatic) S.userMoved = true;
  }

  function buildOblastLayer() {
    layerOblast = L.geoJSON(S.geo, {
      style: oblastStyle,
      onEachFeature: (f, lyr) => {
        const name = f.properties.name;
        oblastPaths[name] = lyr;
        lyr.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          openDetail(name);
        });
        lyr.on('mouseover', () => lyr.setStyle({ weight: 2.6 }));
        lyr.on('mouseout', () => lyr.setStyle({ weight: oblastStyle(f).weight }));
      },
    }).addTo(map);

    // підписи областей
    for (const f of S.geo.features) {
      const p = f.properties;
      const ll = [p.centroid[1], p.centroid[0]];
      // Київ-місто зсуваємо, щоб не накладався на область
      const offset = p.id === 'UA.KC' ? [16, -22] : [0, -13];
      const m = L.marker(ll, {
        interactive: false,
        icon: L.divIcon({
          className: '',
          html: `<div class="oblast-label" style="transform:translate(${offset[0]}px,${offset[1]}px)">${shortName(p.name)}</div>`,
          iconSize: [0, 0],
        }),
      });
      oblastLabels[p.name] = m;
      m.addTo(layerLabels);
    }
  }

  function restyleOblasts() {
    restyleRaions();
    for (const f of S.geo.features) {
      const lyr = oblastPaths[f.properties.name];
      if (lyr) {
        const st = oblastStyle(f);
        lyr.setStyle(st);
        setPathClass(lyr, st.className);
      }
      const lbl = oblastLabels[f.properties.name];
      if (lbl && lbl._icon) {
        const r = S.regions.find((x) => x.name === f.properties.name);
        const d = lbl._icon.querySelector('.oblast-label');
        if (d) d.classList.toggle('on', !!(r && r.alert && !r.permanent && S.layers.alerts));
      }
    }
  }

  /* ── лінія фронту ── */

  function renderFrontline(fc) {
    layerFront.clearLayers();
    if (!fc || !fc.features) return;
    L.geoJSON(fc, {
      pane: 'front',
      style: { color: '#ff5470', weight: 1.7, opacity: 0.95, fillColor: '#7d1533', fillOpacity: 0.4, interactive: false },
    }).addTo(layerFront);
  }

  /*
   * Шар «вектори загроз» прибрано свідомо. Це була геометрична
   * здогадка з часів, коли реальних доповідей ще не було: він малював
   * «Балістику 50%» над Києвом лише тому, що там тривога, а поруч є
   * відомий район пуску. Поряд із реальними треками така вигадка
   * шкодить — її неможливо відрізнити від факту.
   */

  /* ── міста, АЕС, зони пуску ── */

  function renderCities() {
    layerCities.clearLayers();
    for (const c of S.cities) {
      const size = c.r === 1 ? 7 : c.r === 2 ? 5 : c.r === 3 ? 3.5 : 2.5;
      const dot = L.marker(c.ll, {
        icon: L.divIcon({
          className: '',
          html: `<div class="city-dot${c.occ ? ' occ' : ''}" style="width:${size}px;height:${size}px"></div>`,
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        }),
      });
      dot.bindPopup(
        `<div class="pp-title">${c.n}</div>
         <div class="pp-row"><span>населення</span><b>${fmtPop(c.pop)}</b></div>
         <div class="pp-row"><span>область</span><b>${shortName(c.obl || c.region || '—')}</b></div>
         <div class="pp-row"><span>стан</span><b style="color:${c.alert ? '#ff2d55' : '#00e5a0'}">${c.alert ? 'ТРИВОГА' : 'відбій'}</b></div>
         ${c.occ ? '<div class="pp-note">Тимчасово окупована територія.</div>' : ''}
         <button class="pp-watch" data-city="${c.n}">Стежити за містом</button>`
      );
      dot.on('popupopen', (e) => {
        const btn = e.popup.getElement().querySelector('.pp-watch');
        if (btn) btn.addEventListener('click', () => { setWatch(c); dot.closePopup(); });
      });
      dot.addTo(layerCities);

      // підпис показуємо залежно від рангу й зуму — CSS вирішує, які
      L.marker(c.ll, {
        interactive: false,
        icon: L.divIcon({ className: '', html: `<div class="city-label r${c.r}">${c.n}</div>`, iconSize: [0, 0] }),
      }).addTo(layerCities);
    }
  }

  function renderNpp() {
    layerNpp.clearLayers();
    for (const n of CFG.NPP) {
      L.marker(n.ll, {
        icon: L.divIcon({
          className: '',
          html: `<div class="npp-marker"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="12" cy="12" r="2.6"/><path d="M12 2a10 10 0 0 1 8.66 5l-5.2 3a4 4 0 0 0-3.46-2V2zM3.34 17a10 10 0 0 1 0-10l5.2 3a4 4 0 0 0 0 4l-5.2 3zM20.66 17A10 10 0 0 1 12 22v-6a4 4 0 0 0 3.46-2l5.2 3z"/></svg></div>`,
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        }),
      })
        .bindPopup(`<div class="pp-title">${n.n}</div>${n.note ? `<div class="pp-note">${n.note}</div>` : ''}`)
        .addTo(layerNpp);
    }
  }

  function renderOrigins() {
    layerOrigins.clearLayers();
    for (const o of CFG.ORIGINS) {
      const types = o.types.map((t) => CFG.THREATS[t].label).join(', ');
      L.marker(o.ll, {
        icon: L.divIcon({ className: '', html: '<div class="origin-marker"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
      })
        .bindPopup(
          `<div class="pp-title">${o.name}</div>
           <div class="pp-row"><span>типові засоби</span><b>${types}</b></div>
           <div class="pp-note">Відомий напрямок пуску за публічними зведеннями Повітряних сил.${o.far ? ' Далеко за межами мапи — вектори від цієї зони малюються від кордону по істинному азимуту.' : ''}</div>`
        )
        .addTo(layerOrigins);
    }
  }

  /* ═══════════════ симуляція ═══════════════ */

  let rafId = null;

  function simTargets() {
    return CFG.CITIES.filter((c) => !c.occ && c.r <= 2);
  }

  function startSim(intensity) {
    const n = TE.startSim(simTargets(), intensity);
    banner(`СИМУЛЯЦІЯ · ${n} цілей · дані тривог не змінюються`, true);
    $('#simStop').classList.remove('hidden');
    document.querySelectorAll('[data-sim]').forEach((b) => b.classList.toggle('active', b.dataset.sim === intensity));
    if (!rafId) rafId = requestAnimationFrame(simLoop);
  }

  function stopSim() {
    TE.stopSim();
    for (const id of Object.keys(trackViews)) {
      layerTracks.removeLayer(trackViews[id].marker);
      layerTracks.removeLayer(trackViews[id].trail);
      delete trackViews[id];
    }
    cancelAnimationFrame(rafId);
    rafId = null;
    $('#simStop').classList.add('hidden');
    document.querySelectorAll('[data-sim]').forEach((b) => b.classList.remove('active'));
    banner(null);
  }

  function simLoop() {
    const { tracks, events } = TE.tickSim(simTargets());

    for (const t of tracks) {
      let v = trackViews[t.id];
      if (!v) {
        const marker = L.marker(t.pos, {
          icon: L.divIcon({
            className: '',
            html: `<div class="track-icon" style="color:${t.def.color}">${threatIcon(t.def, 16)}</div>`,
            iconSize: [16, 16],
            iconAnchor: [8, 8],
          }),
          keyboard: false,
        }).addTo(layerTracks);
        const trail = L.polyline(t.trail, {
          color: t.def.color,
          weight: 1.4,
          opacity: 0.5,
          interactive: false,
        }).addTo(layerTracks);
        v = trackViews[t.id] = { marker, trail };
        marker.bindPopup('', { maxWidth: 250 });
      }
      v.marker.setLatLng(t.pos);
      v.trail.setLatLngs(t.trail);
      const icon = v.marker._icon && v.marker._icon.querySelector('.track-icon');
      if (icon && t.state === 'inbound') {
        icon.style.transform = `rotate(${TE.bearing(t.start, t.target) - 90}deg)`;
      }
      if (v.marker.isPopupOpen()) {
        v.marker.setPopupContent(
          `<div class="pp-title" style="color:${t.def.color}">${t.def.label} <span class="badge" style="color:#a855f7">SIM</span></div>
           <div class="pp-row"><span>ціль</span><b>${t.targetName}</b></div>
           <div class="pp-row"><span>залишок</span><b>${t.remainKm} км</b></div>
           <div class="pp-row"><span>підліт</span><b>${fmtEta(t.etaMin)}</b></div>
           <div class="pp-row"><span>швидкість</span><b>${Math.round(t.speed)} км/год</b></div>`
        );
      }
    }

    for (const ev of events) {
      const t = ev.track;
      const v = trackViews[t.id];
      if (v && v.marker._icon) {
        const icon = v.marker._icon.querySelector('.track-icon');
        if (icon) icon.classList.add(ev.kind === 'arrived' ? 'hit' : 'kill');
      }
      if (ev.kind === 'arrived') {
        const ring = L.marker(t.target, {
          interactive: false,
          icon: L.divIcon({ className: '', html: '<div class="impact-ring" style="width:60px;height:60px"></div>', iconSize: [60, 60], iconAnchor: [30, 30] }),
        }).addTo(layerTracks);
        setTimeout(() => layerTracks.removeLayer(ring), 1500);
      }
      S.simEvents.unshift({
        at: Date.now(),
        sim: true,
        kind: ev.kind,
        text: ev.kind === 'arrived' ? `${t.def.label} — влучання по ${t.targetName}` : `${t.def.label} — збито (${t.targetName})`,
      });
      if (S.simEvents.length > 60) S.simEvents.length = 60;
      setTimeout(() => {
        const vv = trackViews[t.id];
        if (vv) {
          layerTracks.removeLayer(vv.marker);
          layerTracks.removeLayer(vv.trail);
          delete trackViews[t.id];
        }
      }, 900);
    }

    // прибираємо views без треків
    const live = new Set(tracks.map((t) => String(t.id)));
    for (const id of Object.keys(trackViews)) {
      if (!live.has(id)) {
        layerTracks.removeLayer(trackViews[id].marker);
        layerTracks.removeLayer(trackViews[id].trail);
        delete trackViews[id];
      }
    }

    if (events.length) renderEventList();
    if (TE.simOn) rafId = requestAnimationFrame(simLoop);
    else rafId = null;
  }






  /* ═══════════════ треки з сервера ═══════════════ */

  /**
   * Сервер зшиває доповіді в траєкторії й віддає вже готовий трек із
   * курсом і швидкістю. Клієнту лишається вести його між оновленнями,
   * щоб позначка рухалась, а не смикалась раз на кілька секунд.
   */
  function projectTrack(t, now) {
    const d = CFG.THREATS[t.type] || CFG.THREATS.unknown;
    const since = Math.max(0, now - (t.posAt || t.lastAt));
    const leadKm = t.bearing != null ? (t.speed * since) / 3_600_000 : 0;
    const pos = leadKm > 0.3 ? TE.destination(t.pos, t.bearing, leadKm) : t.pos;

    const etaMin = t.etaMin == null ? null : Math.max(0, t.etaMin - since / 60_000);

    return {
      c: {
        id: t.id,
        type: t.type,
        count: t.count,
        at: t.lastAt,
        lastSeen: t.lastAt,
        confirms: t.reports,
        sources: t.sources,
        text: t.text,
        link: t.link,
        action: t.action,
        oblast: t.oblast,
        to: t.target ? { n: t.target } : null,
      },
      def: d,
      kind: t.action === 'launch' || t.action === 'takeoff' ? 'launch' : t.action === 'impact' ? 'impact' : 'track',
      ageMin: t.ageMin + since / 60_000,
      pos,
      heading: t.bearing,
      speed: t.speed,
      speedMeasured: t.speedMeasured,
      etaMin,
      remainKm: t.remainKm,
      uncertaintyKm: t.uncertaintyKm + leadKm * 0.35,
      target: t.target,
      origin: t.place,
      nextCity: t.nextCity,
      nextCityLL: t.nextCityLL,
      moving: t.moving,
      legs: t.legs,
      trajectory: t.trajectory,
      // рубіж досяжності для подій пуску
      reachKm: t.action === 'launch' || t.action === 'takeoff'
        ? Math.min((d.speed * (now - t.firstAt)) / 3_600_000, d.range)
        : null,
      maxRangeKm: d.range,
      label: t.site || t.place || t.target || '—',
    };
  }

  /* ═══════════════ зовнішні агрегатори ═══════════════ */

  /**
   * NEPTUN і RadarUA зводять ті самі відкриті канали, але зі своєю
   * кореляцією. Беремо їх як окремі джерела: рівні по районах від NEPTUN
   * точніші за наш висновок по області, а треки RadarUA спираються на
   * ширший набір каналів.
   */

  /** Трек чужого агрегатора → той самий стан, що й наші контакти. */
  function projectExternal(t, now) {
    const d = CFG.THREATS[t.type] || CFG.THREATS.unknown;
    const ageMs = Math.max(0, now - t.at);
    const speed = t.speed || d.speed;
    const travelledKm = (speed * ageMs) / 3_600_000;

    // від останньої доповіді ведемо числення шляху їхнім же курсом
    const pos = t.bearing != null && travelledKm > 0.5
      ? TE.destination(t.ll, t.bearing, travelledKm)
      : t.ll;

    return {
      c: {
        id: t.id,
        type: t.type,
        count: t.count,
        at: t.at,
        lastSeen: t.at,
        confirms: t.sources.length || 1,
        sources: t.sources.length ? t.sources : ['RadarUA'],
        text: `${d.label}${t.count > 1 ? ' ×' + t.count : ''}${t.place ? ' — ' + t.place : ''}`,
        link: 'https://radarua.com/',
        action: 'course',
        to: null,
        from: null,
        oblast: t.region ? t.region + ' область' : null,
        external: 'RadarUA',
      },
      def: d,
      kind: 'track',
      ageMin: ageMs / 60_000,
      pos,
      heading: t.bearing,
      uncertaintyKm: t.uncertaintyKm,
      target: t.place,
      observed: t.observed,
      confidence: t.confidence,
      external: 'RadarUA',
      trajectory: t.trajectory,
    };
  }

  /**
   * Одну ціль бачать і наш парсер, і чужий агрегатор. Лишаємо ту версію,
   * за якою стоїть більше джерел, а списки джерел зливаємо.
   */
  function mergeExternal(mine, ext) {
    const out = mine.slice();
    for (const e of ext) {
      const dup = out.find((o) => o.c.type === e.c.type && TE.distKm(o.pos, e.pos) < 12);
      if (!dup) {
        out.push(e);
        continue;
      }
      const merged = new Set([...(dup.c.sources || []), ...(e.c.sources || [])]);
      const winner = (e.c.confirms || 1) > (dup.c.confirms || 1) ? e : dup;
      if (winner !== dup) {
        out[out.indexOf(dup)] = e;
        e.c.sources = [...merged];
        e.c.confirms = merged.size;
        e.alsoMine = true;
      } else {
        dup.c.sources = [...merged];
        dup.c.confirms = merged.size;
        dup.alsoExternal = e.external;
      }
    }
    return out;
  }

  /** Рівень тривоги по кожному району від NEPTUN. */
  function externalRaionLevels() {
    const map = new Map();
    for (const r of S.ext.raionLevels || []) {
      map.set(rkey(r.oblast, r.name), r);
    }
    return map;
  }

  /* ═══════════════ райони ═══════════════ */

  const raionLayers = new Map(); // «область|район» -> leaflet layer

  /** Апостроф у джерелах різний: Куп'янський / Купʼянський. */
  const rkey = (obl, name) => (obl || '') + '|' + String(name).replace(/['’ʼ`]/g, "'").toLowerCase();

  function buildRaionLayer(fc) {
    layerRaions = L.geoJSON(fc, {
      pane: 'raion',
      style: () => ({ pane: 'raion', color: '#22303f', weight: 0.5, opacity: 0.55, fill: true, fillColor: '#000', fillOpacity: 0, interactive: false }),
      onEachFeature: (f, lyr) => {
        raionLayers.set(rkey(f.properties.oblast, f.properties.name), lyr);
      },
    });
    if (S.layers.raions) layerRaions.addTo(map);
  }

  /**
   * Офіційне API дає стан кожного району окремо. Якщо тривога оголошена
   * по всій області — фарбуємо область; якщо лише в частині районів —
   * фарбуємо саме їх, а не всю область.
   */
  function restyleRaions() {
    S.raionPainted = new Set();
    if (!layerRaions) return;
    const on = S.layers.raions && S.layers.alerts;

    // скидаємо всі в нейтральний стан
    for (const lyr of raionLayers.values()) {
      lyr.setStyle({ color: '#22303f', weight: 0.5, opacity: on ? 0.5 : 0, fillOpacity: 0 });
      setPathClass(lyr, '');
    }
    if (!on) return;

    const extLevels = externalRaionLevels();

    for (const r of S.regions) {
      if (r.permanent) continue;
      const oblLevel = S.levels[r.name];

      for (const d of r.districts) {
        const key = rkey(r.name, d.name);
        const ext = extLevels.get(key);
        if (!d.alert && !ext) continue;
        const lyr = raionLayers.get(key);
        if (!lyr) continue;

        // рівень саме цього району, якщо він відомий; інакше — по області
        const level = ext ? ext.level : oblLevel ? oblLevel.level : 'alert';
        const col = LEVELS[level].color;
        lyr.setStyle({
          color: col,
          weight: 1,
          opacity: 0.7,
          fillColor: `url(#hatch-${level})`,
          fillOpacity: (map ? map.getZoom() : 6) >= 9.5 ? 0.45 : 0.9,
        });
        setPathClass(lyr, 'raion-on raion-' + level);
        S.raionPainted.add(r.name);
      }
    }
  }

  /** Скільки районів країни зараз у тривозі. */
  function districtsInAlert() {
    let n = 0;
    for (const r of S.regions) {
      if (r.permanent) continue;
      for (const d of r.districts) if (d.alert) n++;
    }
    return n;
  }




  /* ═══════════════ стеження за своїм містом ═══════════════ */

  /**
   * Мапу треба дивитись. Куди корисніше, коли вона сама каже: «на вас
   * іде ціль, 6 хвилин». Місто обирається кліком і памʼятається між
   * сеансами.
   */
  const WATCH_CONE = 35;   // півкут, у якому ціль вважається «на нас»
  const WATCH_CROSS = 45;  // допустиме бокове відхилення, км
  const WATCH_ETA = 45;    // далі за це не турбуємо, хв

  let watchRing = null;
  let watchLastAlarm = 0;

  function loadWatch() {
    try {
      const raw = localStorage.getItem('ua-radar:watch');
      if (raw) S.watch = JSON.parse(raw);
    } catch { /* приватний режим */ }
  }

  function setWatch(city) {
    S.watch = city ? { n: city.n, ll: city.ll } : null;
    try {
      if (S.watch) localStorage.setItem('ua-radar:watch', JSON.stringify(S.watch));
      else localStorage.removeItem('ua-radar:watch');
    } catch { /* приватний режим */ }
    renderWatch();
    renderWatchBar();
  }

  /** Найближча загроза для міста, за яким стежимо. */
  function watchThreat() {
    if (!S.watch) return null;
    let best = null;
    for (const st of S.contactStates) {
      if (st.kind === 'impact' || st.heading == null) continue;
      const d = TE.distKm(st.pos, S.watch.ll);
      if (d > 600) continue;
      const brgTo = TE.bearing(st.pos, S.watch.ll);
      const off = Math.abs((((brgTo - st.heading) % 360) + 540) % 360 - 180);
      if (off > WATCH_CONE) continue;
      // бокове відхилення: наскільки ціль пройде повз
      const cross = d * Math.sin((off * Math.PI) / 180);
      if (cross > WATCH_CROSS) continue;
      const speed = st.speed || st.def.speed;
      const eta = (d / speed) * 60;
      if (eta > WATCH_ETA) continue;
      if (!best || eta < best.eta) best = { eta, distKm: d, crossKm: cross, st };
    }
    return best;
  }

  function renderWatch() {
    if (watchRing) {
      layerCities.removeLayer(watchRing);
      watchRing = null;
    }
    if (!S.watch) return;
    watchRing = L.marker(S.watch.ll, {
      interactive: false,
      icon: L.divIcon({ className: '', html: '<div class="watch-ring"></div>', iconSize: [26, 26], iconAnchor: [13, 13] }),
    }).addTo(layerCities);
  }

  function renderWatchBar() {
    const bar = $('#watchBar');
    if (!bar) return;
    if (!S.watch) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    const th = watchThreat();

    if (!th) {
      bar.className = 'watch-bar calm';
      bar.innerHTML = `<b>${S.watch.n}</b><span>загроз не видно</span><button class="watch-off" title="Не стежити">×</button>`;
    } else {
      const d = th.st.def;
      bar.className = 'watch-bar alarm';
      bar.innerHTML =
        `<b>${S.watch.n}</b>` +
        `<span style="color:${d.color}">${d.label}${th.st.c.count > 1 ? ' ×' + th.st.c.count : ''}</span>` +
        `<u>${fmtEta(th.eta)}</u><i>${Math.round(th.distKm)} км</i>` +
        `<button class="watch-off" title="Не стежити">×</button>`;

      // сирена не частіше ніж раз на дві хвилини
      if (S.sound && now() - watchLastAlarm > 120_000) {
        watchLastAlarm = now();
        siren('on');
      }
    }
    const off = bar.querySelector('.watch-off');
    if (off) off.addEventListener('click', () => setWatch(null));
  }

  /* ═══════════════ збиття ═══════════════ */

  const interceptViews = new Map();

  /**
   * Збиття — окрема подія: канал доповів, що ціль знищено. Позначка
   * живе 20 хвилин і згасає, щоб було видно, де сьогодні працювала ППО.
   */
  function renderIntercepts() {
    if (!layerContacts) return;
    const alive = new Set();
    const t = now();

    for (const x of S.intercepts || []) {
      alive.add(x.id);
      const d = CFG.THREATS[x.type] || CFG.THREATS.unknown;
      const ageMin = (t - x.at) / 60_000;
      const op = Math.max(0.25, 1 - ageMin / 20);

      let v = interceptViews.get(x.id);
      if (!v) {
        v = L.marker(x.ll, {
          icon: L.divIcon({
            className: '',
            html: `<div class="ix-mark"><i></i><b>✕</b>${x.count > 1 ? `<u>${x.count}</u>` : ''}</div>`,
            iconSize: [22, 22],
            iconAnchor: [11, 11],
          }),
          keyboard: false,
        }).addTo(layerContacts);
        v.bindPopup(
          `<div class="pp-title" style="color:#00e5a0">Збито · ${d.label}${x.count > 1 ? ' ×' + x.count : ''}</div>
           <div class="pp-row"><span>місце</span><b>${x.place || x.oblast || '—'}</b></div>
           <div class="pp-row"><span>час</span><b>${fmtTime(x.at)}</b></div>
           <div class="pp-quote">«${x.text}»</div>
           <div class="pp-note">${(x.sources || []).join(', ')} · <a href="${x.link}" target="_blank" rel="noopener">повідомлення</a></div>`,
          { maxWidth: 280 }
        );
        interceptViews.set(x.id, v);
      }
      if (v._icon) v._icon.style.opacity = String(op);
    }

    for (const [id, v] of interceptViews) {
      if (alive.has(id)) continue;
      layerContacts.removeLayer(v);
      interceptViews.delete(id);
    }
  }

  /* ═══════════════ розклеювання підписів ═══════════════ */

  let declutterTimer = null;

  /**
   * Підписи міст накладаються одне на одне — найгірше довкола Києва.
   * Йдемо від найбільших до найменших і ховаємо ті, що не вміщаються:
   * краще менше назв, ніж нечитабельна каша.
   */
  function declutterLabels() {
    if (!map || !S.layers.labels) return;
    const size = map.getSize();
    const boxes = [];
    const nodes = [];

    // спершу підписи областей — вони важливіші за дрібні міста
    for (const name of Object.keys(oblastLabels)) {
      const m = oblastLabels[name];
      if (!m || !m._icon) continue;
      const el2 = m._icon.querySelector('.oblast-label');
      if (!el2 || getComputedStyle(el2).opacity === '0') continue;
      nodes.push({ el: el2, pri: 0, ll: m.getLatLng() });
    }

    layerCities.eachLayer((l) => {
      if (!l._icon) return;
      const el2 = l._icon.querySelector('.city-label');
      if (!el2) return;
      if (getComputedStyle(el2).display === 'none') return;
      const rank = el2.classList.contains('r1') ? 1 : el2.classList.contains('r2') ? 2 : el2.classList.contains('r3') ? 3 : 4;
      nodes.push({ el: el2, pri: rank, ll: l.getLatLng() });
    });

    nodes.sort((a, b) => a.pri - b.pri);

    for (const n of nodes) {
      n.el.classList.remove('crowded');
      const p = map.latLngToContainerPoint(n.ll);
      if (p.x < -60 || p.y < -20 || p.x > size.x + 60 || p.y > size.y + 20) continue;

      // ширину оцінюємо за довжиною тексту — міряти кожен вузол дорого
      const w = n.el.textContent.length * 5.4 + 12;
      const h = 13;
      const box = { x1: p.x - 2, y1: p.y - h / 2, x2: p.x + w, y2: p.y + h / 2 };

      let clash = false;
      for (const b of boxes) {
        if (box.x1 < b.x2 && box.x2 > b.x1 && box.y1 < b.y2 && box.y2 > b.y1) { clash = true; break; }
      }
      if (clash) n.el.classList.add('crowded');
      else boxes.push(box);
    }
  }

  function scheduleDeclutter() {
    clearTimeout(declutterTimer);
    declutterTimer = setTimeout(declutterLabels, 120);
  }

  /* ═══════════════ штрихування зон тривоги ═══════════════ */

  /**
   * Суцільна заливка ховає під собою місцевість: на зумі виходить
   * рівна пляма, на якій не видно ні міст, ні меж. Діагональна
   * штриховка читається як «зона», але лишає карту прозорою.
   *
   * Патерни оголошуємо один раз у прихованому SVG: посилання
   * fill="url(#id)" резолвиться по всьому документу.
   */
  const HATCH = { red: '#ff2d55', yellow: '#ff9d00', alert: '#ff5470' };

  function injectPatterns() {
    if (document.getElementById('ua-defs')) return;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('id', 'ua-defs');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.cssText = 'position:absolute;pointer-events:none';
    const defs = document.createElementNS(ns, 'defs');

    for (const [key, color] of Object.entries(HATCH)) {
      // щільна штриховка під кутом 45°
      const pat = document.createElementNS(ns, 'pattern');
      pat.setAttribute('id', 'hatch-' + key);
      pat.setAttribute('width', '7');
      pat.setAttribute('height', '7');
      pat.setAttribute('patternUnits', 'userSpaceOnUse');
      pat.setAttribute('patternTransform', 'rotate(45)');

      const bg = document.createElementNS(ns, 'rect');
      bg.setAttribute('width', '7');
      bg.setAttribute('height', '7');
      bg.setAttribute('fill', color);
      bg.setAttribute('fill-opacity', '0.13');
      pat.appendChild(bg);

      const ln = document.createElementNS(ns, 'line');
      ln.setAttribute('x1', '0');
      ln.setAttribute('y1', '0');
      ln.setAttribute('x2', '0');
      ln.setAttribute('y2', '7');
      ln.setAttribute('stroke', color);
      ln.setAttribute('stroke-width', '2.6');
      ln.setAttribute('stroke-opacity', '0.5');
      pat.appendChild(ln);

      defs.appendChild(pat);
    }

    // мʼяке світіння для меж областей у тривозі
    const f = document.createElementNS(ns, 'filter');
    f.setAttribute('id', 'edge-glow');
    f.setAttribute('x', '-30%');
    f.setAttribute('y', '-30%');
    f.setAttribute('width', '160%');
    f.setAttribute('height', '160%');
    const blur = document.createElementNS(ns, 'feGaussianBlur');
    blur.setAttribute('stdDeviation', '2.5');
    blur.setAttribute('result', 'b');
    const merge = document.createElementNS(ns, 'feMerge');
    for (const src of ['b', 'SourceGraphic']) {
      const n = document.createElementNS(ns, 'feMergeNode');
      n.setAttribute('in', src);
      merge.appendChild(n);
    }
    f.appendChild(blur);
    f.appendChild(merge);
    defs.appendChild(f);

    svg.appendChild(defs);
    document.body.appendChild(svg);
  }

  /* ═══════════════ рівні тривоги ═══════════════ */

  /**
   * Канали оповіщення розрізняють два рівні: жовтий — загроза БпЛА,
   * червоний — ракетна небезпека. Це важливіше за сам факт тривоги:
   * від «Шахеда» є десятки хвилин, від балістики — одиниці.
   */
  const LEVELS = {
    red: { label: 'Червоний', short: 'ракетна небезпека', color: '#ff2d55', rank: 3 },
    yellow: { label: 'Жовтий', short: 'загроза БпЛА', color: '#ff9d00', rank: 2 },
    alert: { label: 'Тривога', short: 'тип загрози не вказано', color: '#ff5470', rank: 1 },
    calm: { label: 'Відбій', short: '', color: '#00e5a0', rank: 0 },
  };

  /** Класи, які означають ракетну небезпеку. */
  const MISSILE_TYPES = new Set(['ballistic', 'aeroballistic', 'cruise_air', 'cruise_sea', 'cruise_ground', 'kh22', 'missile']);

  /**
   * Зводить рівень по кожній області: з явних позначок каналів
   * (🔴/🟡) і з класу цілей, які зараз у повітрі над областю.
   * @returns {Object} назва області -> { level, rank, type, at, reason }
   */
  function computeLevels() {
    const out = {};
    const put = (obl, level, reason, at, type) => {
      if (!obl) return;
      const rank = LEVELS[level].rank;
      const cur = out[obl];
      if (cur && cur.rank >= rank) return;
      out[obl] = { level, rank, reason, at, type };
    };

    // 1) сам факт тривоги з офіційного API
    for (const r of S.regions) {
      if (r.alert && !r.permanent) put(r.name, 'alert', 'повітряна тривога', r.since, null);
    }

    // 2) уточнення з доповідей каналів
    for (const st of S.contactStates) {
      const c = st.c;
      const obl = (c.to && c.to.obl) || (c.from && c.from.obl) || c.oblast;
      if (!obl) continue;
      if (c.level === 'clear') continue;

      let level = c.level;
      if (!level) level = MISSILE_TYPES.has(c.type) ? 'red' : 'yellow';
      // клас цілі сильніший за кольорову позначку каналу
      if (MISSILE_TYPES.has(c.type)) level = 'red';

      put(obl, level, st.def.label, c.at, c.type);
    }

    return out;
  }

  function levelOf(name) {
    return S.levels[name] || null;
  }

  /* ═══════════════ контакти моніторингу ═══════════════ */

  const contactViews = new Map(); // id -> { marker, ring, line }

  function ageLabel(min) {
    if (min < 1) return 'щойно';
    if (min < 60) return Math.round(min) + ' хв тому';
    return Math.round(min / 60) + ' год тому';
  }

  /** Свіжа доповідь — яскрава, стара — приглушена. */
  function freshness(min) {
    return Math.max(0.25, 1 - min / 25);
  }

  function contactPopup(st) {
    const c = st.c;
    const d = st.def;
    const rows = [];
    if (st.kind === 'launch') {
      rows.push(`<div class="pp-row"><span>подія</span><b>${c.action === 'takeoff' ? 'ЗЛІТ' : 'ПУСК'}</b></div>`);
      rows.push(`<div class="pp-row"><span>звідки</span><b>${st.label}</b></div>`);
      rows.push(`<div class="pp-row"><span>рубіж досяжності</span><b>${Math.round(st.reachKm)} км</b></div>`);
      rows.push(`<div class="pp-row"><span>макс. дальність</span><b>${st.maxRangeKm} км</b></div>`);
    } else {
      if (st.origin) rows.push(`<div class="pp-row"><span>останній орієнтир</span><b>${st.origin}</b></div>`);
      if (st.nextCity) rows.push(`<div class="pp-row"><span>по курсу</span><b>${st.nextCity}</b></div>`);
      if (st.origin) rows.push(`<div class="pp-row"><span>спостерігали</span><b>${st.origin}</b></div>`);
      if (st.remainKm != null) rows.push(`<div class="pp-row"><span>залишок</span><b>${Math.round(st.remainKm)} км</b></div>`);
      if (st.etaMin != null) rows.push(`<div class="pp-row"><span>підліт</span><b>${fmtEta(st.etaMin)}</b></div>`);
      if (st.speed) rows.push(`<div class="pp-row"><span>швидкість</span><b>${Math.round(st.speed)} км/год${st.speedMeasured ? '' : ' (паспорт)'}</b></div>`);
      if (st.heading != null) rows.push(`<div class="pp-row"><span>курс</span><b>${Math.round(st.heading)}°</b></div>`);
      if (st.legs > 1) rows.push(`<div class="pp-row"><span>точок траєкторії</span><b>${st.legs}</b></div>`);
      if (st.uncertaintyKm > 1) rows.push(`<div class="pp-row"><span>похибка</span><b>±${Math.round(st.uncertaintyKm)} км</b></div>`);
    }
    if (c.count > 1) rows.push(`<div class="pp-row"><span>кількість</span><b>${c.count}</b></div>`);
    rows.push(`<div class="pp-row"><span>доповідь</span><b>${ageLabel(st.ageMin)}</b></div>`);
    rows.push(`<div class="pp-row"><span>джерел</span><b>${c.confirms}</b></div>`);
    if (st.external) {
      rows.push(`<div class="pp-row"><span>зведення</span><b>${st.external}${st.observed === false ? ' · екстрапольовано' : ''}</b></div>`);
      if (st.confidence != null) rows.push(`<div class="pp-row"><span>певність</span><b>${Math.round(st.confidence * 100)}%</b></div>`);
    }

    return `
      <div class="pp-title" style="color:${d.color}">${d.label}${c.count > 1 ? ' ×' + c.count : ''}</div>
      ${rows.join('')}
      <div class="pp-quote">«${c.text}»</div>
      <div class="pp-note">${c.sources.join(', ')} · <a href="${c.link}" target="_blank" rel="noopener">повідомлення</a><br>
      <b>Положення розраховане від доповіді, це не радарний трек.</b></div>`;
  }

  function renderContacts() {
    if (!layerContacts) return;
    const t2 = now();
    // сервер уже зшив доповіді в треки; локальне числення лишилось
    // тільки для подій без траєкторії
    const states = (S.tracks || []).map((t) => projectTrack(t, t2));
    const extStates = (S.ext.tracks || []).map((t) => projectExternal(t, t2)).filter(Boolean);
    S.contactStates = mergeExternal(states, extStates);
    S.levels = computeLevels();

    if (!S.layers.contacts) {
      layerContacts.clearLayers();
      layerReach.clearLayers();
      contactViews.clear();
      return;
    }

    const alive = new Set();

    for (const st of states) {
      const c = st.c;
      alive.add(c.id);
      const d = st.def;
      const op = freshness(st.ageMin);
      let v = contactViews.get(c.id);

      if (!v) {
        v = {};
        v.marker = L.marker(st.pos, {
          icon: L.divIcon({ className: '', html: '', iconSize: [20, 20], iconAnchor: [10, 10] }),
          keyboard: false,
          riseOnHover: true,
        }).addTo(layerContacts);
        v.marker.bindPopup('', { maxWidth: 300 });
        v.marker.on('click', () => v.marker.setPopupContent(contactPopup(st)));
        // рубіж досяжності після пуску малюємо, а кола похибки навколо
        // кожної цілі — ні: на мапі з сотнею контактів вони все закривають.
        // Похибка лишається числом у картці цілі.
        if (st.kind === 'launch') {
          v.ring = L.circle(st.pos, { radius: 1, color: d.color, weight: 2, opacity: 0.8, dashArray: '6 6', fillOpacity: 0.04, interactive: false }).addTo(layerContacts);
        }
        contactViews.set(c.id, v);
      }

      v.marker.setLatLng(st.pos);
      const rot = st.heading != null ? st.heading - 90 : 0;
      const cnt = c.count > 1 ? `<b class="tk-count">${c.count}</b>` : '';
      const cls = st.kind === 'impact' ? ' impact' : st.kind === 'launch' ? ' launch' : '';
      // свіжа доповідь пульсує: одразу видно, що це не стара позначка
      const fresh = st.ageMin < 1.5 ? ' fresh' : '';
      if (v.marker._icon) {
        v.marker._icon.innerHTML =
          `<div class="ct-icon${cls}${fresh}" style="color:${d.color};opacity:${op}">` +
          `<i class="ct-halo"></i>` +
          `<div class="ct-rot" style="transform:rotate(${rot}deg)">${threatIcon(d, 18)}</div>${cnt}</div>`;
      }

      if (v.ring) {
        v.ring.setLatLng(st.pos);
        v.ring.setRadius(Math.max(st.reachKm, 5) * 1000);
      }

      // пройдений шлях: точки доповідей, зшиті в ланцюг
      if (st.trajectory && st.trajectory.length > 1) {
        const pts = st.trajectory.concat([st.pos]);
        if (!v.trail) {
          v.trail = L.polyline(pts, {
            color: d.color, weight: 2, opacity: 0.5,
            lineCap: 'round', lineJoin: 'round', className: 'ct-trail', interactive: false,
          }).addTo(layerContacts);
        }
        v.trail.setLatLngs(pts);
        v.trail.setStyle({ opacity: 0.55 * op });
      } else if (v.trail) {
        layerContacts.removeLayer(v.trail);
        v.trail = null;
      }

      // лінія до цілі, поки ціль ще не дійшла
      if (st.kind === 'track' && st.remainKm > 1 && c.to) {
        const tgt = c.to.ll || (st.trajectory && st.trajectory[st.trajectory.length - 1]);
        if (tgt) {
          if (!v.line) {
            v.line = L.polyline([st.pos, tgt], { color: d.color, weight: 1.2, opacity: 0.5, dashArray: '4 6', interactive: false }).addTo(layerContacts);
          }
          v.line.setLatLngs([st.pos, tgt]);
          v.line.setStyle({ opacity: 0.5 * op });
        }
      } else if (v.line) {
        layerContacts.removeLayer(v.line);
        v.line = null;
      }

      if (v.marker.isPopupOpen()) v.marker.setPopupContent(contactPopup(st));
    }

    for (const [id, v] of contactViews) {
      if (alive.has(id)) continue;
      layerContacts.removeLayer(v.marker);
      if (v.ring) layerContacts.removeLayer(v.ring);
      if (v.line) layerContacts.removeLayer(v.line);
      if (v.trail) layerContacts.removeLayer(v.trail);
      contactViews.delete(id);
    }
  }

  /* ── список цілей ── */

  function renderTargetList() {
    const box = $('#targetList');
    if (!box) return;
    const states = S.contactStates.slice();

    const badge = $('#badgeTargets');
    const inbound = states.filter((s) => s.kind === 'track' || s.kind === 'inbound' || s.kind === 'launch');
    if (badge) {
      badge.textContent = inbound.length ? String(inbound.length) : '';
      badge.classList.toggle('on', inbound.length > 0);
    }

    box.innerHTML = '';
    if (!states.length) {
      box.appendChild(
        el('div', 'empty', S.monitorTs
          ? 'Активних цілей у доповідях немає.<br>Канали моніторингу мовчать — це добра новина.'
          : 'Очікування даних моніторингу…')
      );
      return;
    }

    // пуски й зльоти — нагору, далі за часом підльоту
    const rank = (s) => (s.kind === 'launch' ? 0 : s.kind === 'impact' ? 3 : 1);
    states.sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      const ea = a.etaMin == null ? 999 : a.etaMin;
      const eb = b.etaMin == null ? 999 : b.etaMin;
      if (ea !== eb) return ea - eb;
      return a.ageMin - b.ageMin;
    });

    for (const st of states) {
      const c = st.c;
      const item = el('div', 't-item' + (st.kind === 'launch' ? ' launch' : ''));
      const head = el('div', 't-head');
      head.appendChild(el('span', 't-ico', threatIcon(st.def, 16)));
      const ty = el('span', 't-type', st.def.label + (c.count > 1 ? ' ×' + c.count : ''));
      ty.style.color = st.def.color;
      head.appendChild(ty);
      if (st.external) {
        const ex = el('span', 'badge ext-badge', st.external);
        head.appendChild(ex);
      }
      head.appendChild(el('span', 't-conf', ageLabel(st.ageMin)));
      item.appendChild(head);

      const where =
        st.kind === 'launch' ? `${c.action === 'takeoff' ? 'ЗЛІТ' : 'ПУСК'} · ${st.label}`
        : st.kind === 'impact' ? `влучання · ${st.origin || c.oblast || ''}`
        : st.nextCity ? `${st.origin || '?'} → ${st.nextCity}`
        : st.origin ? 'район ' + st.origin
        : c.oblast || '';
      const w = el('div', 't-region', where);
      if (st.nextCity) w.classList.add('has-next');
      item.appendChild(w);

      const meta = el('div', 't-meta');
      const bits = [];
      if (st.etaMin != null) bits.push(`<b>${fmtEta(st.etaMin)}</b>`);
      if (st.remainKm != null) bits.push(`${Math.round(st.remainKm)} км`);
      if (st.speed && st.moving) bits.push(`${Math.round(st.speed)} км/год`);
      if (st.kind === 'launch') bits.push(`рубіж <b>${Math.round(st.reachKm)} км</b>`);
      if (c.confirms > 1) bits.push(`${c.confirms} джерел`);
      if (st.uncertaintyKm > 3) bits.push(`±${Math.round(st.uncertaintyKm)} км`);
      meta.innerHTML = bits.map((b) => `<span>${b}</span>`).join('');
      item.appendChild(meta);

      item.addEventListener('click', () => {
        map.flyTo(st.pos, st.kind === 'launch' ? 6 : 9, { duration: 0.6, animate: !document.hidden });
        if (st.kind === 'launch') openReachDetail(st);
      });
      box.appendChild(item);
    }
  }

  /* ── стрічка повідомлень ── */

  function renderFeed() {
    const bar = $('#srcBar');
    if (bar) {
      bar.innerHTML = '';
      const ok = S.channels.filter((c) => !c.error).length;
      bar.appendChild(el('span', 'src-count', `${ok}/${S.channels.length} каналів`));
      for (const x of S.ext.sources || []) {
        const chip = el('span', 'src-chip ext' + (x.ok ? '' : ' err'), x.name);
        chip.title = (x.ok ? `${x.gives}: ${x.count}` : 'помилка: ' + x.error) + ' · зовнішній агрегатор';
        bar.appendChild(chip);
      }
      for (const ch of S.channels) {
        const chip = el('span', 'src-chip' + (ch.error ? ' err' : '') + (ch.scope === 'kyiv' ? ' kyiv' : ''), ch.name);
        chip.title = (ch.error ? 'помилка: ' + ch.error : `повідомлень: ${ch.msgs}`) + ` · довіра ${ch.trust}/3`;
        bar.appendChild(chip);
      }
    }

    // оцінка обстановки від моделі — окремим блоком, щоб її не
    // можна було сплутати з доповідями каналів
    const ab = $('#aiBox');
    if (ab) {
      const a = S.ai && S.ai.assessment;
      if (!S.ai || !S.ai.enabled) {
        ab.hidden = true;
      } else if (!a) {
        ab.hidden = false;
        ab.innerHTML = '<div class="ai-head">Оцінка обстановки</div><div class="ai-wait">модель ще не висловилась</div>';
      } else {
        ab.hidden = false;
        const tgt = (a.targets || [])
          .map((t) => `<li><b>${t.city}</b>${t.etaMin != null ? ' · ' + fmtEta(t.etaMin) : ''}<span>${t.why || ''}</span></li>`)
          .join('');
        ab.innerHTML =
          `<div class="ai-head">Оцінка обстановки <i>${S.ai.providerName || ''}</i><span>${fmtTime(a.at)}</span></div>` +
          `<div class="ai-text">${a.text}</div>` +
          (tgt ? `<ul class="ai-targets">${tgt}</ul>` : '') +
          `<div class="ai-note">Це висновок мовної моделі з наявних доповідей, а не факт і не прогноз ППО.</div>`;
      }
    }

    const box = $('#feedList');
    if (!box) return;
    box.innerHTML = '';
    if (!S.feed.length) {
      box.appendChild(el('div', 'empty', 'Стрічка порожня.'));
      return;
    }
    for (const m of S.feed) {
      const item = el('div', 'f-item');
      const head = el('div', 'f-head');
      head.appendChild(el('span', 'f-chan', m.channelName));
      head.appendChild(el('span', 'f-time', fmtTime(m.at)));
      item.appendChild(head);
      const body = el('div', 'f-text');
      body.textContent = m.text;
      item.appendChild(body);
      item.addEventListener('click', () => window.open(m.link, '_blank', 'noopener'));
      box.appendChild(item);
    }
  }

  /* ── панель досяжності після пуску ── */

  function openReachDetail(st) {
    const rows = CT.reachTable(st.pos, st.c.type, st.c.at, now());
    const d = st.def;
    const head = `
      <div class="d-head">
        <div class="d-title" style="color:${d.color}">${st.c.action === 'takeoff' ? 'Зліт' : 'Пуск'} · ${d.label}</div>
        <div class="d-status"><b>${st.label}</b><span class="r-time">${ageLabel(st.ageMin)}</span></div>
      </div>`;

    const cells = `
      <div class="d-sec"><div class="d-grid">
        <div class="d-cell"><span>рубіж зараз</span><b>${Math.round(st.reachKm)} км</b></div>
        <div class="d-cell"><span>макс. дальність</span><b>${st.maxRangeKm} км</b></div>
        <div class="d-cell"><span>швидкість</span><b>${d.speed} км/год</b></div>
        <div class="d-cell"><span>міст у зоні</span><b>${rows.length}</b></div>
      </div></div>`;

    const list = rows.length
      ? `<div class="d-sec"><h4>Час підльоту від точки пуску</h4>
         <table class="reach">
           <thead><tr><th>місто</th><th>км</th><th>політ</th><th>лишилось</th></tr></thead>
           <tbody>${rows
             .slice(0, 26)
             .map(
               (r) => `<tr class="${r.reached ? 'passed' : ''}">
                 <td>${r.city}</td>
                 <td>${r.distanceKm}</td>
                 <td>${fmtEta(r.flightMin)}</td>
                 <td>${r.reached ? '<span class="reached">рубіж пройдено</span>' : '<b>' + fmtEta(r.leftMin) + '</b>'}</td>
               </tr>`
             )
             .join('')}</tbody>
         </table></div>`
      : '<div class="d-sec"><div class="d-note">Жодне місто з довідника не потрапляє в дальність цього класу.</div></div>';

    $('#detailBody').innerHTML =
      head +
      `<div class="d-body">${cells}${list}
        <div class="d-note" style="color:#5b6879;margin-top:10px">
          Розрахунок за прямою від точки пуску й паспортною швидкістю класу.
          Реальний маршрут ламаний і довший, ціль може бути збита. Це оцінка
          мінімального часу, а не прогноз удару.
        </div>
        <div class="pp-quote" style="margin-top:10px">«${st.c.text}»</div>
      </div>`;
    $('#panelRight').classList.remove('hidden');
    map.invalidateSize({ animate: false });
  }

  /* ── опитування монітора ── */

  async function pollMonitor() {
    try {
      const res = await fetch(api('/api/monitor'), { cache: 'no-store' });
      const data = await res.json();
      S.contacts = data.contacts || [];
      S.tracks = data.tracks || [];
      S.intercepts = data.intercepts || [];
      S.trackStats = data.trackStats || null;
      S.feed = data.messages || [];
      S.channels = data.channels || [];
      S.ext = data.external || { raionLevels: [], tracks: [], sources: [] };
      S.ai = data.ai || null;
      S.monitorTs = data.ts;
      S.monitorErr = null;
      if (data.serverNow) S.clockSkew = data.serverNow - Date.now();
      renderContacts();
      renderIntercepts();
      renderWatchBar();
      restyleOblasts();
      renderRegionList();
      renderTargetList();
      renderFeed();
      renderTop();
    } catch (e) {
      S.monitorErr = e.message;
      console.warn('монітор недоступний:', e.message);
    }
  }

  /* ═══════════════ звук ═══════════════ */

  let actx = null;

  function siren(kind) {
    if (!S.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const t0 = actx.currentTime;
      const gain = actx.createGain();
      gain.connect(actx.destination);
      gain.gain.setValueAtTime(0, t0);

      if (kind === 'off') {
        // рівний тон — відбій
        const o = actx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(620, t0);
        o.connect(gain);
        gain.gain.linearRampToValueAtTime(0.16, t0 + 0.05);
        gain.gain.setValueAtTime(0.16, t0 + 1.1);
        gain.gain.linearRampToValueAtTime(0, t0 + 1.5);
        o.start(t0);
        o.stop(t0 + 1.6);
        return;
      }

      // сирена: два підйоми частоти
      const o = actx.createOscillator();
      o.type = 'sawtooth';
      const f = o.frequency;
      f.setValueAtTime(420, t0);
      for (let i = 0; i < 2; i++) {
        const b = t0 + i * 1.5;
        f.linearRampToValueAtTime(900, b + 0.75);
        f.linearRampToValueAtTime(420, b + 1.5);
      }
      const lp = actx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1600;
      o.connect(lp);
      lp.connect(gain);
      gain.gain.linearRampToValueAtTime(0.18, t0 + 0.1);
      gain.gain.setValueAtTime(0.18, t0 + 2.7);
      gain.gain.linearRampToValueAtTime(0, t0 + 3);
      o.start(t0);
      o.stop(t0 + 3.05);
    } catch (e) {
      console.warn('звук недоступний', e);
    }
  }

  /* ═══════════════ інтерфейс ═══════════════ */

  function banner(text, isSim) {
    const b = $('#mapBanner');
    if (!text) {
      b.hidden = true;
      return;
    }
    $('#mapBannerText').textContent = text;
    b.classList.toggle('sim', !!isSim);
    b.hidden = false;
  }

  function renderTop() {
    const est = S.est || { level: 0, label: '—', activeCount: 0, vectors: [], minEta: null };
    const tl = $('#threatLevel');
    tl.dataset.level = String(est.level);
    $('#tlLabel').textContent = est.label;

    const types = Object.entries(est.byType || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k]) => CFG.THREATS[k].label)
      .join(' · ');
    $('#tlSub').textContent = est.activeCount ? types || 'уточнюється' : 'тривог немає';

    $('#kpiAlerts').firstElementChild.textContent = est.activeCount;

    let pop = 0;
    for (const r of S.regions) {
      if (!r.alert || r.permanent) continue;
      for (const c of S.cities) if (c.obl === r.name && !c.occ) pop += c.pop;
    }
    const ts = S.trackStats;
    if (ts && ts.interceptedLastHour) {
      $('#kpiPop').firstElementChild.textContent = '✕ ' + ts.interceptedLastHour;
      $('#kpiPop').lastElementChild.textContent = 'збито за годину';
      $('#kpiPop').classList.add('kill');
    } else {
      $('#kpiPop').firstElementChild.textContent = pop ? fmtPop(pop) : '—';
      $('#kpiPop').lastElementChild.textContent = 'людей у зоні';
      $('#kpiPop').classList.remove('kill');
    }

    // реальні доповіді важать більше за геометричну оцінку
    const mon = CT.summary(S.contactStates);
    const eta = mon.minEta != null ? mon.minEta : est.minEta;
    $('#kpiEta').firstElementChild.textContent = eta != null ? fmtEta(eta) : '—';

    const kAl = $('#kpiAlerts');
    if (mon.inbound) {
      kAl.firstElementChild.textContent = est.activeCount + ' / ' + mon.inbound;
      kAl.lastElementChild.textContent = 'тривоги / цілі';
    } else {
      kAl.firstElementChild.textContent = est.activeCount;
      kAl.lastElementChild.textContent = 'тривоги';
    }

    if (mon.total) {
      const names = Object.entries(mon.byType)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, n]) => (CFG.THREATS[k] || CFG.THREATS.unknown).label + ' ×' + n)
        .join(' · ');
      $('#tlSub').textContent = names;
    }

    if (TE.simOn) {
      // банер симуляції має пріоритет — його ставить startSim
    } else if (mon.launches) {
      const l = S.contactStates.find((x) => x.kind === 'launch');
      banner(`${l.c.action === 'takeoff' ? 'ЗЛІТ' : 'ПУСК'} · ${l.def.label} · ${l.label} · РУБІЖ ${Math.round(l.reachKm)} КМ`, false);
    } else {
      // банери-припущення прибрані: рівень загрози й так видно у шапці
      // та кольором областей, а червона смуга через пів екрана лише
      // заважала дивитись на мапу. Лишився тільки банер реальної події —
      // зафіксованого пуску чи зльоту.
      banner(null);
    }
  }

  function renderRegionList() {
    const q = ($('#regionSearch').value || '').trim().toLowerCase();
    const box = $('#regionList');
    box.innerHTML = '';

    // порядок: реальні тривоги (найновіші вище) → спокійні → окуповані
    const rank = (r) => {
      if (r.permanent) return 3;
      if (r.alert) return 0;
      const lv = S.levels[r.name];
      return lv && lv.rank >= 2 ? 1 : 2; // загроза без оголошеної тривоги
    };
    const rows = S.regions.slice().sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      if (rank(a) === 0) return (b.since || 0) - (a.since || 0);
      if (rank(a) === 1) return ((S.levels[b.name] || {}).rank || 0) - ((S.levels[a.name] || {}).rank || 0);
      return a.name.localeCompare(b.name, 'uk');
    });

    // пошук по містах: набрав «Бровари» — отримав місто, а не нічого
    if (q.length >= 2) {
      const hits = S.cities
        .filter((c) => c.n.toLowerCase().includes(q))
        .sort((a, b) => b.pop - a.pop)
        .slice(0, 6);
      for (const c of hits) {
        const it = el('div', 'r-item city-hit');
        it.appendChild(el('div', 'r-dot'));
        const mn = el('div', 'r-main');
        mn.appendChild(el('div', 'r-name', c.n));
        mn.appendChild(el('div', 'r-sub', shortName(c.obl || '') + ' · ' + fmtPop(c.pop)));
        it.appendChild(mn);
        it.appendChild(el('div', 'r-time', 'місто'));
        it.addEventListener('click', () => {
          map.flyTo(c.ll, 9, { duration: 0.6, animate: !document.hidden });
          setWatch(c);
        });
        box.appendChild(it);
      }
    }

    let shown = 0;
    for (const r of rows) {
      const districtHit = q && r.districts.some((d) => d.name.toLowerCase().includes(q));
      if (q && !r.name.toLowerCase().includes(q) && !districtHit) continue;
      shown++;

      const live = r.alert && !r.permanent;
      const lvDot = S.levels[r.name];
      const item = el('div', 'r-item' + (live ? ' on' : '') + (r.permanent ? ' perm' : '') + (S.selected === r.name ? ' sel' : ''));
      const dot = el('div', 'r-dot');
      if (lvDot && !r.permanent) {
        dot.style.background = LEVELS[lvDot.level].color;
        dot.style.boxShadow = '0 0 9px ' + LEVELS[lvDot.level].color;
      }
      item.appendChild(dot);

      const main = el('div', 'r-main');
      main.appendChild(el('div', 'r-name', shortName(r.name)));

      const activeD = r.districts.filter((d) => d.alert);
      const lv = S.levels[r.name];
      if (r.permanent) {
        main.appendChild(el('div', 'r-sub', 'окупована територія · тривога з ' + new Date(r.since).toLocaleDateString('uk-UA')));
      } else if (live || (lv && lv.rank >= 2)) {
        const badges = el('div', 'r-badges');

        // рівень — найважливіше, тому першим
        if (lv) {
          const L = LEVELS[lv.level];
          const b = el('span', 'badge solid', L.label.toUpperCase());
          b.style.background = L.color;
          b.title = L.short;
          badges.appendChild(b);
        }

        // класи цілей, які зараз доповідають над цією областю
        const types = new Map();
        for (const st of S.contactStates) {
          const c = st.c;
          const obl = (c.to && c.to.obl) || (c.from && c.from.obl) || c.oblast;
          if (obl !== r.name) continue;
          types.set(c.type, (types.get(c.type) || 0) + (c.count || 1));
        }
        for (const [tp, n] of [...types].sort((a, b) => b[1] - a[1]).slice(0, 2)) {
          const d = CFG.THREATS[tp] || CFG.THREATS.unknown;
          const b = el('span', 'badge', d.label + (n > 1 ? ' ×' + n : ''));
          b.style.color = d.color;
          badges.appendChild(b);
        }

        if (activeD.length) badges.appendChild(el('span', 'badge', `${activeD.length} р-н`));
        main.appendChild(badges);
      } else if (activeD.length) {
        main.appendChild(el('div', 'r-sub', `тривога в ${activeD.length} районах`));
      } else if (r.since) {
        main.appendChild(el('div', 'r-sub', 'відбій ' + fmtTime(r.since)));
      }

      item.appendChild(main);
      const time = el('div', 'r-time', live && r.since ? fmtDur(now() - r.since) : r.permanent ? '∞' : '');
      if (live && r.since) time.dataset.since = String(r.since);
      item.appendChild(time);

      item.addEventListener('click', () => openDetail(r.name));
      box.appendChild(item);
    }

    if (!shown) box.appendChild(el('div', 'empty', q ? 'Нічого не знайдено.' : 'Немає даних.'));
  }

  function renderEventList() {
    const box = $('#eventList');
    const merged = S.events
      .map((e) => ({
        at: e.at,
        sim: false,
        on: e.kind === 'alert_on',
        text: (e.kind === 'alert_on' ? 'Повітряна тривога — ' : 'Відбій тривоги — ') + shortName(e.region),
        dur: e.duration,
      }))
      .concat(S.simEvents.map((e) => ({ at: e.at, sim: true, on: e.kind === 'arrived', text: e.text, dur: null })))
      .sort((a, b) => b.at - a.at)
      .slice(0, 120);

    box.innerHTML = '';
    if (!merged.length) {
      box.appendChild(el('div', 'empty', 'Журнал порожній.<br>Події зʼявляться, коли стан тривог зміниться.'));
      return;
    }
    for (const e of merged) {
      const item = el('div', 'e-item ' + (e.on ? 'on' : 'off'));
      item.appendChild(el('div', 'e-time', fmtTime(e.at)));
      item.appendChild(el('div', 'e-icon', e.on ? '▲' : '▼'));
      const t = el('div', 'e-text');
      t.innerHTML = e.text + (e.dur ? ` <span class="e-dur">(${fmtDur(e.dur)})</span>` : '') + (e.sim ? ' <span class="badge" style="color:#a855f7">SIM</span>' : '');
      item.appendChild(t);
      box.appendChild(item);
    }
  }

  /* ── деталі області ── */

  function openDetail(name) {
    S.selected = name;
    const r = S.regions.find((x) => x.name === name);
    const g = S.index[name];
    if (!r || !g) return;

    const activeD = r.districts.filter((d) => d.alert);
    const pop = S.cities.filter((c) => c.obl === name).reduce((sum, c) => sum + c.pop, 0);

    const live = r.alert && !r.permanent;
    const statusText = r.permanent ? 'ОКУПОВАНА ТЕРИТОРІЯ' : live ? 'ПОВІТРЯНА ТРИВОГА' : 'Відбій';
    const statusColor = r.permanent ? '#c9718f' : live ? '#ff2d55' : '#00e5a0';
    const head = `
      <div class="d-head">
        <div class="d-title">${name}</div>
        <div class="d-status">
          <span class="r-dot" style="background:${statusColor}${live ? ';box-shadow:0 0 9px #ff2d55' : ''}"></span>
          <b style="color:${statusColor}">${statusText}</b>
          ${live && r.since ? `<span class="r-time" data-since="${r.since}">${fmtDur(now() - r.since)}</span>` : ''}
        </div>
        ${r.permanent ? '<div class="d-note" style="margin-top:6px">Сигнал тривоги увімкнений безперервно з ' + new Date(r.since).toLocaleDateString('uk-UA') + '. Це позначення стану території, а не поточної повітряної загрози — у рівень загрози не враховується.</div>' : ''}
      </div>`;

    const cells = `
      <div class="d-sec">
        <div class="d-grid">
          <div class="d-cell"><span>початок</span><b>${live && r.since ? fmtTime(r.since) : '—'}</b></div>
          <div class="d-cell"><span>районів у тривозі</span><b>${activeD.length}/${r.districts.length || '—'}</b></div>
          <div class="d-cell"><span>населення міст</span><b>${pop ? fmtPop(pop) : '—'}</b></div>
          <div class="d-cell"><span>прифронтова</span><b>${CFG.FRONTLINE_REGIONS.includes(name) ? 'так' : 'ні'}</b></div>
        </div>
      </div>`;

    // Реальні цілі над областю замість колишньої геометричної оцінки.
    const over = S.contactStates.filter((st) => {
      const c = st.c;
      const obl = (c.to && c.to.obl) || c.oblast;
      return obl === name;
    });

    let threats = '';
    if (over.length) {
      threats =
        '<div class="d-sec"><h4>Цілі над областю</h4>' +
        over
          .sort((a, b) => (a.etaMin == null ? 999 : a.etaMin) - (b.etaMin == null ? 999 : b.etaMin))
          .slice(0, 12)
          .map(
            (st) => `
        <div class="d-threat" style="border-left-color:${st.def.color}">
          <div class="t-head">
            <span class="t-ico">${threatIcon(st.def, 15)}</span>
            <span class="t-type" style="color:${st.def.color}">${st.def.label}${st.c.count > 1 ? ' ×' + st.c.count : ''}</span>
            <span class="t-conf">${ageLabel(st.ageMin)}</span>
          </div>
          <div class="t-meta">
            ${st.origin ? `<span>${st.origin}</span>` : ''}
            ${st.nextCity ? `<span>→ <b>${st.nextCity}</b></span>` : ''}
            ${st.etaMin != null ? `<span><b>${fmtEta(st.etaMin)}</b></span>` : ''}
            ${st.speed ? `<span>${Math.round(st.speed)} км/год</span>` : ''}
          </div>
        </div>`
          )
          .join('') +
        '<div class="d-note" style="margin-top:8px;color:#5b6879">Із доповідей каналів моніторингу. Положення між доповідями розраховане.</div></div>';
    } else if (live) {
      threats = '<div class="d-sec"><h4>Цілі над областю</h4><div class="d-note">Тривога оголошена, але жодна ціль над областю зараз не доповідається.</div></div>';
    }

    const districts = activeD.length
      ? `<div class="d-sec"><h4>Райони в тривозі</h4><div class="d-districts">${activeD
          .map((d) => `<span class="badge" style="color:#ff2d55">${d.name}</span>`)
          .join('')}</div></div>`
      : '';

    const oblCities = S.cities.filter((c) => c.obl === name);
    const cities = oblCities.length
      ? `<div class="d-sec"><h4>Міста (${oblCities.length})</h4><div class="d-districts">${oblCities
          .slice()
          .sort((a, b) => b.pop - a.pop)
          .slice(0, 40)
          .map((c) => `<span class="badge" style="color:${c.occ ? '#8a93a0' : '#8695aa'}">${c.n} · ${fmtPop(c.pop)}</span>`)
          .join('')}</div></div>`
      : '';

    $('#detailBody').innerHTML = head + `<div class="d-body">${cells}${threats}${districts}${cities}</div>`;
    $('#panelRight').classList.remove('hidden');
    renderRegionList();

    // панель звужує мапу — Leaflet треба про це сказати, інакше полотно
    // лишається старого розміру й картинка обрізається
    map.invalidateSize({ animate: false });
    const lyr = oblastPaths[name];
    if (lyr) {
      programmatic = true;
      map.fitBounds(lyr.getBounds(), { padding: [50, 50], maxZoom: 8.5, animate: !document.hidden });
      setTimeout(() => { programmatic = false; }, 700);
    }
  }

  function closeDetail() {
    if (!S.selected) return;
    S.selected = null;
    $('#panelRight').classList.add('hidden');
    renderRegionList();
    map.invalidateSize({ animate: false });
    fitUkraine(true);
  }

  /* ── таймери в списках ── */

  function tickTimers() {
    document.querySelectorAll('[data-since]').forEach((n) => {
      n.textContent = fmtDur(now() - Number(n.dataset.since));
    });
    // положення цілей рахується від часу доповіді, тож рухається щосекунди
    if (S.tracks.length) {
      renderContacts();
      renderTargetList();
    }
  }

  /* ═══════════════ дані ═══════════════ */

  async function loadGeo() {
    const [oblasts, neighbors, raions, cityFile] = await Promise.all([
      fetch('data/oblasts.geojson').then((r) => r.json()),
      fetch('data/neighbors.geojson').then((r) => r.json()).catch(() => null),
      fetch('data/raions.geojson').then((r) => r.json()).catch(() => null),
      fetch('data/cities.json').then((r) => r.json()).catch(() => null),
    ]);
    // повний перелік міст із довідника; вбудований список — резерв
    S.cities = cityFile && cityFile.cities && cityFile.cities.length
      ? cityFile.cities
      : CFG.CITIES.map((c) => ({ n: c.n, ll: c.ll, pop: c.pop, r: c.r, occ: c.occ ? 1 : 0, obl: null }));
    S.geo = oblasts;
    if (neighbors) renderBase(neighbors);
    S.raions = raions;

    for (const f of S.geo.features) {
      const p = f.properties;
      S.index[p.name] = { centroid: [p.centroid[1], p.centroid[0]], cities: [], feature: f };
    }
    // прив'язка міст до областей
    for (const c of CFG.CITIES) {
      for (const f of S.geo.features) {
        if (pointInFeature([c.ll[1], c.ll[0]], f)) {
          c.region = f.properties.name;
          S.index[f.properties.name].cities.push(c);
          break;
        }
      }
    }
  }

  async function pollAlerts(first) {
    try {
      const res = await fetch(api('/api/alerts'), { cache: 'no-store' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.warning || 'сервер не має даних');

      S.clockSkew = data.serverNow ? data.serverNow - Date.now() : 0;

      const prev = new Map(S.regions.map((r) => [r.name, r.alert]));
      S.regions = data.regions;
      const t = Date.now() + (data.serverNow ? data.serverNow - Date.now() : 0);
      for (const r of S.regions) {
        r.permanent = !!(r.alert && r.since && t - r.since > PERMANENT_AFTER);
      }
      S.events = data.events || [];
      S.est = TE.estimate(S.regions, S.index);

      // звук лише на зміну стану, не на першому завантаженні
      if (!first) {
        let newOn = 0;
        let newOff = 0;
        for (const r of S.regions) {
          const was = prev.get(r.name);
          if (was === undefined || was === r.alert || r.permanent) continue;
          if (r.alert) newOn++;
          else newOff++;
        }
        if (newOn) siren('on');
        else if (newOff) siren('off');
      }

      for (const c of S.cities) {
        const r = S.regions.find((x) => x.name === (c.obl || c.region));
        c.alert = !!(r && r.alert);
      }

      S.failures = 0;
      setConn('ok', `${data.source} · ${fmtTime(data.ts)}`);
      if (data.warning) setConn('wait', 'резервне джерело');

      restyleOblasts();
      renderTop();
      renderRegionList();
      renderEventList();
      $('#srcName').textContent = data.source || '—';
    } catch (e) {
      S.failures++;
      setConn('err', S.failures > 2 ? 'немає зв’язку' : 'повтор…');
      console.warn('не вдалося отримати тривоги:', e.message);
      // інтерфейс може лежати окремо від сервера (GitHub Pages) —
      // тоді треба спитати, де саме сервер
      if (S.failures >= 2 && !BASE && !/^localhost$|^127\.|^\[::1\]$/.test(location.hostname)) {
        showServerSetup();
      }
    }
  }

  async function loadFrontline() {
    try {
      const res = await fetch(api('/api/frontline'), { cache: 'no-store' });
      const fc = await res.json();
      renderFrontline(fc);
      if (!S.layers.front) layerFront.remove();
    } catch (e) {
      console.warn('лінія фронту недоступна:', e.message);
    }
  }

  function setConn(stateName, text) {
    const c = $('#conn');
    c.dataset.state = stateName;
    $('#connText').textContent = text;
  }

  /* ═══════════════ події інтерфейсу ═══════════════ */

  function wire() {
    // вкладки
    document.querySelectorAll('.tab').forEach((t) => {
      t.addEventListener('click', () => {
        const panel = $('#panelLeft');
        if (window.innerWidth <= 900) {
          if (!panel.classList.contains('open')) {
            panel.classList.add('open');
            return;
          }
          // повторний тап по активній вкладці згортає шторку
          if (t.classList.contains('active')) {
            panel.classList.remove('open');
            return;
          }
        }
        document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
        ['alerts', 'targets', 'monitor', 'log'].forEach((k) => {
          $('#tab' + k[0].toUpperCase() + k.slice(1)).classList.toggle('hidden', k !== t.dataset.tab);
        });
      });
    });

    $('#regionSearch').addEventListener('input', renderRegionList);

    // шари
    document.querySelectorAll('.layer-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const k = b.dataset.layer;
        S.layers[k] = !S.layers[k];
        b.classList.toggle('active', S.layers[k]);
        const groups = { front: layerFront, cities: layerCities, npp: layerNpp, origins: layerOrigins, labels: layerLabels, contacts: layerContacts, raions: layerRaions, detail: layerDetail };
        if (groups[k]) {
          if (S.layers[k]) groups[k].addTo(map);
          else groups[k].remove();
        }
        if (k === 'alerts' || k === 'raions') restyleOblasts();
        if (k === 'contacts') renderContacts();
      });
    });

    // симулятор
    document.querySelectorAll('[data-sim]').forEach((b) => b.addEventListener('click', () => startSim(b.dataset.sim)));
    $('#simStop').addEventListener('click', stopSim);

    // звук
    $('#btnSound').addEventListener('click', (e) => {
      S.sound = !S.sound;
      e.currentTarget.setAttribute('aria-pressed', String(S.sound));
      if (S.sound) siren('off'); // короткий тон як підтвердження
    });

    $('#btnFit').addEventListener('click', () => {
      closeDetail();
      fitUkraine(true);
    });

    $('#detailClose').addEventListener('click', closeDetail);
    $('#legendToggle').addEventListener('click', () => $('#legend').classList.toggle('collapsed'));
    $('#disclaimerClose').addEventListener('click', () => {
      $('#disclaimer').classList.add('hidden');
      try { localStorage.setItem('ua-radar:disclaimer', '1'); } catch { /* приватний режим */ }
    });
    try {
      if (localStorage.getItem('ua-radar:disclaimer')) $('#disclaimer').classList.add('hidden');
    } catch { /* приватний режим */ }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeDetail();
      if (e.key === 'f' && !e.ctrlKey && e.target.tagName !== 'INPUT') $('#btnFit').click();
    });

    // легенда: класи цілей
    const lg = $('#legendThreats');
    for (const [, t] of Object.entries(CFG.THREATS)) {
      const row = el('div', 'lg-row');
      row.innerHTML = `${threatIcon(t, 12)}<span>${t.label}</span>`;
      row.title = t.full;
      lg.appendChild(row);
    }
  }

  /**
   * Коли сторінка відкрита не з того ж сервера (наприклад із GitHub
   * Pages), вона не знає, куди ходити за даними. Питаємо один раз і
   * запамʼятовуємо.
   */
  function showServerSetup() {
    if (document.getElementById('srvBar')) return;
    const d = el('div', 'srv-bar');
    d.id = 'srvBar';
    d.innerHTML = `
      <span class="srv-txt"><b>Немає звʼязку з сервером.</b>
      Ця сторінка — лише інтерфейс; дані збирає <code>server.js</code>.</span>
      <input id="srvInput" type="url" value="http://localhost:8787" spellcheck="false">
      <button id="srvSave">Підключити</button>
      <button class="srv-hide" title="Сховати">×</button>`;
    document.body.appendChild(d);

    const inp = d.querySelector('#srvInput');
    const save = () => {
      const v = inp.value.trim().replace(/\/$/, '');
      if (!v) return;
      try { localStorage.setItem('ua-radar:api', v); } catch { /* приватний режим */ }
      location.reload();
    };
    d.querySelector('#srvSave').addEventListener('click', save);
    d.querySelector('.srv-hide').addEventListener('click', () => d.remove());
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  }

  /* ═══════════════ старт ═══════════════ */

  async function init() {
    const sub = $('#bootSub');
    wire();
    sub.textContent = 'завантаження мапи…';
    buildMap();

    sub.textContent = 'геометрія областей…';
    await loadGeo();
    buildOblastLayer();
    if (S.raions) buildRaionLayer(S.raions);
    fitUkraine(false);
    map.on('zoomstart dragstart', markUserMove);
    map.on('moveend zoomend', scheduleDeclutter);
    // Кадр перебудовуємо при зміні розміру вікна, але тільки поки
    // людина сама не рухала мапу — інакше ресайз збивав би їй зум.
    // invalidateSize тут не викликаємо: він сам породжує resize.
    map.on('resize', () => {
      if (!S.selected && !S.userMoved) fitUkraine(false);
    });
    renderCities();
    loadWatch();
    renderWatch();
    renderWatchBar();
    scheduleDeclutter();
    renderNpp();
    renderOrigins();

    sub.textContent = 'стан повітряних тривог…';
    await pollAlerts(true);

    $('#boot').classList.add('done');
    setTimeout(() => $('#boot').remove(), 600);

    sub.textContent = 'лінія фронту…';
    loadFrontline();

    sub.textContent = 'канали моніторингу…';
    pollMonitor();

    setInterval(() => pollAlerts(false), POLL_MS);
    setInterval(pollMonitor, 6_000);
    setInterval(tickTimers, 1000);
    setInterval(loadFrontline, 10 * 60_000);

    window.RADAR = { S, map, TE, startSim, stopSim, renderIntercepts, declutterLabels, renderContacts, setWatch, watchThreat };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
