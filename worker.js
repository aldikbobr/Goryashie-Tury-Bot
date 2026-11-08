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

async function onTelegram(req, env) {
  if (req.headers.get('x-telegram-bot-api-secret-token') !== env.TG_SECRET) return new Response('forbidden', { status: 403 });
  const u = await req.json();
  const data = JSON.parse((await env.TOURS.get('tours')) || '{"items":[]}');

  if (u.callback_query) {
    const chat_id = u.callback_query.message.chat.id;
    await tg(env, 'answerCallbackQuery', { callback_query_id: u.callback_query.id });
    const country = u.callback_query.data.slice(2);
    const list = data.items.filter(t => t.country === country).sort((a, b) => a.price - b.price).slice(0, 5);
    if (!list.length) await tg(env, 'sendMessage', { chat_id, text: 'Сейчас горящих туров в эту страну нет. Загляните позже.' });
    for (const t of list) await sendTour(env, chat_id, t, data.updated);
    return new Response('ok');
  }

  const chat_id = u.message?.chat?.id;
  if (!chat_id) return new Response('ok');
  // кнопка «Подобрать тур» всегда внизу экрана, под полем ввода
  if (u.message.text !== MENU_BUTTON)
    await tg(env, 'sendMessage', {
      chat_id,
      text: 'Здравствуйте! Здесь горящие туры из Астаны. Кнопка «🔥 Подобрать тур» всегда внизу экрана.',
      reply_markup: { keyboard: [[{ text: MENU_BUTTON }]], resize_keyboard: true, is_persistent: true },
    });
  const countries = [...new Set(data.items.map(t => t.country))].sort();
  if (!countries.length) {
    await tg(env, 'sendMessage', { chat_id, text: 'Список туров обновляется. Загляните чуть позже.' });
    return new Response('ok');
  }
  const kb = [];
  for (let i = 0; i < countries.length; i += 2)
    kb.push(countries.slice(i, i + 2).map(c => ({ text: c, callback_data: 'c:' + c })));
  await tg(env, 'sendMessage', {
    chat_id,
    text: 'Выберите страну:',
    reply_markup: { inline_keyboard: kb },
  });
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
