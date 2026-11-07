#!/usr/bin/env node
/**
 * Одноразовий збір обстановки у статичний знімок.
 *
 * Потрібен для режиму «все на GitHub»: Pages не вміє запускати
 * server.js, тому обстановку збирає GitHub Actions за розкладом, кладе
 * результат у snapshot.json, а сторінка його читає. Жодного сервера.
 *
 * ЧЕСНО ПРО СВІЖІСТЬ. Мінімальний крок розкладу в Actions — 5 хвилин,
 * і запуск часто ще й затримується. За цей час «Шахед» проходить
 * 15 км, а реактивний — 45. Для карти тривог це прийнятно, для
 * ведення цілей — ні. Хто хоче справжнього часу, запускає server.js
 * і вказує його адресу в інтерфейсі: сторінка віддасть перевагу йому.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const monitor = require('./monitor');
const tracks = require('./tracks');
const sources = require('./sources');

const ROOT = __dirname;
const OUT = process.argv[2] || path.join(ROOT, 'snapshot.json');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ─── те саме, що робить сервер при старті ─── */

function loadBooks() {
  const n = monitor.loadPlaces(
    path.join(ROOT, 'data', 'places.json'),
    path.join(ROOT, 'data', 'kyiv-places.json')
  );
  monitor.loadSites();
  const r = monitor.loadRaions(path.join(ROOT, 'data', 'raions.geojson'));
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'places.json'), 'utf8'));
    tracks.setCities(
      (raw.places || []).filter((p) => p.pop >= 45_000 && p.obl).map((p) => ({ n: p.n, ll: p.ll, pop: p.pop }))
    );
  } catch {
    /* без міст прогноз «куди дійде» просто не буде */
  }
  return { places: n, raions: r };
}

/* ─── тривоги ─── */

const https = require('https');
const zlib = require('zlib');

function fetchJson(url, timeout = 25_000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { timeout, headers: { 'User-Agent': 'ua-radar-collector/1.0', 'Accept-Encoding': 'gzip' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const st = (res.headers['content-encoding'] || '').includes('gzip') ? res.pipe(zlib.createGunzip()) : res;
        const chunks = [];
        st.on('data', (c) => chunks.push(c));
        st.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(e);
          }
        });
        st.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const ts = (v) => {
  if (!v) return null;
  const t = Date.parse(v.includes('T') ? v : v.replace(' ', 'T') + 'Z');
  return Number.isFinite(t) && t > 0 ? t : null;
};

async function getAlerts() {
  const raw = await fetchJson('https://vadimklimenko.com/map/statuses.json');
  const regions = [];
  for (const [name, s] of Object.entries(raw.states || {})) {
    regions.push({
      name,
      alert: !!s.enabled,
      since: ts(s.enabled_at),
      until: ts(s.disabled_at),
      level: s.alert_level || null,
      districts: Object.entries(s.districts || {}).map(([dn, d]) => ({
        name: dn,
        alert: !!d.enabled,
        since: ts(d.enabled_at),
        level: d.alert_level || null,
      })),
    });
  }
  return { source: 'vadimklimenko.com', regions };
}

/* ─── лінія фронту: важка й міняється рідко ─── */

const FRONT_BBOX = [21.5, 43.0, 41.5, 53.5];
const inBBox = (p) => p[0] >= FRONT_BBOX[0] && p[0] <= FRONT_BBOX[2] && p[1] >= FRONT_BBOX[1] && p[1] <= FRONT_BBOX[3];

async function getFrontline() {
  const raw = await fetchJson('https://deepstatemap.live/api/history/last', 60_000);
  const out = [];
  for (const f of (raw && raw.map && raw.map.features) || []) {
    if (!f.geometry || f.geometry.type !== 'Polygon') continue;
    const n = ((f.properties && f.properties.name) || '').toLowerCase();
    if (!/status\.occupied|territories\.ordlo|territories\.crimea/.test(n)) continue;
    const rings = [];
    for (const ring of f.geometry.coordinates) {
      const pts = ring.map((p) => [+p[0].toFixed(4), +p[1].toFixed(4)]);
      if (pts.length > 3 && pts.some(inBBox)) rings.push(pts);
    }
    if (rings.length) out.push({ type: 'Feature', properties: { cls: 'occupied' }, geometry: { type: 'Polygon', coordinates: rings } });
  }
  return { type: 'FeatureCollection', meta: { source: 'deepstatemap.live', fetchedAt: Date.now() }, features: out };
}

/* ─── збірка ─── */

async function main() {
  const books = loadBooks();
  log(`довідники: ${books.places} місць, ${books.raions} районів`);

  let alerts = null;
  try {
    alerts = await getAlerts();
    const active = alerts.regions.filter((r) => r.alert).length;
    log(`тривоги: ${active}/${alerts.regions.length}`);
    monitor.setAdminWords(alerts.regions.flatMap((r) => [r.name, ...r.districts.map((d) => d.name)]));
  } catch (e) {
    log('! тривоги:', e.message);
  }

  // канали читаємо двічі з паузою: за один прохід видно лише останні
  // повідомлення, а для зшивання треків потрібна послідовність
  try {
    const n1 = await monitor.poll();
    log(`монітор: ${n1} контактів`);
  } catch (e) {
    log('! монітор:', e.message);
  }

  try {
    await sources.poll();
    const s = sources.snapshot();
    log('зовнішні: ' + s.sources.map((x) => x.name + (x.ok ? ' ✓' : ' ✗')).join(', '));
  } catch (e) {
    log('! зовнішні:', e.message);
  }

  let front = null;
  try {
    front = await getFrontline();
    log(`фронт: ${front.features.length} полігонів`);
  } catch (e) {
    log('! фронт:', e.message);
  }

  const mon = monitor.snapshot();
  const ext = sources.snapshot();

  const snap = {
    builtAt: Date.now(),
    builtBy: 'github-actions',
    note: 'Статичний знімок. Оновлюється за розкладом, тож дані відстають. Для реального часу запустіть server.js і вкажіть його адресу.',
    alerts: alerts ? { ok: true, ts: Date.now(), source: alerts.source, regions: alerts.regions } : { ok: false, regions: [] },
    tracks: mon.tracks || [],
    intercepts: mon.intercepts || [],
    trackStats: mon.trackStats || null,
    channels: mon.channels || [],
    messages: (mon.messages || []).slice(0, 40),
    external: { raionLevels: ext.raionLevels, sources: ext.sources },
    frontline: front,
  };

  fs.writeFileSync(OUT, JSON.stringify(snap));
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  log(`знімок: ${OUT} (${kb} KB) — треків ${snap.tracks.length}, тривог ${snap.alerts.regions.filter((r) => r.alert).length}`);
}

main().catch((e) => {
  console.error('збір провалився:', e.message);
  process.exit(1);
});
