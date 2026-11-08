// Проверка бота без Telegram: node check.mjs
import assert from 'node:assert';
import worker, { tourInfo } from './worker.js';

const sent = [];
let msgId = 100;
globalThis.fetch = async (url, o) => { sent.push({ method: url.split('/').pop(), ...JSON.parse(o.body) }); return Response.json({ ok: true, result: { message_id: ++msgId } }); };
const kv = new Map();
const env = { BOT_TOKEN: 't', UPDATE_SECRET: 's', TG_SECRET: 'g', CHANNEL_ID: '@ch', CONTACT_URL: 'https://wa.me/1', POSTS_PER_UPDATE: '2', TOUR_LINK: 'https://tourcart.ru/#tvofferid={id}',
  TOURS: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async k => kv.delete(k) } };
const post = (path, body, headers) => worker.fetch(new Request('https://x' + path, { method: 'POST', body: JSON.stringify(body), headers }), env);
const TG = { 'x-telegram-bot-api-secret-token': 'g' };

// даты вылета — через 5 дней от сегодня, чтобы попадать в «Ближайшие 2 недели»
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const soon = new Date(Date.now() + 5 * 864e5);
const when = `${soon.getUTCDate()} ${MONTHS[soon.getUTCMonth()]}`;
const t = (id, country, price, oldPrice, nights) => ({ id, country, price, oldPrice, title: 'Тур ' + id, descr: `5*, ${country} из Астаны ${when} на ${nights} ночей, Завтрак.`, discount: '', img: 'https://img/' + id + '.jpg' });
const items = [t('1', 'Таиланд', 500000, 600000, 14), t('2', 'Таиланд', 300000, 600000, 7), t('3', 'ОАЭ', 400000, 410000, 7)];

// разбор даты и ночей; январь при текущем ноябре — следующий год
const info = tourInfo({ descr: '5*, Таиланд из Астаны 9 января на 12 ночей, Завтрак.' }, new Date(Date.UTC(2026, 10, 8)));
assert.equal(info.date.toISOString().slice(0, 10), '2027-01-09');
assert.equal(info.nights, 12);

// приём туров и публикация в канал
assert.equal((await post('/update', { items }, { 'x-secret': 'bad' })).status, 403);
let r = await (await post('/update', { updated: '2026-11-07T04:00:00Z', items }, { 'x-secret': 's' })).json();
assert.deepEqual(r, { saved: 3, posted: 2 });
assert.deepEqual(sent.map(m => m.caption.match(/Тур \d/)[0]), ['Тур 2', 'Тур 1']); // самая большая скидка первой
sent.length = 0;
r = await (await post('/update', { items }, { 'x-secret': 's' })).json();
assert.equal(r.posted, 1); // уже опубликованные не повторяются

// /start: постоянная кнопка внизу + первый шаг подбора
sent.length = 0;
await post('/tg', { message: { chat: { id: 7 }, message_id: 1, text: '/start' } }, TG);
assert.deepEqual(sent[0].reply_markup.keyboard, [[{ text: '🔥 Подобрать тур' }]]);
assert.ok(sent[0].reply_markup.input_field_placeholder.length <= 64); // лимит Telegram
assert.match(sent[1].text, /Сколько взрослых/); // первым шагом — туристы
const wizardId = msgId;

// клиент проходит шаги, нажимая кнопки
const press = async label => {
  const btn = sent.at(-1).reply_markup.inline_keyboard.flat().find(b => b.text === label);
  assert.ok(btn, 'нет кнопки ' + label);
  sent.length = 0;
  await post('/tg', { callback_query: { id: 'q', data: btn.callback_data, message: { chat: { id: 7 }, message_id: wizardId } } }, TG);
  assert.ok(btn.callback_data.length <= 64);
};
await press('2'); assert.match(sent.at(-1).text, /Сколько детей/);
await press('1'); assert.match(sent.at(-1).text, /Возраст 1-го ребёнка/);
assert.deepEqual(sent.at(-1).reply_markup.inline_keyboard.flat().map(b => b.text), ['до 2', ...Array.from({ length: 16 }, (_, i) => String(i + 2))]);
await press('5'); assert.match(sent.at(-1).text, /Выберите страну/);
await press('Таиланд'); assert.match(sent.at(-1).text, /Сколько ночей/);
await press('6–9 ночей'); assert.match(sent.at(-1).text, /Когда хотите лететь/);
await press('Ближайшие 2 недели');
const resultIds = [msgId - 1, msgId]; // фото тура и сообщение с кнопкой заявки

// итог: запрос, подходящий тур (только 7 ночей в Таиланд), кнопка заявки менеджеру
assert.match(sent[1].text, /Туристы: 2 взр\. \+ 1 ребёнок \(5 лет\)\nСтрана: Таиланд\nНочей: 6–9\nПериод: Ближайшие 2 недели/);
const photos = sent.filter(m => m.method === 'sendPhoto');
assert.deepEqual(photos.map(m => m.caption.match(/Тур \d/)[0]), ['Тур 2']);
assert.deepEqual(photos[0].reply_markup.inline_keyboard[0].map(b => b.url), ['https://tourcart.ru/#tvofferid=2', 'https://wa.me/1?text=' + encodeURIComponent('Здравствуйте! Хочу забронировать тур: Тур 2')]);
assert.match(decodeURIComponent(sent.at(-1).reply_markup.inline_keyboard[0][0].url), /Подберите, пожалуйста, тур\.\nТуристы: 2 взр\./);

// «Подобрать тур» удаляет старую подборку (шаги, туры, итог, само нажатие) и начинает заново
sent.length = 0;
await post('/tg', { message: { chat: { id: 7 }, message_id: 55, text: '🔥 Подобрать тур' } }, TG);
assert.equal(sent[0].method, 'deleteMessages');
assert.deepEqual(sent[0].message_ids.sort(), [wizardId, ...resultIds, 55].sort());
assert.match(sent[1].text, /Сколько взрослых/);
assert.equal(sent.length, 2); // без повторного приветствия

assert.equal((await worker.fetch(new Request('https://x/update', { method: 'OPTIONS' }), env)).headers.get('access-control-allow-origin'), 'https://pro.tourvisor.ru');
assert.equal((await worker.fetch(new Request('https://x/.git/HEAD'), env)).status, 404);
console.log('OK');
