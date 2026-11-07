/**
 * Зовнішні агрегатори як додаткові джерела.
 *
 * NEPTUN (neptun.in.ua) і RadarUA (radarua.com) — чужі публічні мапи, які
 * зводять ті самі відкриті Telegram-канали, що читає наш monitor.js, але
 * мають власну кореляцію цілей. Їхні фронтенди ходять у ці адреси без
 * авторизації, тож дані доступні й нам.
 *
 * ЧЕСНО ПРО МЕЖІ:
 *   - це недокументовані внутрішні ендпоїнти чужих продуктів. Вони можуть
 *     змінитись або закритись будь-коли, і ми на це не впливаємо;
 *   - тому кожне джерело вимикається окремо (`enabled`), а падіння одного
 *     не ламає решту: свій парсер каналів працює незалежно;
 *   - опитуємо рідше, ніж власні джерела, і чесно підписуємо походження
 *     кожної цілі в інтерфейсі.
 */
'use strict';

const https = require('https');
const zlib = require('zlib');

const SOURCES = {
  neptun: {
    name: 'NEPTUN',
    url: 'https://neptun.in.ua/api/v1/alerts',
    referer: 'https://neptun.in.ua/',
    enabled: true,
    gives: 'рівні тривоги по районах',
  },
  radarua: {
    name: 'RadarUA',
    url: 'https://radarua.com/api/tracks',
    referer: 'https://radarua.com/',
    enabled: true,
    gives: 'зведені треки цілей',
  },
};

const POLL_MS = 15_000;
/** Трек чужого агрегатора живе стільки після останнього оновлення. */
const TRACK_TTL = 3 * 60_000;

const state = {
  raionLevels: [],   // з NEPTUN
  tracks: [],        // з RadarUA
  status: {},        // id -> { ok, at, error, count }
};

function fetchJson(url, referer, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        timeout,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ua-radar/1.0',
          Accept: 'application/json',
          'Accept-Language': 'uk',
          'Accept-Encoding': 'gzip, deflate',
          Referer: referer,
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(new Error('bad JSON: ' + e.message));
          }
        });
        stream.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/* ── NEPTUN: рівні тривоги по районах ── */

async function pollNeptun() {
  const src = SOURCES.neptun;
  if (!src.enabled) return;
  try {
    const raw = await fetchJson(src.url, src.referer);
    const rows = [];
    for (const r of raw.raions || []) {
      if (!r.name || !r.oblast) continue;
      rows.push({
        name: r.name,
        oblast: r.oblast,
        level: r.level === 'red' ? 'red' : 'yellow',
        since: Date.parse(r.since) || null,
        reason: Array.isArray(r.reasons) ? r.reasons[0] : null,
      });
    }
    state.raionLevels = rows;
    state.status.neptun = { ok: true, at: Date.now(), count: rows.length, error: null };
  } catch (e) {
    state.status.neptun = { ok: false, at: Date.now(), count: state.raionLevels.length, error: e.message };
  }
}

/* ── RadarUA: зведені треки ── */

/** Їхні позначення класів → наші. */
const TYPE_MAP = {
  shahed: 'shahed',
  shahed_jet: 'shahed_jet',
  reactive: 'shahed_jet',
  jet: 'shahed_jet',
  rocket: 'missile',
  missile: 'missile',
  ballistic: 'ballistic',
  cruise: 'cruise_air',
  kab: 'kab',
  recon: 'recon_uav',
  fpv: 'recon_uav',
  aircraft: 'unknown',
  unknown: 'unknown',
};

async function pollRadarua() {
  const src = SOURCES.radarua;
  if (!src.enabled) return;
  try {
    const raw = await fetchJson(src.url, src.referer);
    const now = Date.now();
    const rows = [];
    for (const t of raw.tracks || []) {
      if (!Number.isFinite(t.lat) || !Number.isFinite(t.lng)) continue;
      const seen = Date.parse(t.lastSeenAt) || now;
      if (now - seen > TRACK_TTL) continue;
      rows.push({
        id: 'ru_' + t.id,
        type: TYPE_MAP[t.threatType] || 'unknown',
        ll: [+t.lat.toFixed(4), +t.lng.toFixed(4)],
        place: t.place || null,
        region: t.region || null,
        approx: !!t.placeApprox,
        count: Math.max(1, Math.min(Number(t.count) || 1, 99)),
        bearing: Number.isFinite(t.courseBearing) ? t.courseBearing : null,
        speed: Number.isFinite(t.speedKmh) ? t.speedKmh : null,
        uncertaintyKm: Number.isFinite(t.uncertaintyKm) ? t.uncertaintyKm : null,
        confidence: Number.isFinite(t.confidence) ? t.confidence : null,
        observed: t.trackState === 'observed',
        firstAt: Date.parse(t.firstSeenAt) || seen,
        at: seen,
        sources: Array.isArray(t.sources) ? t.sources.slice(0, 12) : [],
        trajectory: Array.isArray(t.trajectory) ? t.trajectory.slice(-12) : [],
      });
    }
    state.tracks = rows;
    state.status.radarua = { ok: true, at: Date.now(), count: rows.length, error: null };
  } catch (e) {
    state.status.radarua = { ok: false, at: Date.now(), count: 0, error: e.message };
  }
}

async function poll() {
  await Promise.allSettled([pollNeptun(), pollRadarua()]);
  return { raions: state.raionLevels.length, tracks: state.tracks.length };
}

function snapshot() {
  const now = Date.now();
  return {
    raionLevels: state.raionLevels,
    tracks: state.tracks.filter((t) => now - t.at <= TRACK_TTL),
    sources: Object.entries(SOURCES).map(([id, s]) => ({
      id,
      name: s.name,
      gives: s.gives,
      enabled: s.enabled,
      ...(state.status[id] || { ok: false, error: 'ще не опитано' }),
    })),
  };
}

function setEnabled(id, on) {
  if (SOURCES[id]) SOURCES[id].enabled = !!on;
}

module.exports = { poll, snapshot, setEnabled, SOURCES, POLL_MS };
