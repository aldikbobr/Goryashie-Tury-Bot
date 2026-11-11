// Проверка бота без Telegram и без Tourvisor: node check.mjs
import assert from 'node:assert';
import worker, { tourInfo, groupHotels, channelDigest, channelNews, hotBlock, channelHot, channelWeather, resortOfDay, channelEvening } from './worker.js';

// Tourvisor в проверке подменён: ответ как у настоящего поиска (Турция/Таиланд, 4 отеля с разным рейтингом)
let tvMode = 'ok';
const tvHotels = { 1: ['ALPHA RESORT', '4.8', 5], 2: ['BETA HOTEL', '4.2', 4], 3: ['GAMMA INN', '3.8', 3], 4: ['LOW HOTEL', '3.2', 3] };
const tvResult = { data: {
  status: { progress: 100, finished: 1 },
  block: [{ hotel: [1, 2, 3, 4].map(id => ({ id, price: id * 100000, tour: [{ dt: '2026-12-06', nt: 7, pr: id * 100000, ml: 3 }, { dt: '2026-12-08', nt: 8, pr: id * 100000 + 5000, ml: 3 }] })) }],
  decode: { hotels: Object.fromEntries(Object.entries(tvHotels).map(([id, [name, rating, stars]]) => [id, { name, rating, stars: String(stars), region: 'Пхукет' }])), meal: { 3: { nameshort: 'BB - Завтрак' } } },
} };
const tvCalls = [];

const sent = [];
let msgId = 100;
const rss = items => `<rss><channel><title>Лента</title>${items.map(([t, l]) => `<item><title><![CDATA[${t}]]></title><link>${l}</link></item>`).join('')}</channel></rss>`;
globalThis.fetch = async (url, o) => {
  if (url.includes('marine-api')) return Response.json({ current: { sea_surface_temperature: 29.6 } });
  if (url.includes('open-meteo')) return Response.json({ daily: url.includes('latitude=51.17')
    ? { temperature_2m_max: [-3.4], temperature_2m_min: [-10.2], weather_code: [73] }
    : { temperature_2m_max: [31.2], temperature_2m_min: [25], weather_code: [1] } });
  if (url.includes('kursiv')) return new Response(rss([['SCAT возьмет в лизинг два Boeing', 'https://k/1'], ['Курс тенге вырос', 'https://k/2']]));
  if (url.includes('inform.kz')) return new Response('down', { status: 500 });
  if (url.includes('tourdom')) return new Response(rss([['Анапа получила статус курорта', 'https://t/1'], ['SCAT возьмет в лизинг два Boeing', 'https://t/dup']]));
  if (url.includes('tourvisor.ru')) {
    tvCalls.push(url);
    if (tvMode === 'down') return new Response('Forbidden', { status: 403 });
    if (url.includes('listdev')) return Response.json({ lists: { regions: { region: [
      { id: 6, name: 'Пхукет', parentid: 0 }, { id: 5, name: 'Паттайя', parentid: 0 }, { id: 600, name: 'Патонг', parentid: 6 }] } } });
    return Response.json(url.includes('modsearch') ? { result: { requestid: 1 } } : tvResult);
  }
  if (o.body instanceof FormData) { // фото файлом
    const f = Object.fromEntries(o.body.entries());
    sent.push({ method: url.split('/').pop(), upload: true, size: f.photo.size, caption: f.caption, chat_id: f.chat_id, reply_markup: JSON.parse(f.reply_markup) });
    return Response.json({ ok: true, result: { message_id: ++msgId } });
  }
  sent.push({ method: url.split('/').pop(), ...JSON.parse(o.body) });
  return Response.json({ ok: true, result: { message_id: ++msgId } });
};
const kv = new Map();
const env = { BOT_TOKEN: 't', UPDATE_SECRET: 's', TG_SECRET: 'g', ADMIN_CODE: 'abc', CHANNEL_ID: '@ch', CONTACT_URL: 'https://wa.me/1', POSTS_PER_UPDATE: '2', TOUR_LINK: 'https://tourcart.ru/#tvofferid={id}',
  TOURS: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async k => kv.delete(k) } };
const pending = [];
const ctx = { waitUntil: p => pending.push(p) };
const post = async (path, body, headers) => { const r = await worker.fetch(new Request('https://x' + path, { method: 'POST', body: JSON.stringify(body), headers }), env, ctx); await Promise.all(pending.splice(0)); return r; };
const TG = { 'x-telegram-bot-api-secret-token': 'g' };

// даты вылета — через 5 дней от сегодня, чтобы попадать в «Ближайшие 2 недели»
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const soon = new Date(Date.now() + 5 * 864e5);
const when = `${soon.getUTCDate()} ${MONTHS[soon.getUTCMonth()]}`;
const t = (id, country, price, oldPrice, nights) => ({ id, country, price, oldPrice, title: 'Тур ' + id, descr: `5*, ${country}${country === 'Таиланд' ? ', Пхукет' : ''} из Астаны ${when} на ${nights} ночей, Завтрак.`, discount: '', img: 'https://img/' + id + '.jpg' });
const items = [t('1', 'Таиланд', 500000, 600000, 14), t('2', 'Таиланд', 300000, 600000, 7), t('3', 'ОАЭ', 400000, 410000, 7)];

// разбор даты, ночей и питания; январь при текущем ноябре — следующий год
const info = tourInfo({ descr: '5*, Таиланд из Астаны 9 января на 12 ночей, Завтрак.' }, new Date(Date.UTC(2026, 10, 8)));
assert.equal(info.date.toISOString().slice(0, 10), '2027-01-09');
assert.equal(info.nights, 12);
assert.equal(info.meal, 1); // Завтрак
assert.equal(tourInfo({ descr: '5*, ОАЭ из Астаны 8 ноября на 10 ночей, Без питания. Отель' }).meal, 0);
assert.equal(tourInfo({ descr: '5*, Турция из Астаны 8 ноября на 7 ночей, Ультра всё включено. Отель' }).meal, 5);
assert.equal(tourInfo({ descr: '5*, Таиланд, Пхукет из Астаны 18 ноября на 14 ночей. Пхукет является…' }).meal, undefined);

// группы рейтинга: 4,5–5 / 4–4,5 / 3,7–4; ниже 3,7 не показываем
const g = groupHotels([{ rating: 4.5 }, { rating: 4.49 }, { rating: 4.0 }, { rating: 3.99 }, { rating: 3.7 }, { rating: 3.69 }].map((h, i) => ({ ...h, price: i })));
assert.deepEqual(g.map(x => x.hotels.map(h => h.rating)), [[4.5], [4.49, 4.0], [3.99, 3.7]]);

// приём туров и публикация в канал
assert.equal((await post('/update', { items }, { 'x-secret': 'bad' })).status, 403);
let r = await (await post('/update', { updated: '2026-11-07T04:00:00Z', items }, { 'x-secret': 's' })).json();
assert.deepEqual(r, { saved: 3, posted: 2 });
assert.deepEqual(sent.map(m => m.caption.match(/Тур \d/)[0]), ['Тур 2', 'Тур 1']); // самая большая скидка первой
sent.length = 0;
r = await (await post('/update', { items }, { 'x-secret': 's' })).json();
assert.equal(r.posted, 1); // уже опубликованные не повторяются

// владелец бота регистрируется для сообщений о сбоях
sent.length = 0;
await post('/tg', { message: { chat: { id: 99 }, message_id: 1, text: '/admin abc' } }, TG);
assert.equal(kv.get('admin'), '99');

// /start: постоянная кнопка внизу + первый шаг подбора
sent.length = 0;
await post('/tg', { message: { chat: { id: 7 }, message_id: 1, text: '/start' } }, TG);
assert.deepEqual(sent[0].reply_markup.keyboard, [[{ text: '🔎 Подобрать тур за 1 минуту' }]]);
assert.ok(sent[0].reply_markup.input_field_placeholder.length <= 64); // лимит Telegram
assert.match(sent[1].text, /Сколько взрослых/); // первым шагом — туристы
let wizardId = msgId;

// клиент проходит шаги, нажимая кнопки
const press = async label => {
  const btn = sent.at(-1).reply_markup.inline_keyboard.flat().find(b => b.text === label);
  assert.ok(btn, 'нет кнопки ' + label);
  sent.length = 0;
  await post('/tg', { callback_query: { id: 'q', data: btn.callback_data, message: { chat: { id: 7 }, message_id: wizardId } } }, TG);
  assert.ok(btn.callback_data.length <= 64);
};
const wizard = async () => {
  await press('2'); assert.match(sent.at(-1).text, /Сколько детей/);
  await press('1'); assert.match(sent.at(-1).text, /Возраст 1-го ребёнка/);
  assert.deepEqual(sent.at(-1).reply_markup.inline_keyboard.flat().map(b => b.text), ['до 2', ...Array.from({ length: 16 }, (_, i) => String(i + 2))]);
  await press('5'); assert.match(sent.at(-1).text, /Питание/);
  assert.deepEqual(sent.at(-1).reply_markup.inline_keyboard.flat().map(b => b.text),
    ['Любое', 'Без питания', 'BB - Только завтрак', 'HB - Завтрак, Ужин', 'FB - Полный Пансион', 'AI - Все Включено', 'UAI - Ультра Все Включено']);
  await press('BB - Только завтрак'); assert.match(sent.at(-1).text, /Выберите страну/);
  const countryBtns = sent.at(-1).reply_markup.inline_keyboard.flat().map(b => b.text);
  assert.equal(countryBtns.length, 43); // «Любая страна» + 42 страны Tourvisor из Астаны
  assert.deepEqual(countryBtns.slice(1, 5), ['Турция', 'Египет', '🔥 Таиланд', '🔥 ОАЭ']); // 🔥 — есть горящие туры
  await press('🔥 Таиланд'); assert.match(sent.at(-1).text, /Выберите курорт/);
  // курорты как в Tourvisor: «Любой» + курорты страны без мелких районов (Патонг — район Пхукета)
  assert.deepEqual(sent.at(-1).reply_markup.inline_keyboard.flat().map(b => b.text), ['Любой курорт', 'Пхукет', 'Паттайя']);
  await press('Пхукет'); assert.match(sent.at(-1).text, /Курорт: Пхукет[\s\S]*Сколько ночей/);
  await press('6–9 ночей'); assert.match(sent.at(-1).text, /Когда хотите лететь/);
  await press('Ближайшие 2 недели');
};
await wizard();

// итог: запрос → «ищу» (удаляется) → 3 подборки по рейтингу → горящий тур → кнопка заявки
assert.match(sent[1].text, /Туристы: 2 взр\. \+ 1 ребёнок \(5 лет\)\nПитание: BB - Только завтрак \(или лучше\)\nСтрана: Таиланд\nКурорт: Пхукет\nНочей: 6–9\nПериод: Ближайшие 2 недели/);
assert.match(sent[2].text, /Ищу туры/);
assert.equal(sent[3].method, 'deleteMessage');
// в поиск Tourvisor ушли параметры клиента
const sq = new URL(tvCalls.find(u => u.includes('modsearch'))).searchParams;
assert.deepEqual(['country', 'regions', 'departure', 'adults', 'child', 'childage1', 'meal', 'nightsfrom', 'nightsto', 'currency'].map(k => sq.get(k)), ['2', '6', '59', '2', '1', '5', '3', '6', '9', '3']);
const groups = sent.slice(4, 7);
// оформление «Цветные метки»: линии, 🟢/🟡/🟠 по рейтингу, ⭐ по числу звёзд
assert.deepEqual(groups.map(m => m.text.match(/(🟢|🟡|🟠) <b>РЕЙТИНГ ([^<]+)</).slice(1).join(' ')), ['🟢 4,5–5', '🟡 4–4,5', '🟠 3,7–4']);
assert.match(groups[0].text, /^━+\n🟢 <b>РЕЙТИНГ 4,5–5<\/b>\n━+\n1️⃣ <b>ALPHA RESORT<\/b>\n {6}⭐⭐⭐⭐⭐  🟢 <b>4,8<\/b>\n {6}Пхукет · 06\.12 · 7 ноч\. · BB - Завтрак\n {6}💰 <b>100\s000 ₸<\/b>/);
assert.match(groups[1].text, /BETA HOTEL[\s\S]*⭐⭐⭐⭐  🟡 <b>4,2/);
assert.match(groups[2].text, /GAMMA INN[\s\S]*⭐⭐⭐  🟠 <b>3,8/);
assert.match(sent.at(-1).text, /В стоимость включено:<\/b> перелёт, трансфер, проживание, питание по концепции, медстраховка, тур код\n⏱ <b>Стоимость актуальна на момент поиска<\/b>/);
assert.ok(!sent.some(m => /LOW HOTEL/.test(m.text || ''))); // рейтинг 3,2 не показываем
// кнопка отеля ведёт на этот отель, дату и ночи; последняя — все варианты группы
const hb = new URL(groups[0].reply_markup.inline_keyboard[0][0].url).searchParams;
assert.deepEqual([hb.get('x_hotel_codes'), hb.get('s_j_date_from'), hb.get('s_nights_from')], ['1', '06.12.2026', '7']);
assert.equal(new URL(groups[0].reply_markup.inline_keyboard.at(-1)[0].url).searchParams.get('s_rating'), '5');
const photos = sent.filter(m => m.method === 'sendPhoto');
assert.deepEqual(photos.map(m => m.caption.match(/Тур \d/)[0]), ['Тур 2']);
assert.deepEqual(photos[0].reply_markup.inline_keyboard[0].map(b => b.url), ['https://tourcart.ru/#tvofferid=2', 'https://wa.me/1?text=' + encodeURIComponent('Здравствуйте! Хочу забронировать тур: Тур 2')]);
assert.match(decodeURIComponent(sent.at(-1).reply_markup.inline_keyboard[0][0].url), /Подберите, пожалуйста, тур\.\nТуристы: 2 взр\./);
const resultIds = [msgId - 4, msgId - 3, msgId - 2, msgId - 1, msgId]; // 3 подборки, фото тура, кнопка заявки

// «Подобрать тур» удаляет старую подборку (шаги, результаты, само нажатие) и начинает заново
sent.length = 0;
await post('/tg', { message: { chat: { id: 7 }, message_id: 55, text: '🔎 Подобрать тур за 1 минуту' } }, TG);
assert.equal(sent[0].method, 'deleteMessages');
assert.deepEqual(sent[0].message_ids.sort(), [wizardId, ...resultIds, 55].sort());
assert.match(sent[1].text, /Сколько взрослых/);
assert.equal(sent.length, 2); // без повторного приветствия
wizardId = msgId;

// тот же запрос повторно — берётся из сохранённого, Tourvisor не дёргаем
tvCalls.length = 0;
await wizard();
assert.equal(tvCalls.length, 0);

// Tourvisor заблокировал: клиенту — ссылки, владельцу — сообщение о сбое
for (const k of kv.keys()) if (k.startsWith('q:')) kv.delete(k); // убираем сохранённые результаты поиска
tvMode = 'down';
sent.length = 0;
await post('/tg', { message: { chat: { id: 7 }, message_id: 60, text: '🔎 Подобрать тур за 1 минуту' } }, TG);
wizardId = msgId;
await wizard();
const alert = sent.find(m => m.chat_id === '99');
assert.match(alert.text, /Поиск Tourvisor не сработал/);
const links = sent.find(m => /Подборки по рейтингу/.test(m.text || ''));
assert.deepEqual(links.reply_markup.inline_keyboard.map(r => r[0].text), ['⭐ Рейтинг 4,5 и выше', '⭐ Рейтинг 4,0 и выше', '⭐ Рейтинг 3,5 и выше']);
const lq = new URL(links.reply_markup.inline_keyboard[0][0].url).searchParams;
assert.equal(lq.get('s_region_to'), '6'); // Пхукет
assert.deepEqual(['s_rating', 's_country', 's_flyfrom', 's_adults', 's_child', 's_child_age_1', 's_meal'].map(k => lq.get(k)), ['5', '2', '59', '2', '1', '5', '3']);
const day = s => Date.UTC(...s.split('.').reverse().map((v, i) => (i === 1 ? v - 1 : +v)));
assert.ok((day(lq.get('s_j_date_to')) - day(lq.get('s_j_date_from'))) / 864e5 <= 20); // лимит Tourvisor — 21 день
// второй сбой подряд — владельцу повторно не пишем (не чаще раза в 6 часов)
sent.length = 0;
await post('/tg', { message: { chat: { id: 7 }, message_id: 61, text: '🔎 Подобрать тур за 1 минуту' } }, TG);
wizardId = msgId;
await wizard();
assert.ok(!sent.some(m => m.chat_id === '99'));

// подборка дня для канала: все страны вместе, топ-3 самых дешёвых в группах рейтинга и звёздности
const fake = async w => [
  { id: 10 + +w.c, name: 'TOP ' + w.c, rating: 4.7, stars: 5, region: 'Курорт', price: 900000 + +w.c, date: '20.11.2026', nights: 7, meal: 'AI' },
  { id: 20 + +w.c, name: 'MID ' + w.c, rating: 4.1, stars: 4, region: 'Курорт', price: 500000 + +w.c, date: '20.11.2026', nights: 7, meal: 'BB' },
  { id: 30 + +w.c, name: 'LOW ' + w.c, rating: 3.8, stars: 3, region: 'Курорт', price: 300000 + +w.c, date: '20.11.2026', nights: 7, meal: 'RO' },
];
const failEgypt = async w => (w.c === '1' ? Promise.reject(new Error('нет ответа')) : fake(w)); // Египет не ответил — остальные страны есть
const d = await channelDigest(env, new Date(), failEgypt);
assert.match(d.text, /ПОДБОРКА ДНЯ/);
assert.match(d.text, /👥 2 взрослых · 📅 вылет в ближайшие 2 недели · 🌙 6–9 ночей\n✅ <b>В стоимость включено:<\/b> перелёт, трансфер, проживание, питание по концепции, медстраховка, тур код\n⏱ <b>Стоимость актуальна на момент публикации<\/b>/);
assert.equal((d.text.match(/<a href=/g) || []).length, 21); // 6 групп × 3 отеля + 3 горящих
// самый дешёвый из 4,5+ — Турция (+0)
assert.match(d.text, /🟢 <b>РЕЙТИНГ 4,5–5<\/b>\n━+\n1️⃣ <b><a href="[^"]+">TOP 0<\/a><\/b>\n {6}⭐⭐⭐⭐⭐  🟢 <b>4,7<\/b>\n {6}Турция, Курорт/);
assert.ok(!/Египет/.test(d.text));
assert.match(d.text, /🌟 <b>ПЯТЬ ЗВЁЗД<\/b>\n━+\n1️⃣ [^\n]*TOP 0/);
assert.ok(d.text.replace(/<[^>]+>/g, '').length < 4096); // лимит длины сообщения Telegram
assert.match(d.text, /🔥 <b>ГОРЯЩИЕ<\/b>\n━+\n1️⃣ <b><a href="https:\/\/tourcart\.ru\/#tvofferid=2">Тур 2<\/a><\/b>/); // самая большая скидка (50%) первой

// горящие в подборке: вылет не раньше чем через 2 дня; название отеля берётся из описания
const day0 = new Date();
const desc = (days, hotel) => { const x = new Date(Date.now() + days * 864e5); return `5*, ОАЭ из Астаны ${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]} на 9 ночей, Завтрак. ${hotel} одно здание`; };
const hotEnv = { TOUR_LINK: 'https://tourcart.ru/#tvofferid={id}', TOURS: { get: async () => JSON.stringify({ items: [
  { id: 'a', country: 'ОАЭ', title: 'Завтра', descr: desc(1, 'TOMORROW HOTEL 5*'), price: 100, oldPrice: 1000, discount: '-90%' },
  { id: 'b', country: 'ОАЭ', title: 'Скоро', descr: desc(3, 'W DUBAI THE PALM 5*'), price: 500, oldPrice: 1000, discount: '-50%' },
] }) } };
const hb2 = await hotBlock(hotEnv, day0);
assert.ok(!/TOMORROW/.test(hb2)); // через 1 день — не берём
assert.match(hb2, /1️⃣ <b><a href="https:\/\/tourcart\.ru\/#tvofferid=b">W DUBAI THE PALM 5\*<\/a><\/b>\n {6}ОАЭ · \d\d\.\d\d · 9 ноч\. · BB - Только завтрак\n {6}💰 <b>500 ₸<\/b> <s>1\s000 ₸<\/s> <b>-50%<\/b>/);

// вечерние «Горящие»: топ-5, кнопка, пусто → null
const hot = await channelHot(hotEnv, day0);
assert.match(hot.text, /^🔥 <b>ГОРЯЩИЕ ТУРЫ · [^<]+<\/b>[\s\S]*тур код[\s\S]*Стоимость актуальна на момент публикации[\s\S]*W DUBAI THE PALM 5\*/);
assert.equal(hot.kb[0][0].text, '🔎 Подобрать тур за 1 минуту');
assert.equal(await channelHot({ TOURS: { get: async () => null } }, day0), null);

// погода: Астана и курорт дня в сезоне, температура воды, на сколько теплее
const nov = new Date(Date.UTC(2026, 10, 10, 10));
assert.ok(['Пхукет', 'Шарм-эль-Шейх', 'Дубай', 'Фукуок', 'Санья (Хайнань)', 'Мальдивы', 'Гоа', 'Хургада'].includes(resortOfDay(nov)[0]));
assert.ok(!['Анталья', 'Шри-Ланка'].includes(resortOfDay(nov)[0])); // в ноябре там не сезон
const wr = await channelWeather(env, nov);
assert.match(wr.text, /АСТАНА<\/b>\n━+\n {6}🌨 снег\n {6}днём <b>-3°<\/b> · ночью -10°/);
assert.match(wr.text, /🌤 малооблачно\n {6}днём <b>\+31°<\/b> · ночью \+25°\n {6}🌊 вода <b>\+30°<\/b>/);
assert.match(wr.text, /Там на <b>35°<\/b> теплее, чем в Астане/);
assert.equal(wr.kb[0][0].url, 'https://t.me/HotToursAstana_bot');
assert.equal(wr.kb[0][0].text, '🔎 Подобрать тур за 1 минуту'); // кнопка в погоде
assert.equal(d.kb[0][0].url, 'https://t.me/HotToursAstana_bot');
for (const b of [d.kb[0][0]]) assert.equal(b.text, '🔎 Подобрать тур за 1 минуту'); // кнопка в подборке дня
await assert.rejects(channelDigest(env, new Date(), async () => { throw new Error('блок'); }), /ни одна страна не ответила/);

// новости: только про туризм, без повторов, источник указан; второй раз — ничего нового
const n1 = await channelNews(env);
assert.match(n1, /SCAT возьмет в лизинг два Boeing<\/a> — Курсив/);
assert.match(n1, /Анапа получила статус курорта<\/a> — TourDom/);
assert.ok(!/Курс тенге/.test(n1)); // не про туризм
assert.equal((n1.match(/SCAT/g) || []).length, 1); // одинаковый заголовок из двух лент — один раз
assert.equal(await channelNews(env), null);

// вечерний пост: картинка от нейросети + призыв; каждый день другой креатив; без картинки — пост текстом
const aiPrompts = [];
const aiEnv = { ...env, AI: { run: async (model, o) => { aiPrompts.push(o.prompt); return { image: btoa('FAKEJPEG') }; } } };
const ev1 = await channelEvening(aiEnv, new Date(Date.UTC(2026, 10, 10, 15)));
const ev2 = await channelEvening(aiEnv, new Date(Date.UTC(2026, 10, 11, 15)));
assert.equal(new TextDecoder().decode(ev1.image), 'FAKEJPEG');
assert.ok(ev1.text !== ev2.text && aiPrompts[0] !== aiPrompts[1]); // креативы меняются
assert.match(ev1.text, /^🌅 <b>[^<]+<\/b>\n\n[\s\S]*Иллюстрация создана нейросетью/);
assert.ok(ev1.text.replace(/<[^>]+>/g, '').length < 1024); // лимит подписи к фото
assert.equal(ev1.kb[0][0].url, 'https://t.me/HotToursAstana_bot');
assert.equal(ev1.kb[0][0].text, '🔎 Подобрать тур за 1 минуту'); // кнопка в вечернем посте
assert.match(decodeURIComponent(ev1.kb[1][0].url), /^https:\/\/wa\.me\/1\?text=Здравствуйте! Хочу в отпуск: /);
sent.length = 0;
const rr = await worker.fetch(new Request('https://x/run?job=evening', { method: 'POST', headers: { 'x-secret': 's' } }), aiEnv, ctx);
assert.equal((await rr.json()).ok, true);
assert.deepEqual([sent[0].method, sent[0].upload, sent[0].chat_id, sent[0].size > 0], ['sendPhoto', true, '@ch', true]);
// to=admin — предпросмотр только владельцу, не в канал
sent.length = 0;
await worker.fetch(new Request('https://x/run?job=evening&to=admin', { method: 'POST', headers: { 'x-secret': 's' } }), aiEnv, ctx);
assert.deepEqual([sent[0].method, sent[0].chat_id], ['sendPhoto', '99']);
sent.length = 0;
kv.delete('alerted'); // ограничение «не чаще раза в 6 часов» в этой проверке уже сработало
const noAi ={ ...env, AI: { run: async () => { throw new Error('лимит нейросети'); } } };
await worker.fetch(new Request('https://x/run?job=evening', { method: 'POST', headers: { 'x-secret': 's' } }), noAi, ctx);
assert.equal(sent.find(m => m.chat_id === '@ch').method, 'sendMessage'); // пост вышел без картинки
assert.match(sent.find(m => m.chat_id === '99').text, /Вечерняя картинка не нарисовалась/); // владельцу — сообщение

assert.equal((await worker.fetch(new Request('https://x/update', { method: 'OPTIONS' }), env, ctx)).headers.get('access-control-allow-origin'), 'https://pro.tourvisor.ru');
assert.equal((await worker.fetch(new Request('https://x/.git/HEAD'), env, ctx)).status, 404);
console.log('OK');
