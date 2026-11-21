#!/usr/bin/env node
/**
 * Привʼязка Telegram-каналу до бота.
 *
 * Запустіть цей скрипт і додайте бота адміністратором у свій канал —
 * скрипт сам побачить це, збереже id каналу в config.json і надішле
 * туди перше повідомлення.
 *
 *   node link-channel.js
 *
 * Можна й одразу вказати канал вручну:
 *
 *   node link-channel.js @mychannel
 */
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, 'config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {
    console.error('Немає config.json. Скопіюйте config.example.json і впишіть токен бота.');
    process.exit(1);
  }
}

function api(token, method, query) {
  const qs = query ? '?' + new URLSearchParams(query) : '';
  return new Promise((resolve, reject) => {
    https
      .get(`https://api.telegram.org/bot${token}/${method}${qs}`, { timeout: 30_000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!j.ok) return reject(new Error(j.description || 'помилка API'));
            resolve(j.result);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

function saveChat(cfg, chatId, title) {
  cfg.telegram.chatId = String(chatId);
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`\n✓ Канал збережено в config.json: ${chatId}${title ? ' («' + title + '»)' : ''}`);
  console.log('  Перезапустіть сервер — бот почне писати обстановку.');
}

async function main() {
  const cfg = readConfig();
  const token = cfg.telegram && cfg.telegram.token;
  if (!token) {
    console.error('У config.json не вказано telegram.token');
    process.exit(1);
  }

  const me = await api(token, 'getMe');
  console.log(`Бот: @${me.username} (${me.first_name})`);

  // варіант із явним аргументом: node link-channel.js @mychannel
  const arg = process.argv[2];
  if (arg) {
    const chat = await api(token, 'getChat', { chat_id: arg });
    saveChat(cfg, chat.id, chat.title);
    await api(token, 'sendMessage', {
      chat_id: chat.id,
      text: '🛰 UA-RADAR підключено. Сюди йтимуть пуски, рух цілей і табло обстановки.',
    });
    console.log('  Тестове повідомлення надіслано.');
    return;
  }

  console.log('\nЩо зробити зараз:');
  console.log('  1. Створіть канал у Telegram (або відкрийте наявний).');
  console.log(`  2. Налаштування каналу → Адміністратори → додати @${me.username}.`);
  console.log('  3. Увімкніть йому право «Publish messages» / «Публікація повідомлень».');
  console.log('\nЧекаю (2 хвилини)…');

  const until = Date.now() + 120_000;
  let offset = 0;

  while (Date.now() < until) {
    let updates = [];
    try {
      updates = await api(token, 'getUpdates', {
        offset,
        timeout: 20,
        allowed_updates: JSON.stringify(['my_chat_member', 'channel_post', 'message']),
      });
    } catch (e) {
      console.error('  ...', e.message);
    }

    for (const u of updates) {
      offset = u.update_id + 1;
      const ev = u.my_chat_member || u.channel_post || u.message;
      const chat = ev && ev.chat;
      if (!chat) continue;
      const status = u.my_chat_member && u.my_chat_member.new_chat_member && u.my_chat_member.new_chat_member.status;
      if (status && !['administrator', 'member', 'creator'].includes(status)) continue;

      saveChat(cfg, chat.id, chat.title);
      try {
        await api(token, 'sendMessage', {
          chat_id: chat.id,
          text: '🛰 UA-RADAR підключено. Сюди йтимуть пуски, рух цілей і табло обстановки.',
        });
        console.log('  Тестове повідомлення надіслано.');
      } catch (e) {
        console.log('  ! Написати не вдалось:', e.message);
        console.log('    Перевірте, що боту дано право публікувати повідомлення.');
      }
      return;
    }
  }

  console.log('\nБота так і не додали. Запустіть скрипт ще раз або вкажіть канал вручну:');
  console.log('  node link-channel.js @назва_каналу');
}

main().catch((e) => {
  console.error('Помилка:', e.message);
  process.exit(1);
});
