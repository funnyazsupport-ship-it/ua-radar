/**
 * Монітор публічних каналів оповіщення.
 *
 * Читає веб-дзеркала відкритих Telegram-каналів (t.me/s/<канал>) і розбирає
 * повідомлення на структуровані контакти: клас засобу ураження, місце, курс,
 * час. Це те саме джерело, на якому працюють публічні мапи-монітори.
 *
 * ЩО ЦЕ Є І ЧОГО НЕ Є:
 *   є    — реальні доповіді спостерігачів і офіційних каналів ПС ЗСУ;
 *   не є — радар. Між двома доповідями положення цілі ми не бачимо, а
 *          рахуємо (числення шляху) від останньої. Похибка росте з віком
 *          доповіді, і вона показується явно.
 */
'use strict';

const https = require('https');
const fs = require('fs');
const zlib = require('zlib');
const tracks = require('./tracks');

/**
 * trust: 3 — офіційне джерело, 2 — сталий моніторинговий канал, 1 — локальний.
 * scope: 'ua' — уся країна, 'kyiv' — Київ і область.
 * dflt: клас за замовчуванням для каналів, які пишуть «1х на Яготин» без
 *       назви засобу. Спрацьовує лише тоді, коли в тексті класу не видно.
 */
const CHANNELS = [
  { id: 'kpszsu', name: 'Повітряні Сили ЗСУ', trust: 3, scope: 'ua' },
  { id: 'air_alert_ua', name: 'Повітряна тривога', trust: 3, scope: 'ua' },
  { id: 'rozvidkaneba', name: 'Розвідка неба', trust: 2, scope: 'ua', dflt: 'shahed' },
  { id: 'ua_radar_raket', name: 'UA RADAR', trust: 2, scope: 'ua', dflt: 'shahed' },
  { id: 'monitorgwarr', name: 'Monitor War', trust: 2, scope: 'ua', dflt: 'shahed' },
  { id: 'monikppy', name: 'Моніка ППО', trust: 2, scope: 'ua', dflt: 'shahed' },
  { id: 'tryvoga_ua', name: 'Тривога UA', trust: 2, scope: 'ua', dflt: 'shahed' },
  { id: 'UkraineAlarmSignal', name: 'Тривога: сигнал', trust: 2, scope: 'ua' },
  // канали, які агрегують radarua та neptun — беремо першоджерело самі
  { id: 'kudy_letyt', name: 'Куди летить', trust: 2, scope: 'ua', dflt: 'shahed' },
  { id: 'raketa_trevoga', name: 'Ракетна тривога', trust: 2, scope: 'ua', dflt: 'shahed' },
  { id: 'radar_top_ua', name: 'Radar TOP UA', trust: 2, scope: 'ua', dflt: 'shahed' },
  { id: 'povitryanatrivogaaa', name: 'Повітряна тривога UA', trust: 2, scope: 'ua', dflt: 'shahed' },
  { id: 'UkraineRadar_24_7', name: 'Ukraine Radar 24/7', trust: 2, scope: 'ua', dflt: 'shahed' },
  { id: 'PhantomChe', name: 'Phantom (Чернігів)', trust: 2, scope: 'ua', dflt: 'shahed' },
  { id: 'horizon_of_war_Official', name: 'Horizon of War', trust: 2, scope: 'ua', dflt: 'shahed' },
  { id: 'sectorv666', name: 'Сектор V', trust: 2, scope: 'ua', dflt: 'shahed' },
  { id: 'rdsprostir', name: 'РДС Простір', trust: 2, scope: 'ua', dflt: 'shahed' },
  { id: 'eyes_everywhere_ua', name: 'Очі всюди', trust: 2, scope: 'ua', dflt: 'shahed' },
  { id: 'operatyvnohlep', name: 'Оперативно', trust: 1, scope: 'ua', dflt: 'shahed' },
  { id: 'shovnebi', name: 'Що в небі', trust: 2, scope: 'ua', dflt: 'shahed' },
  { id: 'Nablydatel_Dozor', name: 'Спостерігач', trust: 1, scope: 'ua', dflt: 'shahed' },
  { id: 'monitor1654', name: 'Монітор 1654', trust: 1, scope: 'ua', dflt: 'shahed' },
  { id: 'radar_dnipra', name: 'Радар Дніпра', trust: 1, scope: 'ua', dflt: 'shahed' },
  { id: 'kharkov_media', name: 'Харків медіа', trust: 1, scope: 'ua', dflt: 'shahed' },
  { id: 'kyiv_airdef', name: 'Київ ППО', trust: 1, scope: 'kyiv', dflt: 'shahed' },
  { id: 'Kievdenger', name: 'Kyiv Danger', trust: 1, scope: 'kyiv', dflt: 'shahed' },
  { id: 'war_monitor', name: 'Monitor', trust: 1, scope: 'kyiv', dflt: 'shahed' },
  { id: 'kyiv_nebo', name: 'Київ. Небо', trust: 1, scope: 'kyiv', dflt: 'shahed' },
  { id: 'nebo_raketa', name: 'Небо. Ракета', trust: 1, scope: 'kyiv', dflt: 'shahed' },
  { id: 'kyiv_vanek', name: 'Київський Ванек', trust: 1, scope: 'kyiv', dflt: 'shahed' },
  { id: 'kiev_levyy_bereg', name: 'Лівий берег', trust: 1, scope: 'kyiv', dflt: 'shahed' },
  { id: 'kiev_radar_truvoga_Vyshneve', name: 'Радар Вишневе', trust: 1, scope: 'kyiv', dflt: 'shahed' },
  { id: 'kievinform_ua1', name: 'Київ Інформ', trust: 1, scope: 'kyiv', dflt: 'shahed' },
  { id: 'kievreal1', name: 'Київ Реал', trust: 1, scope: 'kyiv', dflt: 'shahed' },
];

const MAX_CONTACTS = 600;
const MAX_MESSAGES = 300;
/** Скільки сирих доповідей тримаємо для зшивання в одну ціль. */
const CONTACT_TTL = 45 * 60_000;
/**
 * Ціль зникає з мапи, якщо її не згадують стільки часу. Під час атаки
 * канали повторюють активні цілі щохвилини, тож на мапі лишається тільки
 * те, про що говорять просто зараз.
 */
const MENTION_TTL = 2 * 60_000;
/** Пуск і зліт — подія, а не трек: її наслідок живе довше. */
const EVENT_TTL = 20 * 60_000;

/* ═══════════════ довідник місць ═══════════════ */

const AP = /['’ʼ`]/g;
const norm = (s) => s.toLowerCase().replace(AP, "'").replace(/\s+/g, ' ').trim();

/**
 * Латинські двійники кириличних літер. У каналах трапляється
 * «Полтaвщина» з латинською «a» — око не бачить, а пошук ламається.
 */
const HOMOGLYPH = { a: 'а', c: 'с', e: 'е', i: 'і', o: 'о', p: 'р', x: 'х', y: 'у', A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', I: 'І', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х' };

/**
 * Готує рядок до розбору: емодзі й стрілки відліплюються від назв,
 * «/р-н» прибирається, латинські двійники стають кирилицею.
 * Без цього «💥Кременчук» і «БПЛА→Харків» не знаходяться взагалі.
 */
function normalizeText(line) {
  let out = line
    .replace(/[←-⇿➔-➿]/g, ' → ')          // стрілки
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}️]/gu, ' ') // емодзі
    .replace(/\s*\/\s*р-?н\b/gi, ' ')                          // «Харків/р-н»
    .replace(/\bр-?н\b/gi, ' район ')
    .replace(/\s+/g, ' ')
    .trim();
  // латиниця всередині кириличного слова
  out = out.replace(/[А-Яа-яІіЇїЄєҐґ][A-Za-z]|[A-Za-z][А-Яа-яІіЇїЄєҐґ]/g, (m) =>
    m.replace(/[A-Za-z]/g, (c) => HOMOGLYPH[c] || c)
  );
  return out;
}

/** Основи слова: «Шостку» і «Шостка» дають спільну «шостк». */
/**
 * Відмінкові закінчення, які треба зрізати цілком: «над Броварами»,
 * «над Одесою», «у Сумах». Одна кінцева голосна тут не рятує.
 */
const ENDINGS = ['ами', 'ями', 'ові', 'еві', 'ими', 'ою', 'ею', 'ах', 'ях', 'ом', 'ем', 'ів', 'ей', 'ам', 'ям', 'их', 'им', 'ої', 'ій'];

function stems(name) {
  const base = norm(name);
  const out = new Set([base]);
  if (/[аяеєиіїоуюь]$/.test(base)) out.add(base.slice(0, -1));
  for (const e of ENDINGS) {
    if (base.length - e.length >= 3 && base.endsWith(e)) out.add(base.slice(0, -e.length));
  }
  // чергування і↔о, ї↔є у закритому складі: Харків→Харкова, Київ→Києва
  for (const v of [...out]) {
    const i = v.lastIndexOf('і');
    if (i > 0) out.add(v.slice(0, i) + 'о' + v.slice(i + 1));
    const j = v.lastIndexOf('ї');
    if (j > 0) out.add(v.slice(0, j) + 'є' + v.slice(j + 1));
  }
  return [...out].filter((s) => s.length >= 3);
}

/** Перейменування, яких ще немає в GeoNames. */
const RENAMED = [
  { n: 'Звягель', ll: [50.5936, 27.6222], obl: 'Житомирська область', pop: 55000 },
  { n: 'Самар', ll: [48.6333, 35.2333], obl: 'Дніпропетровська область', pop: 70000 },
  { n: 'Мирноград', ll: [48.3100, 37.2600], obl: 'Донецька область', pop: 48000 },
  { n: 'Горішні Плавні', ll: [49.0100, 33.6400], obl: 'Полтавська область', pop: 52000 },
];

let PLACES = [];
const PLACE_IDX = new Map();

function addPlace(p) {
  PLACES.push(p);
  for (const nm of p.alt || [p.n]) {
    for (const st of stems(nm)) {
      let arr = PLACE_IDX.get(st);
      if (!arr) PLACE_IDX.set(st, (arr = []));
      if (arr.length < 14) arr.push(p);
    }
  }
}

function loadPlaces(geonamesFile, kyivFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(geonamesFile, 'utf8'));
    for (const p of raw.places || []) addPlace(p);
  } catch (e) {
    console.warn('! довідник населених пунктів не завантажено:', e.message);
  }
  try {
    const raw = JSON.parse(fs.readFileSync(kyivFile, 'utf8'));
    // мікрорайони мають перемагати однойменні села: даємо велику "вагу"
    for (const p of raw.places || []) addPlace({ ...p, pop: 400000, obl: 'м. Київ', kyiv: 1 });
  } catch (e) {
    console.warn('! довідник Києва не завантажено:', e.message);
  }
  for (const p of RENAMED) addPlace({ ...p, alt: [p.n] });
  return PLACES.length;
}

/** Райони: «Харківський район» → центроїд полігона району. */
const RAION_IDX = new Map();

function loadRaions(file) {
  let fc;
  try {
    fc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn('! межі районів не завантажено:', e.message);
    return 0;
  }
  for (const f of fc.features || []) {
    const p = f.properties || {};
    if (!p.name || !p.centroid) continue;
    // «Харківський район» → ключ «харківськ»
    const adj = norm(p.name).replace(/\s*район.*$/, '');
    const key = adj.replace(/(ий|а|е)$/, '');
    const rec = { n: p.name, ll: [p.centroid[1], p.centroid[0]], obl: p.oblast, raion: true };
    if (!RAION_IDX.has(key)) RAION_IDX.set(key, []);
    RAION_IDX.get(key).push(rec);
  }
  return RAION_IDX.size;
}

/** Пошук району за прикметником із повідомлення. */
function findRaion(adj, oblast) {
  const key = norm(adj).replace(/(ий|а|е|ому|ого|ій|ої)$/, '');
  const arr = RAION_IDX.get(key);
  if (!arr || !arr.length) return null;
  if (oblast) {
    const hit = arr.find((r) => r.obl === oblast);
    if (hit) return hit;
  }
  return arr[0];
}

/** Відомі райони пуску — для повідомлень про зльоти й пуски. */
const LAUNCH_SITES = [
  { n: 'Саваслейка', ll: [55.46, 42.33], alt: ['Саваслейка', 'Саваслейки'], site: 1 },
  { n: 'Енгельс-2', ll: [51.48, 46.21], alt: ['Енгельс', 'Енгельса'], site: 1 },
  { n: 'Оленья', ll: [68.15, 33.46], alt: ['Оленья', 'Оленя', 'Оленегорськ'], site: 1 },
  { n: 'Шайковка', ll: [54.22, 34.30], alt: ['Шайковка', 'Шайковки'], site: 1 },
  { n: 'Дягилево', ll: [54.64, 39.57], alt: ['Дягилево', 'Рязань'], site: 1 },
  { n: 'Міллерово', ll: [48.92, 40.40], alt: ['Міллерово'], site: 1 },
  { n: 'Приморсько-Ахтарськ', ll: [46.05, 38.16], alt: ['Приморсько-Ахтарськ', 'Приморськ-Ахтарськ'], site: 1 },
  { n: 'мис Чауда', ll: [45.00, 35.83], alt: ['Чауда'], site: 1 },
  { n: 'Джанкой', ll: [45.71, 34.39], alt: ['Джанкой'], site: 1 },
  { n: 'Брянськ', ll: [53.25, 34.37], alt: ['Брянськ', 'Брянська', 'Брянщина'], site: 1 },
  { n: 'Курськ', ll: [51.73, 36.19], alt: ['Курськ', 'Курська', 'Курську', 'Курщина'], site: 1 },
  { n: 'Бєлгород', ll: [50.60, 36.59], alt: ['Бєлгород', 'Бєлгородщина', 'Белгород'], site: 1 },
  { n: 'Орел', ll: [52.97, 36.06], alt: ['Орел', 'Орла', 'Орлі', 'Орловщина', 'Орловська'], site: 1 },
  { n: 'Чорне море', ll: [44.10, 31.20], alt: ['Чорне море', 'Чорного моря', 'Чорному морі'], site: 1 },
  { n: 'Азовське море', ll: [46.30, 36.90], alt: ['Азовське море', 'Азовського моря'], site: 1 },
  { n: 'Каспійське море', ll: [42.50, 50.00], alt: ['Каспійське море', 'Каспійського моря', 'Каспій'], site: 1 },
];

function loadSites() {
  for (const s of LAUNCH_SITES) addPlace({ ...s, pop: 0, obl: null });
}

/**
 * Прикметники областей і районів («Житомирська», «Богодухівський»).
 * Сервер віддає сюди назви районів із API тривог, бо інакше «Житомирщина»
 * ловиться на однойменне село «Житомирське».
 */
const ADMIN_WORDS = new Set();

function setAdminWords(names) {
  for (const raw of names) {
    const first = norm(raw).split(' ')[0];
    if (first.length < 5) continue;
    const m = first.match(/^(.*?)(ський|ська|ське|цький|цька|цьке|зький|зька|зьке)$/);
    if (!m) continue; // «Харків» — це місто, а не прикметник району
    ADMIN_WORDS.add(first);
    const suffix = m[2].replace(/(ий|а|е)$/, '');
    for (const end of ['ий', 'а', 'е']) ADMIN_WORDS.add(m[1] + suffix + end);
  }
  return ADMIN_WORDS.size;
}

/** Чи є слово адміністративним прикметником, а не назвою міста. */
function isAdminWord(w) {
  const t = norm(w);
  if (ADMIN_WORDS.has(t)) return true;
  // «Житомирщина» → «житомирська»
  const m = t.match(/^(.*?)(щина|щини|щині)$/);
  if (m) return ADMIN_WORDS.has(m[1] + 'ська') || ADMIN_WORDS.has(m[1] + 'цька');
  return false;
}

/** Розмовні назви областей. */
const OBLAST_COLLOQUIAL = {
  'вінниччин': 'Вінницька область', 'волин': 'Волинська область',
  'дніпропетровщин': 'Дніпропетровська область', 'донеччин': 'Донецька область',
  'житомирщин': 'Житомирська область', 'закарпатт': 'Закарпатська область',
  'запоріжж': 'Запорізька область', 'івано-франківщин': 'Івано-Франківська область',
  'прикарпатт': 'Івано-Франківська область', 'київщин': 'Київська область',
  'кіровоградщин': 'Кіровоградська область', 'луганщин': 'Луганська область',
  'львівщин': 'Львівська область', 'миколаївщин': 'Миколаївська область',
  'одещин': 'Одеська область', 'полтавщин': 'Полтавська область',
  'рівненщин': 'Рівненська область', 'сумщин': 'Сумська область',
  'тернопільщин': 'Тернопільська область', 'харківщин': 'Харківська область',
  'херсонщин': 'Херсонська область', 'хмельниччин': 'Хмельницька область',
  'черкащин': 'Черкаська область', 'буковин': 'Чернівецька область',
  'чернівеччин': 'Чернівецька область', 'чернігівщин': 'Чернігівська область',
};

const OBLAST_FULL = [
  'Вінницька', 'Волинська', 'Дніпропетровська', 'Донецька', 'Житомирська',
  'Закарпатська', 'Запорізька', 'Івано-Франківська', 'Київська', 'Кіровоградська',
  'Луганська', 'Львівська', 'Миколаївська', 'Одеська', 'Полтавська', 'Рівненська',
  'Сумська', 'Тернопільська', 'Харківська', 'Херсонська', 'Хмельницька',
  'Черкаська', 'Чернівецька', 'Чернігівська',
];

function oblastFromText(text) {
  const t = norm(text);
  for (const [key, name] of Object.entries(OBLAST_COLLOQUIAL)) {
    if (t.includes(key)) return name;
  }
  for (const base of OBLAST_FULL) {
    const b = norm(base).slice(0, -1); // без закінчення: «харківськ»
    if (t.includes(b) && /обл|област/.test(t)) return base + ' область';
  }
  if (/^київ$|\bм\.?\s*київ|у києві|над києвом|києва\b|по києву/.test(t)) return 'м. Київ';
  return null;
}

/** «з Запорізької області» — це звідки летить, а не де зараз ціль. */
function oblastIsOrigin(line, oblastName) {
  if (!oblastName) return false;
  const stem = norm(oblastName).replace(' область', '').slice(0, -1);
  return new RegExp('(?:^|\\s)(?:з|із|від)\\s+' + stem).test(norm(line));
}

/**
 * Нещодавно згадані точки. Повітряна обстановка просторово звʼязна:
 * якщо назва неоднозначна, правильний варіант майже завжди поруч із
 * тим, про що вже доповідали.
 */
const RECENT = [];
const RECENT_TTL = 25 * 60_000;

function rememberPlace(ll, at) {
  RECENT.push({ ll, at });
  if (RECENT.length > 200) RECENT.splice(0, RECENT.length - 200);
}

function nearRecent(ll, now) {
  let best = Infinity;
  for (const r of RECENT) {
    if (now - r.at > RECENT_TTL) continue;
    const d = distKm(ll, r.ll);
    if (d < best) best = d;
  }
  return best;
}

/** Тимчасово окуповані регіони. */
const OCCUPIED = new Set(['АР Крим', 'Севастополь']);

/**
 * Пошук місця за словом із повідомлення.
 * @param {string} token   слово, можливо у непрямому відмінку
 * @param {string?} oblast контекст області — знімає омонімію сіл
 * @param {boolean} kyivCtx канал київський — надаємо перевагу мікрорайонам
 */
function findPlace(token, oblast, kyivCtx, preferSite, occCtx) {
  const key = norm(token);
  const seen = new Set();
  const cands = [];
  const add = (arr) => {
    for (const p of arr || []) {
      if (seen.has(p)) continue;
      seen.add(p);
      cands.push(p);
    }
  };
  add(PLACE_IDX.get(key));
  for (const st of stems(token)) add(PLACE_IDX.get(st));
  if (!cands.length) return null;

  /** Скільки літер збігається на початку слова й назви. */
  const prefixLen = (a, b) => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  };

  let best = null;
  let bestScore = -Infinity;
  for (const p of cands) {
    let score = Math.log10(Math.max(p.pop, 1) + 1);
    if (oblast && p.obl === oblast) score += 8; // контекст важливіший за розмір
    if (p.kyiv && kyivCtx) score += 6;
    // «Харківський масив» — київський мікрорайон; у повідомленні про
    // Харківщину його бути не може
    if (p.kyiv && oblast && oblast !== 'м. Київ' && oblast !== 'Київська область') continue;
    if (p.adm) score += 1.5;
    // у повідомленні про пуск «з Курська» йдеться про район пуску,
    // а не про однойменне село
    if (p.site) score += preferSite ? 14 : 4;

    // Крим — район пуску, а не місце, куди доповідають проліт цілей.
    // Без цього «Привітне» (15 однойменних сіл) прилітає в Крим просто
    // тому, що тамтешнє — найбільше.
    if (OCCUPIED.has(p.obl)) score += occCtx ? 4 : -7;

    // просторова звʼязність: правильний варіант поруч із тим, про що
    // вже доповідали останні хвилини
    if (!oblast && p.ll) {
      const d = nearRecent(p.ll, Date.now());
      if (d < 120) score += 5;
      else if (d < 250) score += 2;
      else if (d < 1e9) score -= 1;
    }
    if (score > bestScore) { bestScore = score; best = p; }
  }

  // Правило чергування і↔о потрібне для «Харкова» → Харків, але воно
  // ж перетворює «блін» на «блон» і знаходить безлюдне село Блоне.
  // Якщо початок слова майже не збігається з назвою, збіг слабкий —
  // приймаємо його лише для помітних населених пунктів.
  if (best) {
    const maxPrefix = Math.max(...best.alt.map((a) => prefixLen(key, norm(a))));
    if (maxPrefix < 4 && best.pop < 1000 && !best.adm && !best.site && !best.kyiv) return null;
  }
  return best;
}

/* ═══════════════ класифікація ═══════════════ */

const TYPE_RULES = [
  [/балісти|іскандер-м|iskander|kn-?23|кн-?23|9м723|квазібалісти/i, 'ballistic'],
  [/кинджал|кинжал|міг-?31|миг-?31|mig-?31|аеробалісти/i, 'aeroballistic'],
  [/х-?22|х-?32|ту-?22/i, 'kh22'],
  [/х-?101|х-?555|ту-?95|ту-?160|стратегічн\w*\s+авіац/i, 'cruise_air'],
  [/калібр|kalibr|з акваторі|носі[йї]|надводн|підводн|корабел/i, 'cruise_sea'],
  [/іскандер-к/i, 'cruise_ground'],
  [/реактивн|(?<![а-яіїєґa-z])реактив(?![а-яіїєґa-z])|герань-?3|shahed-?238|рбпла|рпбла/i, 'shahed_jet'],
  [/шахед|shahed|герань|geran|бандерол|мопед|ударн\w*\s+бпла/i, 'shahed'],
  // \b у JS рахує межу слова лише для латиниці, тому для кирилиці
  // потрібні явні перевірки сусідніх літер
  [/(?<![а-яіїєґa-z])каб(?:ів|и|ами|ом|у|а)?(?![а-яіїєґa-z])|умпк|авіабомб|керован\w*\s+авіаційн/i, 'kab'],
  [/с-?300|с-?400|(?<![а-яіїєґa-z])зрк(?![а-яіїєґa-z])/i, 'sam'],
  [/розвідувальн\w*\s+бпла|орлан|zala|суперкам|supercam|ланцет/i, 'recon_uav'],
  [/крилат\w*\s+ракет|(?<![а-яіїєґa-z])кр(?![а-яіїєґa-z])/i, 'cruise_air'],
  [/бпла|дрон|безпілотн|🛸/i, 'shahed'],
  [/ракетн\w*\s+небезпек|ракет/i, 'missile'],
  // кольорові коди каналів тривог: червоний — ракетна небезпека,
  // жовтий — загроза БпЛА
  [/🔴/, 'missile'],
  [/🟡/, 'shahed'],
];

function detectType(text) {
  for (const [re, type] of TYPE_RULES) if (re.test(text)) return type;
  return null;
}

const ACTION_RULES = [
  // Збиття — окрема подія, а не просто зникнення цілі. Має стояти
  // перед «відбоєм»: у повідомленні часто є і те, й інше.
  [/збит|збил|знищ|уражено ц|ліквідов|мінус\s*\d|роботу ппо по ц/i, 'intercept'],
  // «чисто», «чисте небо», «цілей немає» — це відбій, а не ціль.
  // Правило має стояти першим: у «Біля Києва наразі чисто» слово «біля»
  // інакше дає курс, і повідомлення про відсутність загрози
  // перетворюється на загрозу.
  [/відбій|🟢|(?<![а-яіїєґa-z])чисто(?![а-яіїєґa-z])|чисте небо|без ц[іi]лей|ц[іi]лей нема|нема[є]? ц[іi]лей|ц[іi]ль знято|зникл/i, 'clear'],
  [/зліт|злет[ії]|знялис|піднял/i, 'takeoff'],
  [/пуск|запуск|стартув/i, 'launch'],
  [/вибух|приліт|прильот|влучанн|уражен|падає|впав/i, 'impact'],
  [/курс|напрям|прямує|повз|рухаєт|заход|манервр|маневр|кружля|над\s|біля\s/i, 'course'],
  [/загроза|небезпека|увага|тривога|🔴|🟡/i, 'threat'],
];

function detectAction(text) {
  for (const [re, action] of ACTION_RULES) if (re.test(text)) return action;
  return 'report';
}

/**
 * Рівень тривоги за конвенцією каналів оповіщення:
 * червоний — ракетна небезпека, жовтий — загроза БпЛА, зелений — відбій.
 */
function detectLevel(text) {
  if (/🔴|червоний рівень|ракетна небезпека/i.test(text)) return 'red';
  if (/🟡|жовтий рівень|🛸/i.test(text)) return 'yellow';
  if (/🟢|відбій/i.test(text)) return 'clear';
  return null;
}

const DIR_TO = [
  [/у п[іi]вн[іi]чно-сх[іi]дному напрямку/i, 45],
  [/у п[іi]вн[іi]чно-зах[іi]дному напрямку/i, 315],
  [/у п[іi]вденно-сх[іi]дному напрямку/i, 135],
  [/у п[іi]вденно-зах[іi]дному напрямку/i, 225],
  [/у п[іi]вн[іi]чному напрямку|на п[іi]вн[іi]ч\b/i, 0],
  [/у п[іi]вденному напрямку|на п[іi]вдень\b/i, 180],
  [/у сх[іi]дному напрямку|на сх[іi]д\b/i, 90],
  [/у зах[іi]дному напрямку|на зах[іi]д\b/i, 270],
];
const DIR_FROM = [
  [/з п[іi]вн[іi]чного сходу/i, 225],
  [/з п[іi]вн[іi]чного заходу/i, 135],
  [/з п[іi]вденного сходу/i, 315],
  [/з п[іi]вденного заходу/i, 45],
  [/з п[іi]вноч[іi]\b/i, 180],
  [/з п[іi]вдня\b/i, 0],
  [/з[іi]?\s+сходу\b/i, 270],
  [/[зi]з?\s+заходу\b/i, 90],
];

function detectHeading(text) {
  for (const [re, deg] of DIR_TO) if (re.test(text)) return deg;
  for (const [re, deg] of DIR_FROM) if (re.test(text)) return deg;
  return null;
}

/** Рекламні, новинні та ретроспективні рядки — не обстановка. */
const NOISE = /підписат|підписка|надіслати новину|наш канал|реклама|партнер|https?:\/\/|@[a-z_]{4,}|синоптик|заморозк|погод|мінекономіки|повідом|за даними|зазначи|розповів|заявив|цієї ночі|минулої ночі|вчора|учора|зазнал|пошкоджен|внаслідок|унаслідок|за словами/i;

/**
 * Атрибуція новини: «…, — Мінекономіки». Правило чутливе до регістру
 * НАВМИСНО: з прапорцем /i клас [А-ЯІЇЄ] ловить і малі літери, і тоді
 * будь-який рядок із тире («Прилуцький район — повітряна тривога»)
 * вважається новиною і викидається. Саме через це половина каналів мовчали.
 */
const NOISE_ATTRIB = /,\s*[—–]\s*[А-ЯІЇЄҐ]/;

const STOP = new Set([
  'бпла', 'дрон', 'дрони', 'ракета', 'ракети', 'курсом', 'курс', 'напрямку', 'напрямок',
  'повз', 'через', 'між', 'реактивний', 'реактивні', 'реактивних', 'загроза', 'небезпека',
  'увага', 'уважно', 'обережно', 'район', 'районі', 'районам', 'області', 'область', 'обл',
  'укриття', 'тривоги', 'тривога', 'відбій', 'рівень', 'жовтий', 'червоний', 'зелений',
  'прямуйте', 'будьте', 'обережні', 'схід', 'захід', 'північ', 'південь', 'сході', 'заході',
  'півночі', 'півдні', 'сектор', 'застосування', 'перейдіть', 'станом', 'зараз', 'особлива',
  'нові', 'новий', 'ще', 'один', 'два', 'три', 'над', 'біля', 'цим', 'знову', 'далі',
  'кияни', 'киян', 'киянам', 'групи', 'група', 'груп', 'треш', 'увага',
  // вигуки й звертання: з великої літери на початку речення вони
  // невідрізнимі від назви села
  'блін', 'блть', 'бляха', 'добре', 'гаразд', 'слухайте', 'слухай', 'народ',
  'люди', 'друзі', 'шановні', 'панове', 'хлопці', 'дівчата', 'схоже', 'схоже,',
  'здається', 'можливо', 'ймовірно', 'нарешті', '知', 'так', 'ні', 'ок', 'окей',
  'дякую', 'вибачте', 'перепрошую', 'отже', 'тобто', 'коротше', 'капець',
  'жесть', 'ого', 'ага', 'ну', 'от', 'ось', 'тут', 'там', 'зараз', 'потім',
]);

/**
 * Витягує місця з фрагмента. «повз X на Y» → from=X, to=Y.
 */
/** Київські мікрорайони можуть мати «адміністративні» назви — їх не чіпаємо. */
function hasKyivName(w) {
  const arr = PLACE_IDX.get(norm(w));
  return !!(arr && arr.some((p) => p.kyiv));
}

function extractPlaces(seg, oblastCtx, kyivCtx, preferSite) {
  const res = { from: null, to: null, mentions: [] };
  // явна згадка Криму знімає штраф на кримські назви
  const occCtx = /крим|севастопол|джанко|чауд|сімферопол|феодос|керч|євпатор/i.test(seg) ||
    (oblastCtx && OCCUPIED.has(oblastCtx));

  // «Повітряна тривога в Харківський район» — найпоширеніший формат
  // офіційних каналів оповіщення. Без цього такі повідомлення
  // відкидались повністю, хоча несуть рівень тривоги по району.
  const rm = seg.match(/([А-ЯІЇЄҐ][а-яіїєґ'’\-]+(?:ськ|цьк|зьк)[а-яіїєґ]{0,3})\s+район/);
  if (rm) {
    const r = findRaion(rm[1], oblastCtx);
    if (r) {
      res.to = r;
      res.mentions.push(r);
      return res;
    }
  }

  const words = seg.replace(/[«»"(),;!?:.]/g, ' ').split(/\s+/).filter(Boolean);

  const hasRaion = /район|громад/i.test(seg);
  const tryAt = (i) => {
    for (const len of [3, 2, 1]) {
      if (i + len > words.length) continue;
      if (!/^[А-ЯІЇЄҐ]/.test(words[i])) continue;
      if (STOP.has(norm(words[i]))) continue;
      // «Лозівський район», «Житомирська область» — адміністративна
      // одиниця, а не населений пункт
      if (len === 1 && isAdminWord(words[i]) && !hasKyivName(words[i])) continue;
      // «південний схід» — напрямок, хоча Південний є і містом-портом
      if (
        len === 1 &&
        /^(південн|північн|східн|західн|центральн)/i.test(words[i]) &&
        /(схід|захід|напрям)/i.test(words[i + 1] || '')
      ) continue;
      if (hasRaion && len === 1 && /(ський|цький|зький)$/i.test(words[i])) continue;
      const chunk = words.slice(i, i + len).join(' ');
      const p = findPlace(chunk, oblastCtx, kyivCtx, preferSite, occCtx);
      if (p) return { place: p, len };
    }
    return null;
  };

  for (let i = 0; i < words.length; i++) {
    const hit = tryAt(i);
    if (!hit) continue;
    const b1 = norm(words[i - 1] || '');
    const b2 = norm(words[i - 2] || '');
    let marker = 'mention';
    if (b1 === 'на' || b1 === 'до') marker = b2 === 'курсом' || b2 === 'курс' ? 'to' : 'to';
    else if (b1 === 'повз' || b1 === 'від' || b1 === 'з' || b1 === 'із') marker = 'from';
    else if (b1 === 'над' || b1 === 'біля' || b1 === 'поблизу' || b1 === 'районі') marker = 'over';

    if (marker === 'to' && !res.to) res.to = hit.place;
    else if (marker === 'from' && !res.from) res.from = hit.place;
    else if (marker === 'over' && !res.from) res.from = hit.place;
    res.mentions.push(hit.place);
    i += hit.len - 1;
  }

  if (!res.from && !res.to && res.mentions.length) res.to = res.mentions[0];
  return res;
}

/* ═══════════════ читання каналу ═══════════════ */

function fetchText(url, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        timeout,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ua-radar/1.0; civil-defence map)',
          'Accept-Language': 'uk,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        stream.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function stripHtml(s) {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#33;/g, '!')
    .replace(/&#036;/g, '$')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

function parseChannelHtml(html, ch) {
  const out = [];
  const blocks = html.split('<div class="tgme_widget_message_wrap');
  for (const b of blocks.slice(1)) {
    const idm = b.match(/data-post="([^"]+)"/);
    const tm = b.match(/datetime="([^"]+)"/);
    const txm = b.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<div class="tgme_widget_message_|<\/div>)/);
    if (!idm || !tm || !txm) continue;

    // Пости з фото/відео — це зазвичай зведені картинки за добу або
    // кадри наслідків. Підпис до них виглядає як доповідь, але описує
    // не поточну обстановку, тож такі повідомлення пропускаємо.
    if (/tgme_widget_message_(?:photo_wrap|video|document|sticker|roundvideo)/.test(b)) continue;
    const text = stripHtml(txm[1]);
    if (!text) continue;
    const at = Date.parse(tm[1]);
    if (!Number.isFinite(at)) continue;
    out.push({
      key: `${ch.id}:${idm[1]}`,
      channel: ch.id,
      channelName: ch.name,
      trust: ch.trust,
      scope: ch.scope,
      dflt: ch.dflt || null,
      at,
      text,
      link: `https://t.me/${idm[1]}`,
    });
  }
  return out;
}

/* ═══════════════ повідомлення → контакти ═══════════════ */

/** «Київщина: 1х на Ржищів, 1х на Яготин» → кілька контактів. */
function splitSegments(line) {
  return line
    .replace(/територіальн\w*\s+громад\w*/gi, ' ')
    .split(/[,;\/]|\s\+\s|\sта\s|\sі\s/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

/** «1х на Яготин», «3 реактивних на Дніпро», «2× над Києвом». */
function extractCount(seg) {
  const m1 = seg.match(/(\d+)\s*(?:[хx×]|шт)\b/i);
  if (m1) return Math.min(Number(m1[1]), 99);
  const m2 = seg.match(/(?:^|\s)(\d+)\s+(?:реактивн|бпла|дрон|шахед|ракет|ціл|бандерол|мопед)/i);
  if (m2) return Math.min(Number(m2[1]), 99);
  return 1;
}

function messageToContacts(msg) {
  const contacts = [];
  const kyivCtx = msg.scope === 'kyiv';
  const msgType = detectType(msg.text);
  const lines = msg.text.split('\n').map((l) => l.trim()).filter(Boolean);
  let ctx = kyivCtx ? 'м. Київ' : null;

  for (const rawLine0 of lines) {
    if (NOISE.test(rawLine0) || NOISE_ATTRIB.test(rawLine0)) continue;
    const rawLine = normalizeText(rawLine0);
    if (!rawLine) continue;

    // заголовок області: «Київщина:» / «Дніпропетровська область:»
    const headMatch = rawLine.match(/^([^:]{4,40}):\s*(.*)$/);
    let line = rawLine;
    if (headMatch) {
      const asOblast = oblastFromText(headMatch[1]);
      if (asOblast) {
        ctx = asOblast;
        line = headMatch[2];
        if (!line) continue;
      }
    }

    const inLineOblast = oblastFromText(line);
    // «курсом на Томаківку з Запорізької області» — область тут джерело,
    // а не місце цілі, тож контекст заголовка лишається чинним
    const originOblast = oblastIsOrigin(line, inLineOblast) ? inLineOblast : null;
    const lineOblast = (originOblast ? ctx : inLineOblast) || ctx;
    const lineType = detectType(line) || msgType;
    const lineAction = detectAction(line);
    const lineLevel = detectLevel(line) || detectLevel(msg.text);
    const heading = detectHeading(line);

    // «→Трипілля/Обухів/Київ» — це один маршрут, а не три різні цілі:
    // перше місце — де бачили, останнє — куди йде
    const routeM = line.match(/[→➡]\s*([^.;!?]+)/);
    if (routeM && routeM[1].includes('/')) {
      const parts = routeM[1].split('/').map((x) => x.trim()).filter(Boolean);
      const hits = parts.map((x) => extractPlaces(x, lineOblast, kyivCtx)).map((r) => r.to || r.from).filter(Boolean);
      if (hits.length >= 2) {
        contacts.push({
          id: `${msg.key}#${contacts.length}`,
          at: msg.at,
          channel: msg.channel,
          channelName: msg.channelName,
          trust: msg.trust,
          link: msg.link,
          text: line.slice(0, 200),
          type: lineType || msg.dflt || 'unknown',
          action: 'course',
          count: extractCount(line),
          oblast: lineOblast,
          level: lineLevel,
          from: { n: hits[0].n, ll: hits[0].ll, obl: hits[0].obl },
          to: { n: hits[hits.length - 1].n, ll: hits[hits.length - 1].ll, obl: hits[hits.length - 1].obl },
          site: null,
          heading,
        });
        continue;
      }
    }

    for (const seg of splitSegments(line)) {
      const type = detectType(seg) || lineType || msg.dflt || null;
      const segAction = detectAction(seg);
      let action = segAction === 'report' ? lineAction : segAction;
      const isLaunchWord = /пуск|зліт|злет|старт/i.test(seg) || /пуск|зліт|злет|старт/i.test(line);
      const places = extractPlaces(seg, lineOblast, kyivCtx, isLaunchWord);
      const anchor = places.to || places.from;

      // без класу засобу і без місця контакт не несе інформації
      if (!type && !anchor) continue;
      if (!anchor && !lineOblast) continue;
      // «пуски продовжуються постійно» — коментар, а не доповідь про пуск
      if ((action === 'launch' || action === 'takeoff') && !anchor) continue;

      // «на Дніпро з півдня» — про курс сказано напрямком, а не словом
      if (action === 'report' && (places.to || heading != null)) action = 'course';

      const isSite = !!(anchor && anchor.site);

      // Сумнівний розбір — це коли в сегменті немає ЖОДНОЇ опори:
      // ні назви засобу, ні кількості, ні прийменника напрямку, а
      // знайдене місце — крихітне село. Саме так «Блін…» ставало
      // ціллю. Звичайні формати («1х на Яготин», «БпЛА на Ніжин»,
      // «Бровари») опори мають і йдуть на мапу одразу.
      const typedHere = !!detectType(seg);
      const hasMarker = /\d|(^|\s)(на|повз|над|до|біля|поблизу|курс|курсом|від)(\s|$)|→/i.test(seg);
      const tinyPlace = !!(anchor && !anchor.site && !anchor.raion && (anchor.pop || 0) < 5000);
      const weak = !typedHere && !hasMarker && tinyPlace;

      contacts.push({
        id: `${msg.key}#${contacts.length}`,
        at: msg.at,
        channel: msg.channel,
        channelName: msg.channelName,
        trust: msg.trust,
        link: msg.link,
        text: seg.slice(0, 200),
        type: type || 'unknown',
        // пуск/зліт із відомого полігона — це подія старту, а не проліт
        action: isSite && (action === 'course' || action === 'report') ? 'launch' : action,
        count: extractCount(seg),
        oblast: lineOblast,
        level: lineLevel,
        from: places.from ? { n: places.from.n, ll: places.from.ll, obl: places.from.obl } : null,
        to: places.to ? { n: places.to.n, ll: places.to.ll, obl: places.to.obl } : null,
        site: isSite ? anchor.n : null,
        heading,
        weak,
      });

      if (anchor && anchor.ll && !anchor.site) rememberPlace(anchor.ll, msg.at);
      if (contacts.length > 40) return contacts; // захист від патологічних постів
    }
  }

  return contacts;
}

/* ═══════════════ згортання дублів ═══════════════ */

const R = 6371;
const rad = (d) => (d * Math.PI) / 180;
function distKm(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Одну й ту саму ціль бачать кілька каналів. Зводимо в один контакт:
 * лишаємо доповідь із найбільшою довірою, решту рахуємо як підтвердження.
 */
function cluster(contacts) {
  const out = [];
  // від найстаріших до найновіших: так lastSeen наростає природно
  for (const c of contacts.slice().sort((a, b) => a.at - b.at)) {
    const pos = (c.to || c.from || {}).ll;
    const hit = out.find((o) => {
      if (o.type !== c.type) return false;
      if (o.action !== c.action) return false;
      // одну ціль ведуть кілька каналів із різним запізненням
      if (c.at - o.lastSeen > 12 * 60_000) return false;
      const opos = (o.to || o.from || {}).ll;
      if (pos && opos) return distKm(pos, opos) < 6;
      return !pos && !opos && o.oblast === c.oblast;
    });

    if (!hit) {
      out.push({ ...c, sources: [c.channelName], confirms: 1, firstAt: c.at, lastSeen: c.at });
      continue;
    }

    hit.confirms++;
    hit.lastSeen = Math.max(hit.lastSeen, c.at);
    if (!hit.sources.includes(c.channelName)) hit.sources.push(c.channelName);
    hit.count = Math.max(hit.count, c.count);
    // свіжіша доповідь важливіша за довіру: положення береться з неї
    if (c.at > hit.at || (c.at === hit.at && c.trust > hit.trust)) {
      const keep = { sources: hit.sources, confirms: hit.confirms, firstAt: hit.firstAt, lastSeen: hit.lastSeen };
      Object.assign(hit, c, keep);
    }
    if (!hit.to && c.to) hit.to = c.to;
    if (!hit.from && c.from) hit.from = c.from;
    if (hit.heading == null && c.heading != null) hit.heading = c.heading;
    if (c.level === 'red') hit.level = 'red'; // вищий рівень перемагає
    else if (!hit.level && c.level) hit.level = c.level;
  }
  return out;
}

/* ═══════════════ стан ═══════════════ */

const state = {
  contacts: [],
  messages: [],
  seen: new Set(),
  lastFetch: 0,
  errors: {},
  stats: {},
  // рядки, з яких правила нічого не витягли — черга для ШІ
  unparsed: [],
  // сумнівні контакти, які чекають на перевірку моделлю
  quarantine: [],
};

/** Чи вмикати перевірку моделлю. Без неї сумнівні йдуть одразу. */
let reviewEnabled = false;
function setReviewEnabled(on) {
  reviewEnabled = !!on;
}

/** Скільки контакт чекає на вирок, перш ніж його пустять без нього. */
const REVIEW_WAIT = 90_000;

/** Рядок схожий на доповідь про обстановку, але правила його не взяли. */
function looksOperational(text) {
  return /бпла|дрон|шахед|ракет|ціл|курс|повітр|тривог|вибух|збит|пуск|зліт|кааб|каб\b/i.test(text);
}

async function poll() {
  // читаємо партіями, щоб не бити в t.me сімнадцятьма запитами водночас
  const batches = [];
  for (let i = 0; i < CHANNELS.length; i += 8) batches.push(CHANNELS.slice(i, i + 8));

  let fresh = 0;
  for (const batch of batches) {
    const res = await Promise.allSettled(
      batch.map(async (ch) => ({ ch, html: await fetchText(`https://t.me/s/${ch.id}`) }))
    );
    for (let i = 0; i < res.length; i++) {
      const r = res[i];
      const ch = batch[i];
      if (r.status === 'rejected') {
        state.errors[ch.id] = (r.reason && r.reason.message) || 'помилка';
        continue;
      }
      delete state.errors[ch.id];
      let msgs = [];
      try {
        msgs = parseChannelHtml(r.value.html, ch);
      } catch (e) {
        state.errors[ch.id] = e.message;
        continue;
      }
      state.stats[ch.id] = msgs.length;
      for (const m of msgs) {
        if (state.seen.has(m.key)) continue;
        state.seen.add(m.key);
        state.messages.unshift(m);
          const got = messageToContacts(m);
        for (const c of got) {
          if (c.weak && reviewEnabled) {
            state.quarantine.push({ c, at: Date.now() });
            continue;
          }
          state.contacts.unshift(c);
          fresh++;
        }
        // нічого не вийшло, але текст схожий на обстановку — у чергу ШІ
        if (!got.length && looksOperational(m.text) && m.text.length < 400) {
          state.unparsed.unshift({ key: m.key, at: m.at, channel: m.channelName, text: m.text, link: m.link, scope: m.scope });
          if (state.unparsed.length > 120) state.unparsed.length = 120;
        }
      }
    }
  }

  const cut = Date.now() - CONTACT_TTL;
  state.contacts = state.contacts.filter((c) => c.at > cut).slice(0, MAX_CONTACTS);
  // сирі доповіді зшиваємо в траєкторії: одна ціль — один трек
  tracks.ingest(state.contacts);
  state.messages = state.messages.sort((a, b) => b.at - a.at).slice(0, MAX_MESSAGES);
  if (state.seen.size > 6000) state.seen = new Set([...state.seen].slice(-3000));
  state.lastFetch = Date.now();
  return fresh;
}

function snapshot() {
  const now = Date.now();
  const live = state.contacts.filter((c) => c.at > now - CONTACT_TTL);
  const clustered = cluster(live);

  // ціль лишається на мапі, доки її згадують; пуск живе довше
  const shown = clustered.filter((c) => {
    const ttl = c.action === 'launch' || c.action === 'takeoff' ? EVENT_TTL : MENTION_TTL;
    return now - c.lastSeen <= ttl;
  });

  const trackList = tracks.snapshot(MENTION_TTL);
  const interceptList = tracks.intercepts();

  return {
    ts: state.lastFetch,
    serverNow: now,
    mentionTtl: MENTION_TTL,
    tracks: trackList,
    intercepts: interceptList,
    unparsed: state.unparsed.slice(0, 40).map((x) => ({ at: x.at, channel: x.channel, text: x.text, link: x.link })),
    quarantine: state.quarantine.length,
    trackStats: tracks.stats(),
    channels: CHANNELS.map((c) => ({ id: c.id, name: c.name, scope: c.scope, trust: c.trust, msgs: state.stats[c.id] || 0, error: state.errors[c.id] || null })),
    contacts: shown.sort((a, b) => b.lastSeen - a.lastSeen),
    tracked: clustered.length,
    raw: live.length,
    messages: state.messages.slice(0, 80).map((m) => ({
      at: m.at, channel: m.channel, channelName: m.channelName,
      text: m.text.slice(0, 500), link: m.link,
    })),
  };
}

/** Сумнівні контакти на перевірку. */
function takeForReview(limit) {
  const out = state.quarantine.filter((q) => !q.sent).slice(0, limit);
  for (const q of out) q.sent = true;
  return out.map((q) => ({
    id: q.c.id,
    text: q.c.text,
    place: q.c.to ? q.c.to.n : q.c.from ? q.c.from.n : null,
    type: q.c.type,
    action: q.c.action,
  }));
}

/**
 * Вирок моделі: {id: true|false}. Схвалені йдуть на мапу, відхилені
 * зникають. Якщо модель мовчить — випускаємо самі, бо правила їх
 * уже прийняли.
 */
function applyReview(verdicts) {
  const now = Date.now();
  let ok = 0;
  let rejected = 0;
  const keep = [];

  for (const q of state.quarantine) {
    const v = verdicts && Object.prototype.hasOwnProperty.call(verdicts, q.c.id) ? verdicts[q.c.id] : undefined;
    if (v === true) {
      state.contacts.unshift(q.c);
      ok++;
      continue;
    }
    if (v === false) {
      rejected++;
      continue;
    }
    if (now - q.at > REVIEW_WAIT) {
      state.contacts.unshift(q.c);
      ok++;
      continue;
    }
    keep.push(q);
  }

  state.quarantine = keep.slice(-150);
  return { approved: ok, rejected };
}

/** Черга нерозібраних рядків для ШІ; віддані позначаються як взяті. */
function takeUnparsed(limit) {
  const out = state.unparsed.filter((x) => !x.taken).slice(0, limit);
  for (const x of out) x.taken = true;
  return out;
}

/**
 * Контакти, витягнуті ШІ, проходять ту саму перевірку, що й свої:
 * місце має існувати в довіднику, клас — бути з відомого переліку.
 * Модель не може вигадати ні населений пункт, ні тип засобу.
 */
function contactFromAi(item, src) {
  const TYPES = new Set(Object.keys(require('./classes').CLASSES));
  if (!item || !item.place) return null;
  // ШІ розбирає із затримкою; якщо доповідь уже застара, ціль устигла
  // піти далеко від названого місця — показувати її там немає сенсу
  if (Date.now() - src.at > 3 * 60_000) return null;
  const type = TYPES.has(item.type) ? item.type : 'unknown';
  const oblast = item.oblast ? oblastFromText(item.oblast) : null;
  const place = findPlace(String(item.place), oblast, src.scope === 'kyiv', false, false);
  if (!place || !place.ll) return null;

  const action = ['course', 'impact', 'intercept', 'launch', 'takeoff', 'threat'].includes(item.action) ? item.action : 'course';
  return {
    id: `ai:${src.key}#${item.place}`,
    at: src.at,
    channel: src.channel,
    channelName: src.channel,
    trust: 1,
    link: src.link,
    text: src.text.slice(0, 200),
    type,
    action,
    count: Math.min(Math.max(Number(item.count) || 1, 1), 99),
    oblast: oblast || place.obl,
    level: null,
    from: null,
    to: { n: place.n, ll: place.ll, obl: place.obl },
    site: null,
    heading: null,
    ai: true,
  };
}

function addAiContacts(items, src) {
  let n = 0;
  for (const it of items || []) {
    const c = contactFromAi(it, src);
    if (!c) continue;
    state.contacts.unshift(c);
    n++;
  }
  return n;
}

module.exports = {
  loadPlaces,
  takeUnparsed,
  addAiContacts,
  takeForReview,
  applyReview,
  setReviewEnabled,
  loadSites,
  loadRaions,
  setAdminWords,
  poll,
  snapshot,
  CHANNELS,
  _internal: { messageToContacts, normalizeText, findRaion, findPlace, detectType, detectAction, detectLevel, extractPlaces, oblastFromText, parseChannelHtml, cluster, splitSegments },
};
