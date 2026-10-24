/**
 * Публікація обстановки у власний Telegram-канал.
 *
 * Канал не має перетворюватись на смітник: під час атаки в повітрі
 * бувають сотні цілей, і окреме повідомлення на кожну зробить канал
 * непридатним. Тому три різні режими:
 *
 *   1. ТАБЛО   — одне повідомлення, яке редагується. Завжди показує
 *                поточну картину. Закріплюється один раз.
 *   2. ТЕРМІНОВЕ — окремий пост одразу: пуск, зліт, балістика, влучання.
 *                Те, через що йдуть в укриття.
 *   3. ЗВЕДЕННЯ — раз на хвилину одним постом усе нове по БпЛА,
 *                згруповане за областями.
 *
 * Токен і канал задаються у config.json (див. config.example.json) або
 * змінними оточення TG_BOT_TOKEN / TG_CHAT_ID. Без них модуль мовчить.
 */
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const API = 'https://api.telegram.org/bot';

const cfg = {
  token: null,
  chatId: null,
  enabled: false,
  boardMs: 30_000,      // як часто оновлювати табло
  digestMs: 60_000,     // як часто зводити БпЛА в один пост
  pinBoard: true,
  urgentTypes: ['ballistic', 'aeroballistic', 'cruise_air', 'cruise_sea', 'cruise_ground', 'kh22', 'missile'],
};

const state = {
  boardId: null,
  boardText: '',
  posted: new Set(),    // id подій, про які вже писали
  pendingDigest: [],
  lastBoard: 0,
  lastDigest: 0,
  sent: 0,
  errors: [],
  lastError: null,
  queue: [],
  sending: false,
};

let CACHE_FILE = null;

/* ─────────────── налаштування ─────────────── */

function configure(root) {
  CACHE_FILE = path.join(root, 'cache', 'telegram.json');

  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).telegram || {};
  } catch {
    /* файлу може не бути — це нормально */
  }

  cfg.token = process.env.TG_BOT_TOKEN || file.token || null;
  cfg.chatId = process.env.TG_CHAT_ID || file.chatId || null;
  if (file.boardMs) cfg.boardMs = file.boardMs;
  if (file.digestMs) cfg.digestMs = file.digestMs;
  if (file.pinBoard === false) cfg.pinBoard = false;
  cfg.enabled = !!(cfg.token && cfg.chatId && file.enabled !== false);

  try {
    const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    state.boardId = saved.boardId || null;
    state.boardText = saved.boardText || '';
    if (Array.isArray(saved.posted)) state.posted = new Set(saved.posted.slice(-800));
  } catch {
    /* перший запуск */
  }

  return cfg.enabled;
}

function save() {
  if (!CACHE_FILE) return;
  const data = { boardId: state.boardId, boardText: state.boardText, posted: [...state.posted].slice(-800) };
  fs.writeFile(CACHE_FILE, JSON.stringify(data), () => {});
}

/* ─────────────── транспорт ─────────────── */

function call(method, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const req = https.request(
      `${API}${cfg.token}/${method}`,
      {
        method: 'POST',
        timeout: 15_000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch (e) {
            return reject(new Error('bad JSON from Telegram'));
          }
          if (!json.ok) return reject(new Error(`${method}: ${json.description || 'помилка'}`));
          resolve(json.result);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

/** Телеграм не любить сплесків: шлемо по черзі з паузою. */
async function enqueue(fn) {
  state.queue.push(fn);
  if (state.sending) return;
  state.sending = true;
  while (state.queue.length) {
    const job = state.queue.shift();
    try {
      await job();
      state.sent++;
    } catch (e) {
      state.lastError = e.message;
      state.errors.unshift({ at: Date.now(), error: e.message });
      state.errors.length = Math.min(state.errors.length, 10);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  state.sending = false;
}

/* ─────────────── форматування ─────────────── */

const ICON = {
  ballistic: '🔴', aeroballistic: '🔴', missile: '🔴',
  cruise_air: '🟠', cruise_sea: '🟠', cruise_ground: '🟠', kh22: '🟠',
  shahed: '🛵', shahed_jet: '🏍', kab: '💣', sam: '🔺', recon_uav: '🔭', unknown: '⚪',
};

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const fmtEta = (min) => {
  if (min == null) return '';
  if (min < 1) return '<1 хв';
  if (min < 60) return Math.round(min) + ' хв';
  return `${Math.floor(min / 60)} год ${Math.round(min % 60)} хв`;
};

const hhmm = (t) =>
  new Date(t).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });

const shortObl = (s) => String(s || '').replace(' область', '').replace('м. ', '');

/** Табло: одне повідомлення, яке редагується. */
function buildBoard(data) {
  const { alerts, targets, byType, now } = data;
  const lines = [];
  lines.push('<b>🛰 UA-RADAR · обстановка</b>');
  lines.push('');

  if (alerts.length) {
    lines.push(`🚨 <b>Тривога:</b> ${alerts.length} обл. — ${esc(alerts.map(shortObl).slice(0, 8).join(', '))}${alerts.length > 8 ? '…' : ''}`);
  } else {
    lines.push('🟢 <b>Тривог немає</b>');
  }

  if (targets.length) {
    const t = Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${ICON[k] || '⚪'} ${n}`)
      .join('   ');
    lines.push(`🎯 <b>У повітрі:</b> ${targets.length} — ${t}`);
    lines.push('');

    const top = targets
      .filter((x) => x.place)
      .sort((a, b) => (a.etaMin == null ? 999 : a.etaMin) - (b.etaMin == null ? 999 : b.etaMin))
      .slice(0, 14);
    for (const x of top) {
      const eta = x.etaMin != null ? ` · <b>${fmtEta(x.etaMin)}</b>` : '';
      const cnt = x.count > 1 ? ` ×${x.count}` : '';
      // «звідки бачили → куди йде за курсом»
      const route = x.nextCity ? `${esc(x.place)} → <b>${esc(x.nextCity)}</b>` : `<b>${esc(x.place)}</b>`;
      lines.push(`${ICON[x.type] || '⚪'} ${esc(x.label)}${cnt}  ${route}${eta}`);
    }
    if (targets.length > top.length) lines.push(`… та ще ${targets.length - top.length}`);
  } else {
    lines.push('🎯 <b>У повітрі:</b> чисто');
  }

  lines.push('');
  lines.push(`<i>оновлено ${hhmm(now)} · позиції розраховані, не радар</i>`);
  return lines.join('\n');
}

/** Термінове: пуск, зліт, балістика, влучання. */
function buildUrgent(ev) {
  const ic = ICON[ev.type] || '⚪';
  const lines = [];

  if (ev.kind === 'launch') {
    lines.push(`🚀 <b>${ev.action === 'takeoff' ? 'ЗЛІТ' : 'ПУСК'} · ${esc(ev.label)}</b>`);
    lines.push(`Звідки: <b>${esc(ev.from || '—')}</b>`);
    lines.push(`Рубіж досяжності: <b>${Math.round(ev.reachKm)} км</b>`);
    if (ev.reach && ev.reach.length) {
      lines.push('');
      lines.push('<b>Час підльоту:</b>');
      for (const r of ev.reach.slice(0, 8)) {
        lines.push(`• ${esc(r.city)} — ${fmtEta(r.flightMin)}`);
      }
    }
  } else if (ev.kind === 'impact') {
    lines.push(`💥 <b>ВЛУЧАННЯ · ${esc(ev.place || ev.oblast || '')}</b>`);
    lines.push(esc(ev.text));
  } else {
    lines.push(`${ic} <b>${esc(ev.label)}${ev.count > 1 ? ' ×' + ev.count : ''}</b>`);
    if (ev.place) lines.push(`Курс на: <b>${esc(ev.place)}</b>`);
    if (ev.oblast) lines.push(`Область: ${esc(shortObl(ev.oblast))}`);
    if (ev.etaMin != null) lines.push(`Підліт: <b>${fmtEta(ev.etaMin)}</b>`);
  }

  lines.push('');
  lines.push(`<i>${hhmm(ev.at)} · джерела: ${esc((ev.sources || []).slice(0, 4).join(', '))}</i>`);
  return lines.join('\n');
}

/** Зведення по БпЛА за останню хвилину, згруповане за областями. */
function buildDigest(items, now) {
  const byObl = new Map();
  for (const x of items) {
    const k = shortObl(x.oblast) || 'Інше';
    if (!byObl.has(k)) byObl.set(k, []);
    byObl.get(k).push(x);
  }
  const lines = [`<b>✈️ Рух цілей · ${hhmm(now)}</b>`, ''];
  for (const [obl, arr] of [...byObl].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`<b>${esc(obl)}:</b>`);
    for (const x of arr.slice(0, 10)) {
      const cnt = x.count > 1 ? `${x.count}× ` : '';
      const eta = x.etaMin != null ? ` · <b>${fmtEta(x.etaMin)}</b>` : '';
      const route = x.nextCity ? `${esc(x.place)} → ${esc(x.nextCity)}` : esc(x.place || '—');
      lines.push(`  ${ICON[x.type] || '⚪'} ${cnt}${esc(x.label)}  ${route}${eta}`);
    }
    if (arr.length > 10) lines.push(`  … та ще ${arr.length - 10}`);
  }
  return lines.join('\n');
}

/* ─────────────── головний такт ─────────────── */

/**
 * @param {Object} data знімок обстановки від сервера
 *   alerts   — назви областей у тривозі
 *   targets  — [{id, type, label, place, oblast, count, etaMin, kind, ...}]
 *   events   — термінові події (пуски, влучання, ракети)
 */
function tick(data) {
  if (!cfg.enabled) return;
  const now = Date.now();

  // 1. термінове — одразу, кожна подія один раз
  for (const ev of data.events || []) {
    if (state.posted.has(ev.id)) continue;
    state.posted.add(ev.id);
    enqueue(() => call('sendMessage', {
      chat_id: cfg.chatId,
      text: buildUrgent(ev),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }));
  }

  // 2. нові БпЛА збираємо у зведення
  for (const t of data.targets || []) {
    if (!t.place) continue;
    if (state.posted.has('d:' + t.id)) continue;
    state.posted.add('d:' + t.id);
    state.pendingDigest.push(t);
  }

  if (state.pendingDigest.length && now - state.lastDigest >= cfg.digestMs) {
    const items = state.pendingDigest.splice(0, 60);
    state.lastDigest = now;
    enqueue(() => call('sendMessage', {
      chat_id: cfg.chatId,
      text: buildDigest(items, now),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }));
  }

  // 3. табло — редагуємо, а не шлемо заново
  if (now - state.lastBoard >= cfg.boardMs) {
    state.lastBoard = now;
    const text = buildBoard({ ...data, now });
    if (text !== state.boardText) {
      state.boardText = text;
      enqueue(async () => {
        if (state.boardId) {
          try {
            await call('editMessageText', {
              chat_id: cfg.chatId, message_id: state.boardId,
              text, parse_mode: 'HTML', disable_web_page_preview: true,
            });
            return;
          } catch (e) {
            // повідомлення видалили або воно застаріло — створимо нове
            if (!/message to edit not found|message is not modified/i.test(e.message)) throw e;
            if (/not modified/i.test(e.message)) return;
            state.boardId = null;
          }
        }
        const msg = await call('sendMessage', {
          chat_id: cfg.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
        });
        state.boardId = msg.message_id;
        if (cfg.pinBoard) {
          try {
            await call('pinChatMessage', { chat_id: cfg.chatId, message_id: msg.message_id, disable_notification: true });
          } catch {
            /* бот може не мати права закріплювати — не критично */
          }
        }
      });
    }
    save();
  }

  if (state.posted.size > 2000) state.posted = new Set([...state.posted].slice(-1000));
}

/** Перевірка зв'язку — для діагностики й першого налаштування. */
async function selfTest() {
  if (!cfg.token) throw new Error('не задано TG_BOT_TOKEN');
  if (!cfg.chatId) throw new Error('не задано TG_CHAT_ID');
  const me = await call('getMe', {});
  const msg = await call('sendMessage', {
    chat_id: cfg.chatId,
    text: '<b>🛰 UA-RADAR підключено</b>\nБот писатиме сюди обстановку: пуски, рух цілей і табло.',
    parse_mode: 'HTML',
  });
  return { bot: me.username, messageId: msg.message_id };
}

function status() {
  return {
    enabled: cfg.enabled,
    configured: !!(cfg.token && cfg.chatId),
    chatId: cfg.chatId ? String(cfg.chatId) : null,
    boardId: state.boardId,
    sent: state.sent,
    queued: state.queue.length,
    pendingDigest: state.pendingDigest.length,
    lastError: state.lastError,
    boardMs: cfg.boardMs,
    digestMs: cfg.digestMs,
  };
}

module.exports = { configure, tick, selfTest, status, cfg };
