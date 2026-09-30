/**
 * ШІ як допоміжний шар — дві окремі задачі.
 *
 *   1. ДОРОЗБІР. Правила беруть більшість повідомлень, але не всі:
 *      лишається місцевий сленг («Парою завертають на північний
 *      перетин»), скорочення, нестандартні формати. Ці рядки йдуть
 *      у модель, яка витягає з них структуру.
 *
 *   2. ОЦІНКА ОБСТАНОВКИ. Геометрія вміє сказати «ця ціль іде на
 *      Бровари». Вона не вміє сказати «дванадцять бортів ідуть
 *      коридором Чернігівщина → Київщина, схоже на захід на столицю
 *      з півночі». Це синтез, і саме для нього модель корисна.
 *
 * ЩО МОДЕЛІ НЕ ДОЗВОЛЕНО. Вона не додає цілі напряму: повертає назву
 * місця й клас, а код перевіряє їх по довіднику. Немає такого
 * населеного пункту — контакт відкидається. Клас — лише з відомого
 * переліку. Тобто вигадати ціль із повітря модель не може, а її
 * оцінка обстановки живе окремим блоком і ніколи не змішується з
 * фактами.
 */
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

/* ─────────────── провайдери ─────────────── */

/**
 * Усі, крім Gemini, говорять у форматі OpenAI, тож різниця лише в
 * адресі й заголовку авторизації.
 */
const PROVIDERS = {
  gemini: {
    name: 'Google Gemini',
    free: true,
    url: (m, key) => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`,
    model: 'gemini-2.0-flash',
    build: (sys, user) => ({
      systemInstruction: { parts: [{ text: sys }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 1200, responseMimeType: 'application/json' },
    }),
    pick: (j) => {
      const c = j.candidates && j.candidates[0];
      const p = c && c.content && c.content.parts && c.content.parts[0];
      return p ? p.text : '';
    },
  },
  groq: {
    name: 'Groq',
    free: true,
    url: () => 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    openai: true,
  },
  ollama: {
    name: 'Ollama (локально)',
    free: true,
    url: () => 'http://localhost:11434/v1/chat/completions',
    model: 'qwen2.5:7b',
    openai: true,
    noKey: true,
  },
  deepseek: {
    name: 'DeepSeek',
    url: () => 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
    openai: true,
  },
  openai: {
    name: 'OpenAI-сумісний',
    url: (m, key, base) => (base || 'https://api.openai.com/v1') + '/chat/completions',
    model: 'gpt-4o-mini',
    openai: true,
  },
};

const cfg = {
  enabled: false,
  provider: 'gemini',
  model: null,
  key: null,
  baseUrl: null,
  parseMs: 60_000,      // як часто дорозбирати
  assessMs: 180_000,    // як часто оцінювати обстановку
  maxLines: 25,         // скільки рядків за раз
};

const state = {
  lastParse: 0,
  lastAssess: 0,
  assessment: null,     // { text, targets, at, model }
  parsedTotal: 0,
  addedTotal: 0,
  calls: 0,
  lastError: null,
  busy: false,
};

function configure(root) {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).ai || {};
  } catch {
    /* немає файлу — нормально */
  }
  cfg.provider = process.env.AI_PROVIDER || file.provider || 'gemini';
  cfg.key = process.env.AI_KEY || file.key || null;
  cfg.model = process.env.AI_MODEL || file.model || null;
  cfg.baseUrl = file.baseUrl || null;
  if (file.parseMs) cfg.parseMs = file.parseMs;
  if (file.assessMs) cfg.assessMs = file.assessMs;
  if (file.maxLines) cfg.maxLines = file.maxLines;

  const p = PROVIDERS[cfg.provider];
  cfg.enabled = !!p && file.enabled !== false && (p.noKey || !!cfg.key);
  return cfg.enabled;
}

/* ─────────────── виклик моделі ─────────────── */

function request(url, payload, headers) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(
      url,
      {
        method: 'POST',
        timeout: 45_000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const txt = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${txt.slice(0, 200)}`));
          try {
            resolve(JSON.parse(txt));
          } catch (e) {
            reject(new Error('погана відповідь моделі'));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

async function ask(sys, user) {
  const p = PROVIDERS[cfg.provider];
  if (!p) throw new Error('невідомий провайдер: ' + cfg.provider);
  const model = cfg.model || p.model;
  state.calls++;

  if (p.openai) {
    const headers = p.noKey ? {} : { Authorization: 'Bearer ' + cfg.key };
    const j = await request(p.url(model, cfg.key, cfg.baseUrl), {
      model,
      temperature: 0.1,
      max_tokens: 1200,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    }, headers);
    const c = j.choices && j.choices[0];
    return (c && c.message && c.message.content) || '';
  }

  const j = await request(p.url(model, cfg.key), p.build(sys, user), {});
  return p.pick(j);
}

/** Моделі люблять обгортати JSON у ```; знімаємо. */
function parseJson(text) {
  if (!text) return null;
  const clean = String(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    const m = clean.match(/[[{][\s\S]*[\]}]/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

/* ─────────────── задача 1: дорозбір ─────────────── */

const PARSE_SYS = `Ти розбираєш повідомлення українських каналів моніторингу повітряної обстановки.
З кожного рядка витягни ЛИШЕ те, що там прямо сказано. Нічого не додавай і не здогадуйся.

Поверни JSON: {"items":[...]}, де кожен елемент:
  "line"   — номер рядка (число)
  "type"   — один із: ballistic, aeroballistic, cruise_air, cruise_sea, cruise_ground,
             kh22, shahed, shahed_jet, kab, sam, recon_uav, missile, unknown
  "place"  — назва населеного пункту українською у називному відмінку
  "oblast" — область, якщо згадана, інакше null
  "action" — course (летить/курс), impact (влучання/вибух), intercept (збито),
             launch (пуск), takeoff (зліт), threat (загроза)
  "count"  — кількість цілей, якщо вказана, інакше 1

Правила:
- «реактивний» БпЛА це shahed_jet, звичайний — shahed;
- якщо населений пункт не названий — пропусти рядок повністю;
- якщо рядок не про повітряну обстановку (реклама, новина, подяка) — пропусти;
- місцевий сленг перекладай у реальні назви тільки якщо впевнений.`;

async function parseLines(lines) {
  if (!lines.length) return [];
  const user = lines.map((l, i) => `${i}. ${l.text.replace(/\s+/g, ' ')}`).join('\n');
  const raw = await ask(PARSE_SYS, user);
  const j = parseJson(raw);
  const items = (j && (j.items || j.result || (Array.isArray(j) ? j : null))) || [];
  return Array.isArray(items) ? items : [];
}

/* ─────────────── задача 2: оцінка обстановки ─────────────── */

const ASSESS_SYS = `Ти черговий аналітик повітряної обстановки. Тобі дають перелік цілей,
які зараз ведуть канали моніторингу, і перелік областей у тривозі.

Дай коротку оцінку українською, 3-5 речень, по суті, без вступів і без паніки:
— які групи видно і якими коридорами вони йдуть;
— на що це схоже за напрямком;
— чого очікувати найближчим часом.

Поверни JSON:
{
 "text": "оцінка суцільним текстом",
 "targets": [{"city":"назва","etaMin":число,"why":"коротко чому"}]
}
У targets — до 5 міст, які найімовірніше під загрозою за наявними курсами.
Якщо даних мало, так і напиши, а targets лиши порожнім.
Не вигадуй цілей, яких немає у вхідних даних.`;

function describeSituation(tracks, alerts, intercepts) {
  const lines = [];
  lines.push(`Областей у тривозі: ${alerts.length}${alerts.length ? ' — ' + alerts.join(', ') : ''}`);
  lines.push(`Цілей у повітрі: ${tracks.length}`);
  for (const t of tracks.slice(0, 40)) {
    const bits = [t.label];
    if (t.count > 1) bits.push('×' + t.count);
    if (t.place) bits.push('біля ' + t.place);
    if (t.bearing != null) bits.push('курс ' + Math.round(t.bearing) + '°');
    if (t.speed) bits.push(t.speed + ' км/год');
    if (t.nextCity) bits.push('→ ' + t.nextCity + ' за ' + Math.round(t.etaMin) + ' хв');
    lines.push('- ' + bits.join(', '));
  }
  if (intercepts.length) lines.push(`Збито за останні хвилини: ${intercepts.length}`);
  return lines.join('\n');
}

async function assess(tracks, alerts, intercepts, knownCity) {
  const user = describeSituation(tracks, alerts, intercepts);
  const raw = await ask(ASSESS_SYS, user);
  const j = parseJson(raw);
  if (!j || !j.text) return null;

  // Модель помиляється в назвах: у тексті вона вже приписувала Києву
  // райони Кременчука й Чернігова. Перелік цілей тому звіряємо з
  // довідником міст — чого немає, того не показуємо.
  let targets = Array.isArray(j.targets) ? j.targets : [];
  let dropped = 0;
  if (knownCity) {
    const before = targets.length;
    targets = targets.filter((t) => t && t.city && knownCity(String(t.city)));
    dropped = before - targets.length;
  }

  return {
    text: String(j.text).slice(0, 1200),
    targets: targets.slice(0, 5),
    droppedTargets: dropped,
    at: Date.now(),
    model: cfg.model || PROVIDERS[cfg.provider].model,
  };
}

/* ─────────────── такт ─────────────── */

/**
 * @param {Object} deps { takeUnparsed, addAiContacts, tracks, alerts, intercepts }
 */
async function tick(deps) {
  if (!cfg.enabled || state.busy) return;
  const now = Date.now();
  state.busy = true;

  try {
    // 1. дорозбір
    if (now - state.lastParse >= cfg.parseMs) {
      const lines = deps.takeUnparsed(cfg.maxLines);
      if (lines.length) {
        state.lastParse = now;
        const items = await parseLines(lines);
        state.parsedTotal += lines.length;
        let added = 0;
        for (const it of items) {
          const src = lines[Number(it.line)] || lines[0];
          if (!src) continue;
          added += deps.addAiContacts([it], src);
        }
        state.addedTotal += added;
      }
    }

    // 2. оцінка обстановки — лише коли є про що говорити
    if (now - state.lastAssess >= cfg.assessMs && deps.tracks.length >= 3) {
      state.lastAssess = now;
      const a = await assess(deps.tracks, deps.alerts, deps.intercepts, deps.knownCity);
      if (a) state.assessment = a;
    }

    state.lastError = null;
  } catch (e) {
    state.lastError = e.message;
  } finally {
    state.busy = false;
  }
}

async function selfTest() {
  if (!cfg.enabled) throw new Error('ШІ вимкнено або не задано ключ');
  // DeepSeek вимагає слово «json» у промпті, коли задано response_format
  const raw = await ask(
    'Відповідай лише у форматі JSON. Поверни рівно {"ok":true,"hello":"<одне слово українською>"}',
    'перевірка звʼязку, поверни json'
  );
  const j = parseJson(raw);
  return { provider: PROVIDERS[cfg.provider].name, model: cfg.model || PROVIDERS[cfg.provider].model, reply: j };
}

function snapshot() {
  return {
    enabled: cfg.enabled,
    provider: cfg.provider,
    providerName: PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].name : null,
    model: cfg.model || (PROVIDERS[cfg.provider] && PROVIDERS[cfg.provider].model),
    assessment: state.assessment,
    stats: { calls: state.calls, linesSent: state.parsedTotal, contactsAdded: state.addedTotal },
    lastError: state.lastError,
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name, free: !!p.free, noKey: !!p.noKey })),
  };
}

module.exports = { configure, tick, selfTest, snapshot, cfg, PROVIDERS };
