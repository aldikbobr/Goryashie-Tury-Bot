// Telegram-бот «Горящие туры».
// POST /update  — сюда раз в день приходят туры из кабинета Tourvisor (заголовок X-Secret).
// POST /tg      — сюда Telegram присылает сообщения клиентов.
// Секреты (wrangler secret put): BOT_TOKEN, UPDATE_SECRET, TG_SECRET.
// Переменные (wrangler.jsonc): CHANNEL_ID, CONTACT_URL, POSTS_PER_UPDATE.

const tg = (env, method, body) =>
  fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json());

const MENU_BUTTON = '🔥 Подобрать тур';
const money = n => n.toLocaleString('ru-RU').replace(/,/g, ' ') + ' ₸';
const esc = s => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

function caption(t, updated) {
  const old = t.oldPrice > t.price ? ` <s>${money(t.oldPrice)}</s>` : '';
  const time = updated ? `\n\n<i>Цена на ${new Date(updated).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}, наличие уточняйте у менеджера</i>` : '';
  return `🔥 <b>${esc(t.title)}</b>\n\n${esc(t.descr).slice(0, 600)}\n\n💰 <b>${money(t.price)}</b>${old} ${esc(t.discount)}${time}`;
}

function buttons(env, t) {
  const row = [{ text: 'Посмотреть тур', url: env.TOUR_LINK.replace('{id}', t.id) }];
  // в WhatsApp сразу подставляется название тура, чтобы менеджер понял, о чём речь
  if (env.CONTACT_URL) row.push({ text: 'Забронировать', url: `${env.CONTACT_URL}?text=${encodeURIComponent(`Здравствуйте! Хочу забронировать тур: ${t.title}`)}` });
  return { inline_keyboard: [row] };
}

function sendTour(env, chat_id, t, updated) {
  const reply_markup = buttons(env, t);
  const text = caption(t, updated);
  // подпись к фото в Telegram — не больше 1024 символов
  return t.img && text.length <= 1024
    ? tg(env, 'sendPhoto', { chat_id, photo: t.img, caption: text, parse_mode: 'HTML', reply_markup })
    : tg(env, 'sendMessage', { chat_id, text, parse_mode: 'HTML', reply_markup });
}

async function onUpdate(req, env) {
  if (req.headers.get('x-secret') !== env.UPDATE_SECRET) return new Response('forbidden', { status: 403 });
  const data = await req.json();
  if (!Array.isArray(data.items) || !data.items.length) return new Response('empty list', { status: 400 });
  await env.TOURS.put('tours', JSON.stringify(data));

  // в канал — только туры, которых там ещё не было, с самой большой скидкой
  const posted = new Set(JSON.parse((await env.TOURS.get('posted')) || '[]'));
  const fresh = data.items.filter(t => !posted.has(t.id))
    .sort((a, b) => (b.oldPrice - b.price) / (b.oldPrice || 1) - (a.oldPrice - a.price) / (a.oldPrice || 1))
    .slice(0, Number(env.POSTS_PER_UPDATE || 3));
  let sent = 0;
  for (const t of env.CHANNEL_ID ? fresh : []) {
    const r = await sendTour(env, env.CHANNEL_ID, t, data.updated);
    if (r.ok) { posted.add(t.id); sent++; }
  }
  // ponytail: храним последние 500 id, этого хватает на месяцы
  await env.TOURS.put('posted', JSON.stringify([...posted].slice(-500)));
  return Response.json({ saved: data.items.length, posted: sent });
}

// ---------- Пошаговый подбор: страна → взрослые → дети и их возраст → ночи → период ----------
// Выбор хранится прямо в кнопках: w:страна:взрослые:дети:возрасты:ночи:период (страна и период — номера в списках).

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTH_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const NIGHTS = [['3–5 ночей', 3, 5], ['6–9 ночей', 6, 9], ['10–14 ночей', 10, 14], ['Любое', 0, 99]];
const DAY = 864e5;

// "…из Астаны 18 ноября на 14 ночей…" → дата вылета и количество ночей
export function tourInfo(t, now = new Date()) {
  const m = (t.descr || '').match(/(\d{1,2}) (января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря) на (\d+) ноч/);
  if (!m) return {};
  const mon = MONTHS.indexOf(m[2]);
  const year = now.getUTCFullYear() + (mon < now.getUTCMonth() - 1 ? 1 : 0); // январь при текущем ноябре — следующий год
  return { date: new Date(Date.UTC(year, mon, +m[1])), nights: +m[3] };
}

export function periods(now = new Date()) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const list = [['Ближайшие 2 недели', today, today + 14 * DAY]];
  for (let i = 0; i < 4; i++) {
    const y = now.getUTCFullYear(), m = now.getUTCMonth() + i;
    list.push([MONTH_NAMES[m % 12], Math.max(today, Date.UTC(y, m, 1)), Date.UTC(y, m + 1, 1) - 1]);
  }
  list.push(['Любой', today, Infinity]); // уже улетевшие туры не показываем
  return list;
}

const countriesOf = data => [...new Set(data.items.map(t => t.country))].sort();
const decode = s => { const [, c = '', a = '', k = '', ages = '', n = '', p = ''] = s.split(':'); return { c, a, k, ages: ages ? ages.split('.') : [], n, p }; };
const encode = w => ['w', w.c, w.a, w.k, w.ages.join('.'), w.n, w.p].join(':');
const pick = (w, field, value) => ({ text: value.text, callback_data: encode({ ...w, [field]: value.v }) });
const rows = (btns, per) => { const r = []; for (let i = 0; i < btns.length; i += per) r.push(btns.slice(i, i + per)); return r; };
const kidsWord = n => (n === 1 ? 'ребёнок' : n < 5 ? 'ребёнка' : 'детей');

function summary(w, data, now) {
  const lines = [];
  if (w.c) lines.push('Страна: ' + (w.c === '*' ? 'любая' : countriesOf(data)[+w.c] || '—'));
  if (w.a) lines.push(`Туристы: ${w.a} взр.` + (+w.k ? ` + ${w.k} ${kidsWord(+w.k)}` + (w.ages.length ? ` (${w.ages.map(a => (a === '0' ? 'до 1 года' : a + ' лет')).join(', ')})` : '') : ''));
  if (w.n) lines.push('Ночей: ' + NIGHTS[+w.n][0].replace(' ночей', ''));
  if (w.p) lines.push('Период: ' + periods(now)[+w.p][0]);
  return lines.join('\n');
}

// следующий вопрос; null — всё выбрано
function step(w, data, now) {
  const head = (summary(w, data, now) ? summary(w, data, now) + '\n\n' : '') + '👉 ';
  if (!w.c) {
    const btns = countriesOf(data).map((c, i) => pick(w, 'c', { text: c, v: String(i) }));
    return { text: head + 'Выберите страну:', kb: [...rows(btns, 2), [pick(w, 'c', { text: 'Любая страна', v: '*' })]] };
  }
  if (!w.a) return { text: head + 'Сколько взрослых?', kb: rows(['1', '2', '3', '4'].map(v => pick(w, 'a', { text: v, v })), 4) };
  if (!w.k) return { text: head + 'Сколько детей?', kb: rows(['0', '1', '2', '3'].map(v => pick(w, 'k', { text: v === '0' ? 'Без детей' : v, v })), 4) };
  if (w.ages.length < +w.k) {
    const btns = Array.from({ length: 18 }, (_, a) => ({ text: a === 0 ? 'до 1' : String(a), callback_data: encode({ ...w, ages: [...w.ages, String(a)] }) }));
    return { text: head + `Возраст ${w.ages.length + 1}-го ребёнка (лет):`, kb: rows(btns, 6) };
  }
  if (!w.n) return { text: head + 'Сколько ночей?', kb: rows(NIGHTS.map((n, i) => pick(w, 'n', { text: n[0], v: String(i) })), 2) };
  if (!w.p) return { text: head + 'Когда хотите лететь?', kb: rows(periods(now).map((p, i) => pick(w, 'p', { text: p[0], v: String(i) })), 2) };
  return null;
}

function matches(w, data, now) {
  const country = w.c === '*' ? null : countriesOf(data)[+w.c];
  const [, nMin, nMax] = NIGHTS[+w.n];
  const [, from, to] = periods(now)[+w.p];
  return data.items.filter(t => {
    const { date, nights } = tourInfo(t, now);
    return (!country || t.country === country) && (!nights || (nights >= nMin && nights <= nMax)) && (!date || (date >= from && date <= to));
  }).sort((a, b) => a.price - b.price).slice(0, 5);
}

// сообщения последней подборки — их удаляем, когда клиент начинает новую
const remember = async (env, chat_id, ids) => {
  const old = JSON.parse((await env.TOURS.get('m:' + chat_id)) || '[]');
  await env.TOURS.put('m:' + chat_id, JSON.stringify([...old, ...ids].slice(-100)), { expirationTtl: 3 * DAY / 1000 });
};

async function startWizard(env, chat_id, data, now) {
  const old = JSON.parse((await env.TOURS.get('m:' + chat_id)) || '[]');
  if (old.length) await tg(env, 'deleteMessages', { chat_id, message_ids: old });
  await env.TOURS.delete('m:' + chat_id);
  if (!data.items.length) return tg(env, 'sendMessage', { chat_id, text: 'Список туров обновляется. Загляните чуть позже.' });
  const s = step(decode('w'), data, now);
  const r = await tg(env, 'sendMessage', { chat_id, text: s.text, reply_markup: { inline_keyboard: s.kb } });
  if (r.ok) await remember(env, chat_id, [r.result.message_id]);
}

async function onTelegram(req, env) {
  if (req.headers.get('x-telegram-bot-api-secret-token') !== env.TG_SECRET) return new Response('forbidden', { status: 403 });
  const u = await req.json();
  const data = JSON.parse((await env.TOURS.get('tours')) || '{"items":[]}');
  const now = new Date();

  if (u.callback_query) {
    const q = u.callback_query, chat_id = q.message.chat.id, message_id = q.message.message_id;
    await tg(env, 'answerCallbackQuery', { callback_query_id: q.id });
    if (!q.data.startsWith('w')) return new Response('ok'); // кнопки из старой версии бота
    const w = decode(q.data);
    const s = step(w, data, now);
    if (s) {
      await tg(env, 'editMessageText', { chat_id, message_id, text: s.text, reply_markup: { inline_keyboard: s.kb } });
      return new Response('ok');
    }
    // всё выбрано: итог + подходящие горящие туры + заявка менеджеру
    const sum = summary(w, data, now);
    await tg(env, 'editMessageText', { chat_id, message_id, text: '✅ Ваш запрос:\n' + sum });
    const ids = [];
    const list = matches(w, data, now);
    for (const t of list) { const r = await sendTour(env, chat_id, t, data.updated); if (r.ok) ids.push(r.result.message_id); }
    const lead = `${env.CONTACT_URL}?text=${encodeURIComponent('Здравствуйте! Подберите, пожалуйста, тур.\n' + sum)}`;
    const r = await tg(env, 'sendMessage', {
      chat_id,
      text: (list.length
        ? 'Цены указаны за размещение из подборки туроператора (обычно 2 взрослых). Точную цену на ваш состав посчитает менеджер.'
        : 'Горящих туров по этим параметрам сейчас нет. Отправьте запрос — менеджер подберёт тур.')
        + '\n\nНовая подборка — кнопка «🔥 Подобрать тур» внизу.',
      reply_markup: env.CONTACT_URL ? { inline_keyboard: [[{ text: '📩 Отправить запрос менеджеру', url: lead }]] } : undefined,
    });
    if (r.ok) ids.push(r.result.message_id);
    await remember(env, chat_id, ids);
    return new Response('ok');
  }

  const chat_id = u.message?.chat?.id;
  if (!chat_id) return new Response('ok');
  if (u.message.text === MENU_BUTTON) {
    // нажатие кнопки тоже убираем вместе со старой подборкой
    await remember(env, chat_id, [u.message.message_id]);
  } else {
    // кнопка «Подобрать тур» всегда внизу экрана, под полем ввода
    await tg(env, 'sendMessage', {
      chat_id,
      text: 'Здравствуйте! Здесь горящие туры из Астаны. Кнопка «🔥 Подобрать тур» всегда внизу экрана.',
      // подсказка в поле ввода видна, даже если клиент свернул кнопку значком ⌘
      reply_markup: { keyboard: [[{ text: MENU_BUTTON }]], resize_keyboard: true, is_persistent: true, input_field_placeholder: 'Подобрать тур — значок справа ⌘' },
    });
  }
  await startWizard(env, chat_id, data, now);
  return new Response('ok');
}

// /update вызывается прямо со страницы кабинета Tourvisor, поэтому разрешаем запросы оттуда
const CORS = { 'access-control-allow-origin': 'https://pro.tourvisor.ru', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type, x-secret' };

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (req.method === 'OPTIONS' && pathname === '/update') return new Response(null, { headers: CORS });
    if (req.method === 'POST' && pathname === '/update') {
      const r = await onUpdate(req, env);
      return new Response(r.body, { status: r.status, headers: { ...Object.fromEntries(r.headers), ...CORS } });
    }
    if (req.method === 'POST' && pathname === '/tg') return onTelegram(req, env);
    return new Response('Not found', { status: 404 });
  },
};
