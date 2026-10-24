/** Діагностика: який канал що дає і які рядки не розбираються. */
const M = require('C:/Users/arb51/websites/ukraine-radar/monitor.js');
const https = require('https');
const zlib = require('zlib');

M.loadPlaces('C:/Users/arb51/websites/ukraine-radar/data/places.json', 'C:/Users/arb51/websites/ukraine-radar/data/kyiv-places.json');
M.loadSites();
M.loadRaions('C:/Users/arb51/websites/ukraine-radar/data/raions.geojson');
M.setAdminWords([
  'Вінницька область','Волинська область','Дніпропетровська область','Донецька область',
  'Житомирська область','Закарпатська область','Запорізька область','Івано-Франківська область',
  'Київська область','Кіровоградська область','Луганська область','Львівська область',
  'Миколаївська область','Одеська область','Полтавська область','Рівненська область',
  'Сумська область','Тернопільська область','Харківська область','Херсонська область',
  'Хмельницька область','Черкаська область','Чернівецька область','Чернігівська область',
  'Бердичівський район','Богодухівський район','Чугуївський район','Криворізький район',
]);

const I = M._internal;

function get(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'gzip' }, timeout: 25000 }, (r) => {
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode)); }
      const st = (r.headers['content-encoding'] || '').includes('gzip') ? r.pipe(zlib.createGunzip()) : r;
      const c = [];
      st.on('data', (x) => c.push(x));
      st.on('end', () => res(Buffer.concat(c).toString('utf8')));
    }).on('error', rej);
  });
}

(async () => {
  const misses = [];
  const rows = [];

  for (const ch of M.CHANNELS) {
    let html;
    try {
      html = await get('https://t.me/s/' + ch.id);
    } catch (e) {
      rows.push([ch.name, 0, 0, 0, 'HTTP ' + e.message]);
      continue;
    }
    const msgs = I.parseChannelHtml(html, ch);
    let contacts = 0;
    let deadMsgs = 0;
    for (const m of msgs) {
      const cs = I.messageToContacts(m);
      contacts += cs.length;
      if (!cs.length) {
        deadMsgs++;
        if (misses.length < 400) misses.push({ ch: ch.name, text: m.text.replace(/\s+/g, ' ').slice(0, 130) });
      }
    }
    rows.push([ch.name, msgs.length, contacts, deadMsgs, '']);
  }

  console.log('канал'.padEnd(26) + 'повід.'.padStart(7) + 'контакт.'.padStart(9) + 'пусті'.padStart(7));
  rows.sort((a, b) => a[2] / Math.max(a[1], 1) - b[2] / Math.max(b[1], 1));
  for (const r of rows) {
    console.log(r[0].padEnd(26) + String(r[1]).padStart(7) + String(r[2]).padStart(9) + String(r[3]).padStart(7) + (r[4] ? '  ' + r[4] : ''));
  }

  console.log('\n═══ приклади нерозібраних рядків ═══');
  const byCh = {};
  for (const m of misses) (byCh[m.ch] = byCh[m.ch] || []).push(m.text);
  for (const [ch, arr] of Object.entries(byCh)) {
    if (arr.length < 3) continue;
    console.log('\n— ' + ch + ' (' + arr.length + ')');
    for (const t of arr.slice(0, 5)) console.log('    ' + t);
  }
})();
