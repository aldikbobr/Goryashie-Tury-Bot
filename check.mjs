// Проверка бота без Telegram: node check.mjs
import assert from 'node:assert';
import worker from './worker.js';

const sent = [];
globalThis.fetch = async (url, o) => { sent.push({ method: url.split('/').pop(), ...JSON.parse(o.body) }); return Response.json({ ok: true }); };
const kv = new Map();
const env = { BOT_TOKEN: 't', UPDATE_SECRET: 's', TG_SECRET: 'g', CHANNEL_ID: '@ch', CONTACT_URL: 'https://wa.me/1', POSTS_PER_UPDATE: '2',
  TOURS: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) } };
const post = (path, body, headers) => worker.fetch(new Request('https://x' + path, { method: 'POST', body: JSON.stringify(body), headers }), env);

const t = (id, country, price, oldPrice) => ({ id, country, price, oldPrice, title: 'Тур ' + id, descr: 'описание', discount: '', link: 'https://tourcart.ru/#tvofferid=' + id, img: 'https://img/' + id + '.jpg' });
const items = [t('1', 'Таиланд', 500000, 600000), t('2', 'Таиланд', 300000, 600000), t('3', 'ОАЭ', 400000, 410000)];

assert.equal((await post('/update', { items }, { 'x-secret': 'bad' })).status, 403);
let r = await (await post('/update', { updated: '2026-11-07T04:00:00Z', items }, { 'x-secret': 's' })).json();
assert.deepEqual(r, { saved: 3, posted: 2 });
assert.deepEqual(sent.map(m => m.caption.match(/Тур \d/)[0]), ['Тур 2', 'Тур 1']); // самая большая скидка первой
sent.length = 0;
r = await (await post('/update', { items }, { 'x-secret': 's' })).json();
assert.equal(r.posted, 1); // уже опубликованные не повторяются

sent.length = 0;
await post('/tg', { message: { chat: { id: 7 }, text: '/start' } }, { 'x-telegram-bot-api-secret-token': 'g' });
assert.deepEqual(sent[0].reply_markup.inline_keyboard, [[{ text: 'ОАЭ', callback_data: 'c:ОАЭ' }, { text: 'Таиланд', callback_data: 'c:Таиланд' }]]);

sent.length = 0;
await post('/tg', { callback_query: { id: 'q', data: 'c:Таиланд', message: { chat: { id: 7 } } } }, { 'x-telegram-bot-api-secret-token': 'g' });
const photos = sent.filter(m => m.method === 'sendPhoto');
assert.deepEqual(photos.map(m => m.caption.match(/Тур \d/)[0]), ['Тур 2', 'Тур 1']); // дешёвые первыми
assert.equal(photos[0].reply_markup.inline_keyboard[0][1].url, 'https://wa.me/1');

assert.equal((await worker.fetch(new Request('https://x/.git/HEAD'), env)).status, 404);
console.log('OK');
