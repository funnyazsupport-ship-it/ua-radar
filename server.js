#!/usr/bin/env node
/**
 * UA-RADAR — локальний сервер мапи повітряних тривог.
 *
 * Робить три речі:
 *   1. роздає статику з ./public та ./data
 *   2. проксує публічні API (обхід CORS) з кешем і мʼякою деградацією
 *   3. сам опитує стан тривог кожні 15 с і веде журнал подій
 *
 * Джерела (усі публічні, без ключів):
 *   vadimklimenko.com/map/statuses.json  — стан тривог по областях + районах
 *   ubilling.net.ua/aerialalerts/        — резервне джерело стану тривог
 *   deepstatemap.live/api/history/last   — лінія фронту / окуповані території
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const monitor = require('./monitor');
const sources = require('./sources');
const telegram = require('./telegram');
const classes = require('./classes');
const ai = require('./ai');

const PORT = Number(process.env.PORT || 8787);
const MONITOR_MS = 15_000;
const ROOT = __dirname;
const CACHE_DIR = path.join(ROOT, 'cache');
const POLL_MS = 10_000;
const FRONTLINE_TTL = 10 * 60_000;
const MAX_EVENTS = 400;

const SOURCES = {
  primary: 'https://vadimklimenko.com/map/statuses.json',
  backup: 'https://ubilling.net.ua/aerialalerts/',
  frontline: 'https://deepstatemap.live/api/history/last',
};

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ─────────────────────────── http helper ─────────────────────────── */

function fetchJson(url, { timeout = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        timeout,
        headers: {
          'User-Agent': 'ua-radar/1.0 (local civil-defence alert map)',
          Accept: 'application/json,text/plain,*/*',
          'Accept-Encoding': 'gzip, deflate',
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return fetchJson(new URL(res.headers.location, url).href, { timeout }).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        const stream =
          enc === 'gzip' ? res.pipe(zlib.createGunzip())
          : enc === 'deflate' ? res.pipe(zlib.createInflate())
          : res;
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(new Error(`bad JSON from ${url}: ${e.message}`));
          }
        });
        stream.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error(`timeout ${timeout}ms for ${url}`)));
    req.on('error', reject);
  });
}

/* ─────────────────────────── state ─────────────────────────── */

const state = {
  alerts: null, // нормалізований знімок
  alertsFetchedAt: 0,
  alertsError: null,
  frontline: null,
  frontlineFetchedAt: 0,
  frontlineError: null,
  events: [], // журнал переходів
};

// журнал переживає перезапуск
try {
  const saved = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'events.json'), 'utf8'));
  if (Array.isArray(saved)) state.events = saved.slice(0, MAX_EVENTS);
} catch {
  /* перший запуск */
}

let saveTimer = null;
function saveEvents() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(path.join(CACHE_DIR, 'events.json'), JSON.stringify(state.events.slice(0, MAX_EVENTS)), () => {});
  }, 1500);
}

/* ─────────────────────── нормалізація тривог ─────────────────────── */

const ts = (v) => {
  if (!v) return null;
  const t = Date.parse(v.includes('T') ? v : v.replace(' ', 'T') + 'Z');
  return Number.isFinite(t) && t > 0 ? t : null;
};

function normalizePrimary(raw) {
  const regions = [];
  for (const [name, s] of Object.entries(raw.states || {})) {
    const districts = Object.entries(s.districts || {}).map(([dn, d]) => ({
      name: dn,
      alert: !!d.enabled,
      since: ts(d.enabled_at),
      level: d.alert_level || null,
    }));
    regions.push({
      name,
      alert: !!s.enabled,
      since: ts(s.enabled_at),
      until: ts(s.disabled_at),
      level: s.alert_level || null,
      districts,
    });
  }
  return { source: 'vadimklimenko.com', regions };
}

function normalizeBackup(raw) {
  const regions = Object.entries(raw.states || {}).map(([name, s]) => ({
    name,
    alert: !!s.alertnow,
    since: ts(s.changed),
    until: null,
    level: null,
    districts: [],
  }));
  return { source: 'ubilling.net.ua', regions };
}

async function pollAlerts() {
  let snap = null;
  let err = null;
  try {
    snap = normalizePrimary(await fetchJson(SOURCES.primary));
  } catch (e1) {
    try {
      snap = normalizeBackup(await fetchJson(SOURCES.backup));
      err = `основне джерело недоступне (${e1.message}), використано резервне`;
    } catch (e2) {
      state.alertsError = `${e1.message}; резерв: ${e2.message}`;
      log('! обидва джерела тривог недоступні:', state.alertsError);
      return;
    }
  }

  const prev = state.alerts;
  const now = Date.now();

  if (prev) {
    const before = new Map(prev.regions.map((r) => [r.name, r]));
    for (const r of snap.regions) {
      const p = before.get(r.name);
      if (!p || p.alert === r.alert) continue;
      state.events.unshift({
        id: `${now}-${r.name}`,
        at: now,
        region: r.name,
        kind: r.alert ? 'alert_on' : 'alert_off',
        // для відбою — скільки тривала тривога
        duration: !r.alert && p.since ? now - p.since : null,
      });
    }
    if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS;
    saveEvents();
  }

  // назви областей і районів — монітору, щоб не плутав їх із селами
  if (!state.adminWordsSent) {
    const names = snap.regions.flatMap((r) => [r.name, ...r.districts.map((d) => d.name)]);
    if (names.length) {
      monitor.setAdminWords(names);
      state.adminWordsSent = true;
    }
  }

  state.alerts = snap;
  state.alertsFetchedAt = now;
  state.alertsError = err;
  const active = snap.regions.filter((r) => r.alert).length;
  log(`тривоги: ${active}/${snap.regions.length} активні (${snap.source})${err ? ' [' + err + ']' : ''}`);
}

/* ─────────────────────── лінія фронту ─────────────────────── */

const FRONT_BBOX = [21.5, 43.0, 41.5, 53.5]; // Україна + прилегла зона

const inBBox = (p) => p[0] >= FRONT_BBOX[0] && p[0] <= FRONT_BBOX[2] && p[1] >= FRONT_BBOX[1] && p[1] <= FRONT_BBOX[3];

function classify(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('status.occupied') || n.includes('territories.ordlo') || n.includes('territories.crimea')) return 'occupied';
  if (n.includes('status.dismissed')) return 'liberated';
  if (n.includes('status.unknown')) return 'unknown';
  return 'other'; // Придністровʼя, Абхазія та інші позначки поза межами України
}

/** 2D + округлення до ~10 м; полігони поза межами України відкидаємо */
function slimFrontline(raw) {
  const src = (raw && raw.map && raw.map.features) || [];
  const out = [];
  for (const f of src) {
    if (!f.geometry || f.geometry.type !== 'Polygon') continue;
    if (classify(f.properties && f.properties.name) !== 'occupied') continue;
    const rings = [];
    for (const ring of f.geometry.coordinates) {
      const pts = ring.map((p) => [+p[0].toFixed(4), +p[1].toFixed(4)]);
      if (pts.length > 3 && pts.some(inBBox)) rings.push(pts);
    }
    if (!rings.length) continue;
    out.push({ type: 'Feature', properties: { cls: 'occupied' }, geometry: { type: 'Polygon', coordinates: rings } });
  }
  return {
    type: 'FeatureCollection',
    meta: { id: raw && raw.id, updatedAt: (raw && raw.updatedAt) || null, source: 'deepstatemap.live', fetchedAt: Date.now() },
    features: out,
  };
}

async function getFrontline() {
  if (state.frontline && Date.now() - state.frontlineFetchedAt < FRONTLINE_TTL) return state.frontline;
  const disk = path.join(CACHE_DIR, 'frontline.json');
  try {
    const fresh = slimFrontline(await fetchJson(SOURCES.frontline, { timeout: 45_000 }));
    state.frontline = fresh;
    state.frontlineFetchedAt = Date.now();
    state.frontlineError = null;
    fs.writeFile(disk, JSON.stringify(fresh), () => {});
    log(`фронт: ${fresh.features.length} полігонів`);
    return fresh;
  } catch (e) {
    state.frontlineError = e.message;
    log('! фронт недоступний:', e.message);
    if (state.frontline) return state.frontline;
    try {
      const cached = JSON.parse(fs.readFileSync(disk, 'utf8'));
      cached.meta = Object.assign({}, cached.meta, { stale: true });
      state.frontline = cached;
      return cached;
    } catch {
      return { type: 'FeatureCollection', features: [], meta: { error: e.message } };
    }
  }
}


/* ─────────────────────── зведення для Telegram ─────────────────────── */

/** Великі міста з довідника — для таблиці часу підльоту після пуску. */
let BIG_CITIES = [];
function loadBigCities() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'places.json'), 'utf8'));
    BIG_CITIES = (raw.places || [])
      .filter((p) => p.pop >= 15_000 && p.obl)
      .map((p) => ({ n: p.n, ll: p.ll, pop: p.pop }))
      .sort((a, b) => b.pop - a.pop);
  } catch {
    BIG_CITIES = [];
  }
  return BIG_CITIES.length;
}

function reachFrom(originLL, type) {
  const d = classes.get(type);
  const rows = [];
  for (const c of BIG_CITIES.filter((x) => x.pop >= 90_000).slice(0, 45)) {
    const km = classes.distKm(originLL, c.ll);
    if (km > d.range) continue;
    rows.push({ city: c.n, distanceKm: Math.round(km), flightMin: (km / d.speed) * 60 });
  }
  return rows.sort((a, b) => a.flightMin - b.flightMin);
}

/** Зшитий трек → рядок для каналу. */
function toTarget(t) {
  return {
    id: t.id,
    type: t.type,
    label: t.label,
    place: t.place,
    nextCity: t.nextCity,
    oblast: t.oblast,
    count: t.count,
    etaMin: t.etaMin,
    speed: t.speed,
    at: t.lastAt,
    sources: t.sources || [],
    kind: t.action === 'launch' || t.action === 'takeoff' ? 'launch' : t.action === 'impact' ? 'impact' : 'track',
  };
}

/** Що саме варто кинути окремим постом. */
function urgentFrom(contacts) {
  const out = [];
  for (const c of contacts) {
    const d = classes.get(c.type);
    const place = (c.to && c.to.n) || (c.from && c.from.n) || null;

    if (c.action === 'launch' || c.action === 'takeoff') {
      const origin = (c.from && c.from.ll) || (c.to && c.to.ll);
      if (!origin) continue;
      const elapsedH = (Date.now() - c.at) / 3_600_000;
      out.push({
        id: 'L:' + c.id,
        kind: 'launch',
        action: c.action,
        type: c.type,
        label: d.label,
        from: c.site || (c.from && c.from.n) || place,
        reachKm: Math.min(d.speed * elapsedH, d.range),
        reach: reachFrom(origin, c.type),
        at: c.at,
        sources: c.sources,
      });
      continue;
    }

    if (c.action === 'impact') {
      out.push({ id: 'I:' + c.id, kind: 'impact', type: c.type, label: d.label, place, oblast: c.oblast, text: c.text, at: c.at, sources: c.sources });
      continue;
    }

    // ракетні класи — окремим постом, бо часу на реакцію мало
    if (telegram.cfg.urgentTypes.includes(c.type)) {
      const t = toTarget(c);
      out.push({ id: 'U:' + c.id, kind: 'threat', ...t });
    }
  }
  return out;
}

function pushToTelegram() {
  if (!telegram.cfg.enabled) return;
  const snap = monitor.snapshot();
  const alerts = (state.alerts ? state.alerts.regions : [])
    .filter((r) => r.alert && !(r.since && Date.now() - r.since > 14 * 24 * 3600_000))
    .map((r) => r.name);

  const targets = (snap.tracks || []).filter((t) => t.action !== 'clear').map(toTarget);
  const byType = {};
  for (const t of targets) byType[t.type] = (byType[t.type] || 0) + t.count;

  telegram.tick({ alerts, targets, byType, events: urgentFrom(snap.contacts) });
}

/* ─────────────────────── статика ─────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
};

function sendJson(res, obj, code = 200) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    // дані публічні й лише на читання, тож фронтенд може жити
    // на іншому домені — наприклад на GitHub Pages
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function sendFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Access-Control-Allow-Origin': '*',
      // статика не кешується: інакше правки в css/js не видно без хард-релоуду
      'Cache-Control': ext === '.geojson' ? 'public, max-age=3600' : 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
}

/* ─────────────────────── маршрути ─────────────────────── */

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('bad url');
    return;
  }

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }

    if (pathname === '/api/alerts') {
      if (!state.alerts && !state.alertsError) await pollAlerts();
      return sendJson(res, {
        ok: !!state.alerts,
        ts: state.alertsFetchedAt,
        age: state.alertsFetchedAt ? Date.now() - state.alertsFetchedAt : null,
        serverNow: Date.now(),
        source: state.alerts ? state.alerts.source : null,
        warning: state.alertsError,
        regions: state.alerts ? state.alerts.regions : [],
        events: state.events.slice(0, 120),
      });
    }

    if (pathname === '/api/frontline') {
      return sendJson(res, await getFrontline());
    }

    if (pathname === '/api/monitor') {
      const snap = monitor.snapshot();
      snap.external = sources.snapshot();
      snap.ai = ai.snapshot();
      return sendJson(res, snap);
    }

    if (pathname === '/api/ai') {
      return sendJson(res, ai.snapshot());
    }

    if (pathname === '/api/ai/test') {
      try {
        return sendJson(res, { ok: true, ...(await ai.selfTest()) });
      } catch (e) {
        return sendJson(res, { ok: false, error: e.message });
      }
    }

    if (pathname === '/api/telegram/status') {
      return sendJson(res, telegram.status());
    }

    if (pathname === '/api/telegram/test') {
      try {
        const r = await telegram.selfTest();
        return sendJson(res, { ok: true, ...r });
      } catch (e) {
        return sendJson(res, { ok: false, error: e.message }, 200);
      }
    }

    if (pathname === '/api/status') {
      return sendJson(res, {
        uptime: Math.round(process.uptime()),
        alerts: { fetchedAt: state.alertsFetchedAt, error: state.alertsError, source: state.alerts && state.alerts.source },
        frontline: { fetchedAt: state.frontlineFetchedAt, error: state.frontlineError },
        events: state.events.length,
        sources: SOURCES,
      });
    }

    // статика
    const rel = pathname === '/' ? '/index.html' : pathname;
    const base = rel.startsWith('/data/') ? ROOT : path.join(ROOT, 'public');
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('403');
      return;
    }
    return sendFile(res, file);
  } catch (e) {
    log('! помилка запиту', pathname, e.message);
    return sendJson(res, { ok: false, error: e.message }, 500);
  }
});

async function pollAi() {
  if (!ai.cfg.enabled) return;
  const snap = monitor.snapshot();
  const alerts = (state.alerts ? state.alerts.regions : [])
    .filter((r) => r.alert && !(r.since && Date.now() - r.since > 14 * 24 * 3600_000))
    .map((r) => r.name.replace(' область', ''));
  await ai.tick({
    takeUnparsed: monitor.takeUnparsed,
    addAiContacts: monitor.addAiContacts,
    takeForReview: monitor.takeForReview,
    applyReview: monitor.applyReview,
    knownCity: (n) => {
      const k = String(n).toLowerCase().replace(/['’ʼ]/g, "'").trim();
      return BIG_CITIES.some((c) => c.n.toLowerCase().replace(/['’ʼ]/g, "'") === k);
    },
    tracks: snap.tracks || [],
    alerts,
    intercepts: snap.intercepts || [],
  });
}

async function pollSources() {
  try {
    await sources.poll();
  } catch (e) {
    log('! зовнішні джерела:', e.message);
  }
}

async function pollMonitor() {
  try {
    const fresh = await monitor.poll();
    if (fresh) log(`монітор: +${fresh} контактів`);
  } catch (e) {
    log('! монітор:', e.message);
  }
}

server.listen(PORT, () => {
  log(`UA-RADAR працює → http://localhost:${PORT}`);

  const n = monitor.loadPlaces(path.join(ROOT, 'data', 'places.json'), path.join(ROOT, 'data', 'kyiv-places.json'));
  monitor.loadSites();
  const nr = monitor.loadRaions(path.join(ROOT, 'data', 'raions.geojson'));
  log(`межі районів для геоприв'язки: ${nr}`);
  log(`довідник місць: ${n} записів, каналів моніторингу: ${monitor.CHANNELS.length}`);

  pollAlerts();
  setInterval(pollAlerts, POLL_MS);
  getFrontline();
  setInterval(getFrontline, FRONTLINE_TTL);
  pollMonitor();
  setInterval(pollMonitor, MONITOR_MS);
  pollSources();
  setInterval(pollSources, sources.POLL_MS);

  if (ai.configure(ROOT)) {
    const a = ai.snapshot();
    log(`ШІ: увімкнено, ${a.providerName} / ${a.model}`);
    monitor.setReviewEnabled(true);
    setInterval(pollAi, 15_000);
  } else {
    log('ШІ: вимкнено (немає ключа в config.json)');
  }

  const cities = loadBigCities();
  // прогноз «куди дійде» рахує модуль треків — віддаємо йому міста
  require('./tracks').setCities(
    (() => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'places.json'), 'utf8'));
        return (raw.places || []).filter((p) => p.pop >= 45_000 && p.obl).map((p) => ({ n: p.n, ll: p.ll, pop: p.pop }));
      } catch {
        return [];
      }
    })()
  );
  if (telegram.configure(ROOT)) {
    log(`Telegram: увімкнено, канал ${telegram.status().chatId}, міст у таблиці підльоту: ${cities}`);
    setInterval(pushToTelegram, 10_000);
  } else {
    log('Telegram: вимкнено (enabled:false або не задано токен/канал у config.json)');
  }
});
