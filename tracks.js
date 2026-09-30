/**
 * Зшивання доповідей у траєкторії.
 *
 * Канали доповідають про одну й ту саму ціль багато разів, поки вона
 * летить: «курсом на Понорницю» → «курсом на Носівку» → «курсом на
 * Бровари». Поодинці це три незалежні точки, які нічого не кажуть про
 * рух. Зшиті в ланцюг — це трек із курсом, швидкістю й чесним часом
 * підльоту.
 *
 * ПРО ПОЛОЖЕННЯ. Доповідь «курсом на X» означає, що ціль ще не над X, а
 * підходить до нього: спостерігач називає найближчий орієнтир. Тому
 * точку доповіді беремо за положення цілі на той момент із похибкою
 * порядку десятка кілометрів — саме так це роблять і публічні монітори.
 *
 * Це не радар: між доповідями положення рахується, а не спостерігається.
 */
'use strict';

const classes = require('./classes');

/** Класи, які канали плутають між собою — дозволяємо зшивати. */
const FAMILY = {
  shahed: 'uav', shahed_jet: 'uav', unknown: 'uav', recon_uav: 'uav',
  ballistic: 'missile', aeroballistic: 'missile', missile: 'missile',
  cruise_air: 'cruise', cruise_sea: 'cruise', cruise_ground: 'cruise', kh22: 'cruise',
  kab: 'kab', sam: 'sam',
};
const family = (t) => FAMILY[t] || t;

/** Класи всередині родини — для вибору того, чия швидкість підходить. */
const KIN = {};
for (const t of Object.keys(FAMILY)) (KIN[family(t)] = KIN[family(t)] || []).push(t);

/**
 * Яка швидкість правдоподібна для родини.
 * Перевіряти треба проти паспортної швидкості класу, а НЕ проти вже
 * накопиченої швидкості треку: інакше одна хибна звʼязка піднімає поріг,
 * і трек починає ковтати будь-які стрибки.
 */
const SPEED_LO = 0.4;
const SPEED_HI = 1.5;

function fitClass(type, impliedSpeed) {
  let best = null;
  let bestErr = Infinity;
  for (const cand of KIN[family(type)] || [type]) {
    const nom = classes.get(cand).speed;
    const ratio = impliedSpeed / nom;
    if (ratio < SPEED_LO || ratio > SPEED_HI) continue;
    const err = Math.abs(Math.log(ratio));
    if (err < bestErr) { bestErr = err; best = cand; }
  }
  return best ? { type: best, err: bestErr } : null;
}

/** Довше за це без доповідей — трек закритий. */
const MAX_GAP_MS = 15 * 60_000;
/** Доповіді ближче в часі вважаємо повтором тієї самої точки. */
const SAME_POINT_MS = 25_000;
/**
 * У межах цього радіуса доповідь вважається про ту саму ціль — навіть
 * якщо швидкість між точками виходить неправдоподібною (у місті канали
 * називають сусідні райони за секунди).
 */
const NEAR_KM = 15;
/** Менший зсув не рухає мітку: це той самий орієнтир. */
const MOVE_MIN_KM = 1.5;
/** Курс і швидкість перераховуємо лише по відчутному відрізку. */
const LEG_MIN_KM = 6;
const LEG_MIN_MS = 60_000;
/** Скільки точок тримати в хвості траєкторії. */
const MAX_POINTS = 24;

const state = {
  tracks: new Map(), // id -> трек
  seq: 0,
  cities: [],        // великі міста для прогнозу «куди дійде»
  intercepts: [],    // збиті цілі
};

/** Скільки збиття лишається на мапі. */
const INTERCEPT_TTL = 20 * 60_000;

/** Список великих міст задає сервер із довідника GeoNames. */
function setCities(list) {
  state.cities = list || [];
  return state.cities.length;
}

/** Півкут пошуку міста по курсу. */
const CONE_DEG = 35;
/** Наскільки далеко вперед дивимось. */
const LOOKAHEAD_MIN = 50;

/**
 * Куди трек дійде, якщо збереже курс.
 * Саме це відповідає на питання «що куди летить і за скільки», бо
 * названий у доповіді орієнтир — це вже поточне положення цілі.
 */
function cityAhead(pos, bearing, speed) {
  if (bearing == null || !state.cities.length) return null;
  const maxKm = (speed * LOOKAHEAD_MIN) / 60;
  let best = null;
  for (const c of state.cities) {
    const d = classes.distKm(pos, c.ll);
    if (d < 12 || d > maxKm) continue;
    const brg = classes.bearing(pos, c.ll);
    const off = classes.bearingDelta(bearing, brg);
    if (off > CONE_DEG) continue;
    // ближче й точніше по курсу — краще
    const score = d * (1 + off / 90);
    if (!best || score < best.score) {
      best = { score, city: c.n, ll: c.ll, distanceKm: Math.round(d), etaMin: (d / speed) * 60, offDeg: Math.round(off), pop: c.pop };
    }
  }
  return best;
}

/* ─────────────── асоціація доповіді з треком ─────────────── */

/**
 * Чи може ця доповідь бути продовженням треку?
 * @returns {number|null} вартість звʼязку (менше — краще) або null
 */
function matchCost(track, obs) {
  if (family(track.type) !== family(obs.type)) return null;

  const dt = obs.at - track.lastAt;
  if (dt < 0 || dt > MAX_GAP_MS) return null;

  const last = track.points[track.points.length - 1];
  const d = classes.distKm(last.ll, obs.ll);

  // поруч — та сама ціль; швидкість тут не перевіряємо
  if (d <= NEAR_KM && dt <= SAME_POINT_MS * 12) return d * 0.05;

  if (dt < 20_000) return null; // за 20 с ціль не перелетіла б відчутно

  const dtH = dt / 3_600_000;
  const impliedSpeed = d / dtH;

  // швидкість має бути правдоподібною хоч для когось із родини
  const fit = fitClass(track.type, impliedSpeed);
  if (!fit) return null;

  let cost = fit.err;

  // напрямок не повинен стрибати
  if (track.bearing != null && d > 5) {
    const legBrg = classes.bearing(last.ll, obs.ll);
    const delta = classes.bearingDelta(track.bearing, legBrg);
    if (delta > 75) return null;
    cost += delta / 180;
  }

  return cost;
}

function newTrack(obs) {
  const t = {
    id: 'tk' + ++state.seq,
    type: obs.type,
    typeVotes: { [obs.type]: 1 },
    points: [{ ll: obs.ll, at: obs.at, place: obs.place }],
    firstAt: obs.at,
    lastAt: obs.at,
    bearing: null,
    speed: null,
    count: obs.count || 1,
    sources: new Set(obs.sources),
    reports: 1,
    target: obs.target || null,
    oblast: obs.oblast || null,
    text: obs.text,
    link: obs.link,
    action: obs.action,
    level: obs.level || null,
    site: obs.site || null,
  };
  state.tracks.set(t.id, t);
  return t;
}

function extend(track, obs) {
  const last = track.points[track.points.length - 1];
  const d = classes.distKm(last.ll, obs.ll);
  const dt = obs.at - track.lastAt;

  // Курс і швидкість — лише по відчутному відрізку, інакше сусідні
  // квартали давали б безглузді значення.
  if (d > LEG_MIN_KM && dt > LEG_MIN_MS) {
    const legBrg = classes.bearing(last.ll, obs.ll);
    const legSpeed = d / (dt / 3_600_000);
    // якщо виміряна швидкість краще пасує іншому класу родини —
    // це він і є: «реактивний» летить утричі швидше за поршневий
    const fit = fitClass(track.type, legSpeed);
    if (fit && fit.type !== track.type) {
      track.typeVotes[fit.type] = (track.typeVotes[fit.type] || 0) + 1;
    }
    // згладжуємо: одна доповідь не повинна смикати трек
    track.bearing = track.bearing == null ? legBrg : smoothAngle(track.bearing, legBrg, 0.5);
    const raw = track.speed == null ? legSpeed : track.speed * 0.6 + legSpeed * 0.4;
    const nom = classes.get(track.type).speed;
    track.speed = Math.min(Math.max(raw, nom * SPEED_LO), nom * SPEED_HI);
    track.legsMeasured = (track.legsMeasured || 0) + 1;
  }

  // Мітку пересуваємо завжди: якщо доповіли «на Печерськ», ціль має
  // стояти на Печерську, а не там, де її бачили минулого разу. Раніше
  // всі райони Києва були в межах «тієї самої точки», і ціль назавжди
  // лишалась у центрі міста.
  if (d > MOVE_MIN_KM) {
    track.points.push({ ll: obs.ll, at: obs.at, place: obs.place });
    if (track.points.length > MAX_POINTS) track.points.shift();
  } else {
    last.at = obs.at;
    if (obs.place && !last.place) last.place = obs.place;
  }

  track.lastAt = Math.max(track.lastAt, obs.at);
  track.reports++;
  track.count = Math.max(track.count, obs.count || 1);
  for (const s of obs.sources) track.sources.add(s);
  track.typeVotes[obs.type] = (track.typeVotes[obs.type] || 0) + 1;
  // клас за більшістю доповідей, але «невідомий» ніколи не перемагає
  let best = track.type;
  let bestN = -1;
  for (const [tp, n] of Object.entries(track.typeVotes)) {
    if (tp === 'unknown') continue;
    if (n > bestN) { bestN = n; best = tp; }
  }
  track.type = best;
  if (obs.target) track.target = obs.target;
  if (obs.oblast) track.oblast = obs.oblast;
  if (obs.text) track.text = obs.text;
  if (obs.link) track.link = obs.link;
  if (obs.level === 'red') track.level = 'red';
  return track;
}

/** Плавний перехід між азимутами через 0°. */
function smoothAngle(a, b, w) {
  let diff = ((b - a + 540) % 360) - 180;
  return (a + diff * w + 360) % 360;
}

/* ─────────────── вхід ─────────────── */

/**
 * @param {Array} contacts сирі контакти монітора (з координатами)
 * @returns {number} скільки доповідей лягло у треки
 */
function ingest(contacts) {
  // від найстаріших до найновіших — ланцюг будується в часі
  const obs = [];
  for (const c of contacts) {
    const p = c.to || c.from;
    if (!p || !p.ll) continue;
    if (c.action === 'clear') continue;
    obs.push({
      at: c.at,
      type: c.type,
      ll: p.ll,
      place: p.n,
      target: c.to ? c.to.n : null,
      oblast: c.oblast || p.obl,
      count: c.count || 1,
      sources: c.sources || [c.channelName],
      text: c.text,
      link: c.link,
      action: c.action,
      level: c.level,
      site: c.site,
      key: c.id,
    });
  }
  obs.sort((a, b) => a.at - b.at);

  let linked = 0;
  for (const o of obs) {
    if (state.seen.has(o.key)) continue;
    state.seen.add(o.key);

    // Збиття — кінець треку, а не чергова точка. Знаходимо ціль, про
    // яку йдеться, прибираємо її з мапи й лишаємо позначку події.
    if (o.action === 'intercept') {
      let victim = null;
      let bestD = Infinity;
      for (const t of state.tracks.values()) {
        if (family(t.type) !== family(o.type)) continue;
        if (o.at - t.lastAt > 20 * 60_000) continue;
        const d = classes.distKm(t.points[t.points.length - 1].ll, o.ll);
        if (d < 35 && d < bestD) { bestD = d; victim = t; }
      }
      if (victim) state.tracks.delete(victim.id);
      state.intercepts.unshift({
        id: 'ix' + ++state.seq,
        at: o.at,
        ll: o.ll,
        place: o.place,
        oblast: o.oblast,
        type: victim ? victim.type : o.type,
        count: o.count || 1,
        sources: o.sources,
        text: o.text,
        link: o.link,
        matched: !!victim,
      });
      if (state.intercepts.length > 200) state.intercepts.length = 200;
      continue;
    }

    let best = null;
    let bestCost = Infinity;
    for (const t of state.tracks.values()) {
      const cost = matchCost(t, o);
      if (cost != null && cost < bestCost) { bestCost = cost; best = t; }
    }

    if (best) { extend(best, o); linked++; }
    else newTrack(o);
  }

  // прибираємо старі
  const cut = Date.now() - MAX_GAP_MS;
  for (const [id, t] of state.tracks) if (t.lastAt < cut) state.tracks.delete(id);
  const icut = Date.now() - INTERCEPT_TTL;
  state.intercepts = state.intercepts.filter((x) => x.at > icut);
  if (state.seen.size > 8000) state.seen = new Set([...state.seen].slice(-4000));

  return linked;
}

state.seen = new Set();

/* ─────────────── вихід ─────────────── */

/**
 * @param {number} ttlMs скільки трек лишається видимим без нових доповідей
 */
function snapshot(ttlMs) {
  const now = Date.now();
  const out = [];

  for (const t of state.tracks.values()) {
    const age = now - t.lastAt;
    if (age > ttlMs) continue;

    // одна пара точок — це ще не вимір: показуємо паспортну швидкість
    const measured = (t.legsMeasured || 0) >= 2 && t.speed;

    // Виміряна швидкість важить більше за формулювання каналу: якщо
    // ціль стабільно йде 550 км/год, це реактивний БпЛА, навіть коли
    // більшість доповідей написала просто «БпЛА».
    let type = t.type;
    if (measured) {
      const fit = fitClass(t.type, t.speed);
      if (fit) type = fit.type;
    }
    const def = classes.get(type);
    const speed = measured ? t.speed : def.speed;
    const last = t.points[t.points.length - 1];

    // числення шляху від останньої доповіді, але не більше 20 хв
    const leadH = Math.min(age, 20 * 60_000) / 3_600_000;
    const advanced = t.bearing != null ? speed * leadH : 0;
    const pos = advanced > 0.5 ? classes.destination(last.ll, t.bearing, advanced) : last.ll;

    // похибка росте з часом від доповіді
    const uncertaintyKm = Math.min(8 + advanced * 0.35, 60);

    // «курсом на X» означає, що ціль уже біля X, тож рахувати час до X
    // безглуздо. Корисне інше: куди вона дійде далі тим самим курсом.
    const ahead = cityAhead(pos, t.bearing, speed);

    out.push({
      id: t.id,
      type,
      label: def.label,
      pos,
      bearing: t.bearing,
      speed: Math.round(speed),
      speedMeasured: !!measured,
      count: t.count,
      place: last.place,
      target: t.target,
      oblast: t.oblast,
      etaMin: ahead ? ahead.etaMin : null,
      remainKm: ahead ? ahead.distanceKm : null,
      nextCity: ahead ? ahead.city : null,
      nextCityLL: ahead ? ahead.ll : null,
      nextOffDeg: ahead ? ahead.offDeg : null,
      uncertaintyKm: Math.round(uncertaintyKm),
      posAt: now, // час, до якого доведено положення — клієнт веде далі
      trajectory: t.points.map((p) => p.ll),
      legs: t.points.length,
      reports: t.reports,
      sources: [...t.sources],
      firstAt: t.firstAt,
      lastAt: t.lastAt,
      ageMin: age / 60_000,
      moving: t.bearing != null,
      text: t.text,
      link: t.link,
      action: t.action,
      level: t.level,
      site: t.site,
    });
  }

  return out.sort((a, b) => b.lastAt - a.lastAt);
}

function stats() {
  let moving = 0;
  for (const t of state.tracks.values()) if (t.bearing != null) moving++;
  const hourAgo = Date.now() - 3600_000;
  const recent = state.intercepts.filter((x) => x.at > hourAgo);
  return {
    total: state.tracks.size,
    moving,
    intercepts: state.intercepts.length,
    interceptedLastHour: recent.reduce((n, x) => n + (x.count || 1), 0),
  };
}

/** Збиття за останні хвилини — для мапи й журналу. */
function intercepts() {
  const cut = Date.now() - INTERCEPT_TTL;
  return state.intercepts.filter((x) => x.at > cut);
}

module.exports = { ingest, snapshot, stats, intercepts, setCities, cityAhead, _state: state };
