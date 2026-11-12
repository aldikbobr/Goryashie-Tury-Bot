// Telegram-бот «Горящие туры».
// POST /update  — сюда раз в день приходят туры из кабинета Tourvisor (заголовок X-Secret).
// POST /tg      — сюда Telegram присылает сообщения клиентов.
// POST /check-search — проверка поиска Tourvisor с сервера бота (заголовок X-Secret).
// Секреты (wrangler secret put): BOT_TOKEN, UPDATE_SECRET, TG_SECRET, ADMIN_CODE (код для «/admin <код>»).
// Переменные (wrangler.jsonc): CHANNEL_ID, CONTACT_URL, POSTS_PER_UPDATE.

const tg = (env, method, body) =>
  fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json());

// одна и та же кнопка: внизу экрана в боте и под постами канала
const PICK_BUTTON = '🔎 Подобрать тур за 1 минуту';
const MENU_BUTTON = PICK_BUTTON;
const money = n => n.toLocaleString('ru-RU').replace(/,/g, ' ') + ' ₸';
const esc = s => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

function caption(t, updated) {
  const old = t.oldPrice > t.price ? ` <s>${money(t.oldPrice)}</s>` : '';
  const time = updated ? `\n\n<i>Цена на ${new Date(updated).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}, наличие уточняйте у менеджера</i>` : '';
  return `🔥 <b>${esc(t.title)}</b>\n\n${esc(t.descr).slice(0, 600)}\n\n💰 <b>${money(t.price)}</b>${old} ${esc(t.discount)}${time}`;
}

function buttons(env, t) {
  const row = [{ text: 'Посмотреть тур', url: t.link || env.TOUR_LINK.replace('{id}', t.id) }];
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

const depOf = t => t.dep || 'Астана'; // туры старой сборки — из Астаны

async function onUpdate(req, env) {
  if (req.headers.get('x-secret') !== env.UPDATE_SECRET) return new Response('forbidden', { status: 403 });
  const data = await req.json();
  if (!Array.isArray(data.items) || !data.items.length) return new Response('empty list', { status: 400 });
  // туры с городом вылета (dep) заменяют всё; старая сборка без dep — только Астана, остальные города остаются
  const old = JSON.parse((await env.TOURS.get('tours')) || '{"items":[]}').items;
  const all = data.items.every(t => t.dep);
  data.items = [...(all ? [] : old.filter(t => depOf(t) !== 'Астана')), ...data.items.map(t => ({ ...t, dep: depOf(t) }))];
  await env.TOURS.put('tours', JSON.stringify(data));

  // в канал — только туры, которых там ещё не было, с самой большой скидкой
  const posted = new Set(JSON.parse((await env.TOURS.get('posted')) || '[]'));
  const fresh = data.items.filter(t => depOf(t) === 'Астана' && !posted.has(t.id)) // одиночные посты в канал — только вылет из Астаны
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

// ---------- Пошаговый подбор: аэропорт вылета (РК) → взрослые → дети и их возраст → питание → страна → курорт → ночи → период ----------
// Выбор хранится прямо в кнопках: w:страна:взрослые:дети:возрасты:ночи:период (страна и период — номера в списках).

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTH_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const NIGHTS = [['3–5 ночей', 3, 5], ['6–9 ночей', 6, 9], ['10–14 ночей', 10, 14], ['Любое', 0, 99]];
const DAY = 864e5;

// "…из Астаны 18 ноября на 14 ночей…" → дата вылета и количество ночей
export function tourInfo(t, now = new Date()) {
  const m = (t.descr || '').match(/(\d{1,2}) (января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря) на (\d+) ноч/);
  const meal = mealLevel(t.descr || '');
  if (!m) return { meal };
  const mon = MONTHS.indexOf(m[2]);
  const year = now.getUTCFullYear() + (mon < now.getUTCMonth() - 1 ? 1 : 0); // январь при текущем ноябре — следующий год
  return { date: new Date(Date.UTC(year, mon, +m[1])), nights: +m[3], meal };
}

// Питание как в поиске Tourvisor; номер = уровень (чем больше, тем лучше)
const MEALS = ['Без питания', 'BB - Только завтрак', 'HB - Завтрак, Ужин', 'FB - Полный Пансион', 'AI - Все Включено', 'UAI - Ультра Все Включено'];
// "…на 14 ночей, Завтрак. …" → 1; не нашли — undefined (такой тур не отсекаем)
function mealLevel(descr) {
  const m = descr.match(/ноч\S*,\s*([^.]+)\./);
  if (!m) return undefined;
  const s = m[1].toLowerCase().replace(/ё/g, 'е');
  if (s.includes('ультра')) return 5;
  if (s.includes('все включено')) return 4;
  if (s.includes('обед') || s.includes('полный')) return 3;
  if (s.includes('ужин')) return 2;
  if (s.includes('завтрак')) return 1;
  if (s.includes('без питания')) return 0;
  return undefined;
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

// Все страны Tourvisor по аэропортам РК (11.11.2026, 43 шт.): сначала популярные, как у Tourvisor, затем по алфавиту.
// ponytail: список зашит вручную; если у Tourvisor появятся новые направления — дописать сюда.
const COUNTRIES = ['Турция', 'Египет', 'Таиланд', 'ОАЭ', 'Россия', 'Китай', 'Вьетнам',
  'Австрия', 'Азербайджан', 'Армения', 'Бахрейн', 'Беларусь', 'Великобритания', 'Венгрия', 'Греция', 'Грузия', 'Доминикана', 'Индия',
  'Индонезия', 'Испания', 'Италия', 'Казахстан', 'Катар', 'Кипр', 'Кыргызстан', 'Маврикий', 'Малайзия', 'Мальдивы',
  'Марокко', 'Оман', 'Сейшелы', 'Сербия', 'Сингапур', 'Словения', 'Танзания', 'Тунис', 'Узбекистан', 'Франция',
  'Черногория', 'Чехия', 'Шри-Ланка', 'Южная Корея', 'Япония'];
const countriesOf = () => COUNTRIES;

// ---------- Ссылки на поиск Tourvisor с параметрами клиента (проверено 08.11.2026) ----------
const COUNTRY_IDS = { Турция: 4, Египет: 1, Таиланд: 2, ОАЭ: 9, Россия: 47, Китай: 13, Вьетнам: 16, Австрия: 31, Азербайджан: 55,
  Армения: 53, Бахрейн: 59, Беларусь: 57, Великобритания: 44, Венгрия: 37, Греция: 6, Грузия: 54, Доминикана: 11, Индия: 3, Индонезия: 7, Испания: 14,
  Италия: 24, Казахстан: 78, Катар: 79, Кипр: 15, Кыргызстан: 60, Маврикий: 27, Малайзия: 36, Мальдивы: 8, Марокко: 23, Оман: 64,
  Сейшелы: 28, Сербия: 58, Сингапур: 25, Словения: 43, Танзания: 41, Тунис: 5, Узбекистан: 56, Франция: 32, Черногория: 21,
  Чехия: 19, 'Шри-Ланка': 12, 'Южная Корея': 70, Япония: 49 };
const MEAL_IDS = [2, 3, 4, 5, 7, 9]; // RO, BB, HB, FB, AI, UAI — в том же порядке, что MEALS
// у Tourvisor фильтр рейтинга только «от»: s_rating 5 = 4,5+, 4 = 4,0+, 3 = 3,5+
const RATINGS = [['⭐ Рейтинг 4,5 и выше', 5], ['⭐ Рейтинг 4,0 и выше', 4], ['⭐ Рейтинг 3,5 и выше', 3]];
const ddmmyyyy = ms => new Date(ms).toISOString().slice(0, 10).split('-').reverse().join('.');
const countryId = w => COUNTRY_IDS[COUNTRIES[+w.c]];
// Аэропорты вылета в РК — список «Вылет из» в Tourvisor (national=3, проверено 11.11.2026); номер = индекс, 0 = Астана
const DEPARTURES = [['Астана', 59], ['Петропавловск', 98], ['Алматы', 60], ['Шымкент', 79], ['Караганда', 76], ['Актау', 74], ['Актобе', 73],
  ['Атырау', 75], ['Костанай', 68], ['Кызылорда', 77], ['Семей', 121], ['Туркестан', 120], ['Уральск', 84], ['Усть-Каменогорск', 78]];
const depId = w => DEPARTURES[+w.d][1];

// Курорты страны — как список «Любой курорт» в поиске Tourvisor (без мелких районов). Хранятся 7 дней.
const REGIONS = new Map(); // номер страны → [[номер курорта, название], …]
export async function loadRegions(env, cid) {
  if (REGIONS.has(cid)) return REGIONS.get(cid);
  let list = JSON.parse((await env.TOURS.get('r:' + cid)) || 'null');
  if (!list) {
    try {
      const j = await fetch(`https://tourvisor.ru/xml/listdev.php?type=region&regcountry=${cid}&cndep=59&flydeparture=59&flycountry=${cid}&format=json`, { headers: TV_HEADERS }).then(x => x.json());
      list = ((j.lists || j).regions?.region || []).filter(r => +r.parentid === 0).map(r => [r.id, r.name]);
      await env.TOURS.put('r:' + cid, JSON.stringify(list), { expirationTtl: 7 * 86400 });
    } catch { list = []; } // Tourvisor не ответил — шаг «Курорт» пропускаем
  }
  REGIONS.set(cid, list);
  return list;
}
// Какие страны есть у выбранного аэропорта вылета — как в Tourvisor; хранится 7 дней. Не ответил — показываем все.
const AVAIL = new Map(); // номер вылета → [номера стран]
export async function loadCountries(env, dep) {
  if (AVAIL.has(dep)) return;
  let ids = JSON.parse((await env.TOURS.get('c:' + dep)) || 'null');
  if (!ids) {
    try {
      const j = await fetch(`https://tourvisor.ru/xml/listdev.php?type=country&cndep=${dep}&flydeparture=${dep}&format=json`, { headers: TV_HEADERS }).then(x => x.json());
      ids = ((j.lists || j).countries?.country || []).map(c => c.id);
      if (ids.length) await env.TOURS.put('c:' + dep, JSON.stringify(ids), { expirationTtl: 7 * 86400 });
    } catch { ids = []; }
  }
  if (ids.length) AVAIL.set(dep, ids); // сбой не запоминаем — в следующий раз попробуем снова
}
const regionName = w => (REGIONS.get(countryId(w)) || []).find(([id]) => String(id) === w.r)?.[1];

// даты и ночи для Tourvisor: вылеты с завтрашнего дня, не больше 21 дня (лимит Tourvisor)
function range(w, now) {
  const [, nMin, nMax] = NIGHTS[+w.n];
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY;
  let [, from, to] = periods(now)[+w.p];
  from = Math.max(from, tomorrow);
  to = Math.min(to, from + 20 * DAY);
  return { from: ddmmyyyy(from), to: ddmmyyyy(to), nMin: nMin || 3, nMax: nMax === 99 ? 21 : nMax };
}

// hotel — ссылка на конкретный отель, дату и ночи (как в ссылках самого Tourvisor)
export function searchLink(w, now, rating, hotel) {
  const r = range(w, now);
  const p = new URLSearchParams({
    ts_dosearch: 1, s_form_mode: 0, s_regular: 1, s_flyfrom: depId(w), s_currency: 3, // цены в тенге
    s_country: COUNTRY_IDS[COUNTRIES[+w.c]], s_adults: w.a,
    s_nights_from: hotel ? hotel.nights : r.nMin, s_nights_to: hotel ? hotel.nights : r.nMax,
    s_j_date_from: hotel ? hotel.date : r.from, s_j_date_to: hotel ? hotel.date : r.to, s_rating: rating,
  });
  if (hotel) p.set('x_hotel_codes', hotel.id);
  if (w.r && w.r !== '*') p.set('s_region_to', w.r);
  if (+w.k) { p.set('s_child', w.k); w.ages.forEach((a, i) => p.set(`s_child_age_${i + 1}`, a === '0' ? 1 : a)); }
  if (w.f !== '*') p.set('s_meal', MEAL_IDS[+w.f]); // Tourvisor ищет «и лучше»
  return 'https://tourvisor.ru/search.php?' + p;
}

// ---------- Поиск туров прямо через сайт Tourvisor (неофициально; при сбое бот переходит на ссылки) ----------
const TV_HEADERS = { Referer: 'https://tourvisor.ru/search.php' };
const GROUPS = [['4,5–5', 4.5, 99, 5], ['4–4,5', 4.0, 4.5, 4], ['3,7–4', 3.7, 4.0, 3]]; // название, от, до (не включая), s_rating для ссылки

export async function tvSearch(w, now, wait = ms => new Promise(r => setTimeout(r, ms))) {
  const r = range(w, now);
  const p = new URLSearchParams({
    datefrom: r.from, dateto: r.to, nightsfrom: r.nMin, nightsto: r.nMax, adults: w.a, child: +w.k || 0,
    meal: w.f === '*' ? 0 : MEAL_IDS[+w.f], rating: 3, // 3 = от 3,5; дальше делим на группы сами
    country: COUNTRY_IDS[COUNTRIES[+w.c]], departure: depId(w), currency: 3,
    directflight: 0, regular: 1, pricefrom: 0, priceto: 0, formmode: 0, origincountry: 3, pricetype: 0,
  });
  w.ages.forEach((a, i) => p.set(`childage${i + 1}`, a === '0' ? 1 : a));
  if (w.r && w.r !== '*') p.set('regions', w.r);
  const start = await fetch('https://tourvisor.ru/xml/modsearch.php?' + p, { headers: TV_HEADERS }).then(x => x.json());
  const id = start?.result?.requestid;
  if (!id) throw new Error('нет requestid: ' + JSON.stringify(start).slice(0, 100));
  let data;
  for (let i = 0; i < 6; i++) { // до ~18 секунд; обычно хватает 5
    await wait(3000);
    data = (await fetch('https://search3.tourvisor.ru/modresult.php?requestid=' + id, { headers: TV_HEADERS }).then(x => x.json())).data;
    if (data?.status?.finished) break;
  }
  if (!data?.block || !data?.decode?.hotels) throw new Error('пустой ответ: ' + JSON.stringify(data?.status || data).slice(0, 100));
  const best = new Map(); // у одного отеля несколько туроператоров — берём самую низкую цену
  for (const h of data.block.flatMap(b => b.hotel || [])) {
    const t = (h.tour || []).reduce((m, x) => (!m || x.pr < m.pr ? x : m), null);
    if (t && (!best.has(h.id) || t.pr < best.get(h.id).price)) best.set(h.id, { id: h.id, price: t.pr, date: t.dt.split('-').reverse().join('.'), nights: t.nt, ml: t.ml });
  }
  return [...best.values()].map(h => {
    const d = data.decode.hotels[h.id] || {};
    const descr = String(d.desc || '');
    const adult = ADULT_RE.test(descr); // концепция только по описанию отеля: у Tourvisor отдельного признака нет
    return { ...h, name: d.name || 'Отель', rating: parseFloat(d.rating) || 0, stars: +d.stars || 0, region: d.region || '', meal: data.decode.meal?.[h.ml]?.nameshort || '', adult, kids: !adult && KIDS_RE.test(descr) };
  });
}

const ADULT_RE = /только для взрослых|adults? only|(?:^|\D)(?:16|18)\s?\+|гостей старше (?:16|18)/i;
const KIDS_RE = /аквапарк|водные горки|водных горок|мини-клуб|детск(?:ий|ая|ое|ой|ую|ие|их) (?:клуб|площадк|бассейн|горк|анимац|меню|программ|комнат)|для детей/i;

export function groupHotels(hotels) {
  return GROUPS.map(([title, from, to, rating]) => ({
    title, rating, from,
    hotels: hotels.filter(h => h.rating >= from && h.rating < to).sort((a, b) => a.price - b.price).slice(0, 3),
  }));
}

// ---------- Оформление подборок: «Цветные метки» (выбрал Аслан 10.11.2026) ----------
// 🟢 рейтинг 4,5+ · 🟡 4–4,5 · 🟠 3,7–4; звёзды отеля — ⭐ по числу звёзд; группы разделены линиями
const INCLUDED = '✅ <b>В стоимость включено:</b> перелёт, трансфер, проживание, питание по концепции, медстраховка, тур код';
const LINE = '━━━━━━━━━━━━━━━━';
const NUM = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const badge = r => (r >= 4.5 ? '🟢' : r >= 4 ? '🟡' : '🟠');
const groupHeader = title => `${LINE}\n${title}\n${LINE}`;
const ratingTitle = g => `${badge(g.from)} <b>РЕЙТИНГ ${g.title}</b>`;
function hotelCard(h, i, place, link) {
  const name = link ? `<a href="${link}">${esc(h.name)}</a>` : esc(h.name);
  return `${NUM[i]} <b>${name}</b>\n      ${'⭐'.repeat(h.stars || 0)}  ${badge(h.rating)} <b>${String(h.rating).replace('.', ',')}</b>\n` +
    `      ${esc(place)} · ${h.date.slice(0, 5)} · ${h.nights} ноч. · ${esc(h.meal)}\n      💰 <b>${money(h.price)}</b>`;
}

// подборки по звёздности (5/4/3) и раздел концепции: взрослая 16+/18+ — если едут только взрослые, детская — если с детьми
const cheapest3 = list => [...list].sort((a, b) => a.price - b.price).slice(0, 3);
const starGroups = hotels => STAR_GROUPS.map(([title, s]) => ({ head: `🌟 <b>${title}</b>`, rating: 0, hotels: cheapest3(hotels.filter(h => h.stars === s && h.rating >= 3.7)) }));

// раздел концепции: одна шапка с чёрточками, внутри та же разбивка — рейтинг и звёздность, только по отелям этой концепции
export function conceptMessages(w, now, hotels) {
  const kids = +w.k > 0;
  const own = hotels.filter(h => (kids ? h.kids : h.adult));
  const subs = [...groupHotels(own).map(g => ({ ...g, head: ratingTitle(g) })), ...starGroups(own)].filter(g => g.hotels.length);
  const head = groupHeader(kids ? '🧒 <b>ДЕТСКАЯ КОНЦЕПЦИЯ</b>' : '🔞 <b>ВЗРОСЛАЯ КОНЦЕПЦИЯ 16+ / 18+</b>') + '\n';
  const out = [];
  for (const g of subs) {
    const text = g.head + '\n' + g.hotels.map((h, i) => hotelCard(h, i, h.region)).join('\n\n');
    const kb = g.hotels.map((h, i) => [{ text: `${i + 1}. ${h.name} — ${money(h.price)}`, url: searchLink(w, now, 0, h) }]);
    const last = out.at(-1);
    if (last && last.text.length + text.length < 3500) { last.text += '\n\n' + text; last.kb.push(...kb); } // лимит Telegram 4096 знаков
    else out.push({ text: (out.length ? '' : head) + text, kb });
  }
  return out;
}

function groupMessage(w, now, g) {
  const cards = g.hotels.map((h, i) => hotelCard(h, i, h.region));
  return {
    text: groupHeader(g.head || ratingTitle(g)) + '\n' + (cards.join('\n\n') || 'Под ваш запрос отелей с таким рейтингом не нашлось.'),
    kb: [
      ...g.hotels.map((h, i) => [{ text: `${i + 1}. ${h.name} — ${money(h.price)}`, url: searchLink(w, now, 0, h) }]),
      [{ text: 'Все варианты на Tourvisor', url: searchLink(w, now, g.rating) }],
    ],
  };
}

// подборки по рейтингу: результат поиска хранится 30 минут, чтобы не искать одно и то же повторно
async function ratingSelections(env, w, now) {
  const key = 'q:' + [w.d, w.a,w.k, w.ages.join('.'), w.f, w.c, w.r, w.n, w.p, range(w, now).from].join(':');
  const cached = await env.TOURS.get(key);
  if (cached) return JSON.parse(cached);
  const hotels = await tvSearch(w, now);
  await env.TOURS.put(key, JSON.stringify(hotels), { expirationTtl: 1800 });
  return hotels;
}

// сообщение владельцу бота о сбое поиска — не чаще раза в 6 часов
async function alertAdmin(env, text) {
  const admin = await env.TOURS.get('admin');
  if (!admin || (await env.TOURS.get('alerted'))) return;
  await env.TOURS.put('alerted', '1', { expirationTtl: 6 * 3600 });
  await tg(env, 'sendMessage', { chat_id: admin, text: '⚠️ ' + text });
}
const decode = s => { const [, c = '', a = '', k = '', ages = '', n = '', p = '', f = '', r = '', d = ''] = s.split(':'); return { c, a, k, ages: ages ? ages.split('.') : [], n, p, f, r, d }; };
const encode = w => ['w', w.c, w.a, w.k, w.ages.join('.'), w.n, w.p, w.f, w.r, w.d].join(':');
const pick = (w, field, value) => ({ text: value.text, callback_data: encode({ ...w, [field]: value.v }) });
const rows = (btns, per) => { const r = []; for (let i = 0; i < btns.length; i += per) r.push(btns.slice(i, i + per)); return r; };
const kidsWord = n => (n === 1 ? 'ребёнок' : n < 5 ? 'ребёнка' : 'детей');

function summary(w, data, now) {
  const lines = [];
  if (w.d) lines.push('Вылет: ' + DEPARTURES[+w.d][0]);
  if (w.a) lines.push(`Туристы: ${w.a} взр.` + (+w.k ? ` + ${w.k} ${kidsWord(+w.k)}` + (w.ages.length ? ` (${w.ages.map(a => (a === '0' ? 'до 2 лет' : a + (['2', '3', '4'].includes(a) ? ' года' : ' лет'))).join(', ')})` : '') : ''));
  if (w.f) lines.push('Питание: ' + (w.f === '*' ? 'любое' : MEALS[+w.f] + (+w.f > 0 ? ' (или лучше)' : '')));
  if (w.c) lines.push('Страна: ' + (w.c === '*' ? 'любая' : countriesOf(data)[+w.c] || '—'));
  if (w.r && w.c !== '*') lines.push('Курорт: ' + (w.r === '*' ? 'любой' : regionName(w) || '—'));
  if (w.n) lines.push('Ночей: ' + NIGHTS[+w.n][0].replace(' ночей', ''));
  if (w.p) lines.push('Период: ' + periods(now)[+w.p][0]);
  return lines.join('\n');
}

// следующий вопрос; null — всё выбрано
function step(w, data, now) {
  const head = (summary(w, data, now) ? summary(w, data, now) + '\n\n' : '') + '👉 ';
  if (!w.d) return { text: head + 'Из какого аэропорта вылет?', kb: rows(DEPARTURES.map(([name], i) => pick(w, 'd', { text: name, v: String(i) })), 2) };
  if (!w.a) return { text: head + 'Сколько взрослых?', kb: rows(['1', '2', '3', '4'].map(v => pick(w, 'a', { text: v, v })), 4) };
  if (!w.k) return { text: head + 'Сколько детей?', kb: rows(['0', '1', '2', '3'].map(v => pick(w, 'k', { text: v === '0' ? 'Без детей' : v, v })), 4) };
  if (w.ages.length < +w.k) {
    // «до 2» (значение 0), затем 2…17 лет
    const btns = [0, ...Array.from({ length: 16 }, (_, i) => i + 2)].map(a => ({ text: a === 0 ? 'до 2' : String(a), callback_data: encode({ ...w, ages: [...w.ages, String(a)] }) }));
    return { text: head + `Возраст ${w.ages.length + 1}-го ребёнка (лет):`, kb: rows(btns, 6) };
  }
  if (!w.f) return {
    text: head + 'Питание (подберём это или лучше):',
    kb: [[pick(w, 'f', { text: 'Любое', v: '*' })], ...rows(MEALS.map((m, i) => pick(w, 'f', { text: m, v: String(i) })), 2)],
  };
  if (!w.c) {
    // 🔥 — по этой стране сейчас есть горящие туры
    const hot = new Set(data.items.filter(t => depOf(t) === DEPARTURES[+w.d][0]).map(t => t.country)); // горящие из выбранного города
    const ok = AVAIL.get(depId(w)) || []; // пусто — список не загрузился, показываем все
    const btns = COUNTRIES.flatMap((c, i) => (ok.length && !ok.includes(COUNTRY_IDS[c]) ? [] : [pick(w, 'c', { text: (hot.has(c) ? '🔥 ' : '') + c, v: String(i) })]));
    return { text: head + 'Выберите страну (🔥 — есть горящие туры):', kb: [[pick(w, 'c', { text: 'Любая страна', v: '*' })], ...rows(btns, 3)] };
  }
  if (!w.r) {
    const regs = w.c === '*' ? [] : REGIONS.get(countryId(w)) || [];
    if (!regs.length) return step({ ...w, r: '*' }, data, now); // курортов нет — шаг пропускаем
    return {
      text: head + 'Выберите курорт:',
      kb: [[pick(w, 'r', { text: 'Любой курорт', v: '*' })], ...rows(regs.map(([id, name]) => pick(w, 'r', { text: name, v: String(id) })), 3)],
    };
  }
  if (!w.n) return { text: head + 'Сколько ночей?', kb: rows(NIGHTS.map((n, i) => pick(w, 'n', { text: n[0], v: String(i) })), 2) };
  if (!w.p) return { text: head + 'Когда хотите лететь?', kb: rows(periods(now).map((p, i) => pick(w, 'p', { text: p[0], v: String(i) })), 2) };
  return null;
}

export function matches(w, data, now) {
  const country = w.c === '*' ? null : countriesOf(data)[+w.c];
  // курорт в горящих турах указан только в тексте: «Фуджейра» → ищем «фудже» (ловит и «в Фуджейру»)
  const resort = w.r && w.r !== '*' && regionName(w)?.toLowerCase().slice(0, 5);
  const [, nMin, nMax] = NIGHTS[+w.n];
  const [, from, to] = periods(now)[+w.p];
  return data.items.filter(t => {
    const { date, nights, meal } = tourInfo(t, now);
    return depOf(t) === DEPARTURES[+w.d][0] && (!country || t.country === country) && (!resort || (t.title + ' ' + t.descr).toLowerCase().includes(resort)) && (!nights || (nights >= nMin && nights <= nMax)) && (!date || (date >= from && date <= to))
      && (w.f === '*' || meal === undefined || meal >= +w.f);
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
  const s = step(decode('w'), data, now);
  const r = await tg(env, 'sendMessage', { chat_id, text: s.text, reply_markup: { inline_keyboard: s.kb } });
  if (r.ok) await remember(env, chat_id, [r.result.message_id]);
}

async function onTelegram(req, env, ctx) {
  if (req.headers.get('x-telegram-bot-api-secret-token') !== env.TG_SECRET) return new Response('forbidden', { status: 403 });
  const u = await req.json();
  const data = JSON.parse((await env.TOURS.get('tours')) || '{"items":[]}');
  const now = new Date();

  if (u.callback_query) {
    const q = u.callback_query, chat_id = q.message.chat.id, message_id = q.message.message_id;
    await tg(env, 'answerCallbackQuery', { callback_query_id: q.id });
    if (!q.data.startsWith('w')) return new Response('ok'); // кнопки из старой версии бота
    const w = decode(q.data);
    if (w.d) await loadCountries(env, depId(w));
    if (w.c && w.c !== '*') await loadRegions(env, countryId(w));
    const s = step(w, data, now);
    if (s) {
      await tg(env, 'editMessageText', { chat_id, message_id, text: s.text, reply_markup: { inline_keyboard: s.kb } });
      return new Response('ok');
    }
    // всё выбрано: Telegram отвечаем сразу, а поиск (5–20 секунд) идёт после ответа
    const sum = summary(w, data, now);
    await tg(env, 'editMessageText', { chat_id, message_id, text: '✅ Ваш запрос:\n' + sum });
    ctx.waitUntil(results(env, w, now, chat_id, data, sum));
    return new Response('ok');
  }

  const chat_id = u.message?.chat?.id;
  if (!chat_id) return new Response('ok');
  // владелец бота: «/admin <код>» — сюда будут приходить сообщения о сбоях поиска
  if (env.ADMIN_CODE && u.message.text === '/admin ' + env.ADMIN_CODE) {
    await env.TOURS.put('admin', String(chat_id));
    await tg(env, 'sendMessage', { chat_id, text: 'Готово: сообщения о сбоях поиска Tourvisor будут приходить сюда.' });
    return new Response('ok');
  }
  if (u.message.text === MENU_BUTTON) {
    // нажатие кнопки тоже убираем вместе со старой подборкой
    await remember(env, chat_id, [u.message.message_id]);
  } else {
    // кнопка «Подобрать тур» всегда внизу экрана, под полем ввода
    await tg(env, 'sendMessage', {
      chat_id,
      text: 'Здравствуйте! Здесь горящие туры и подбор туров из городов Казахстана. Кнопка «🔎 Подобрать тур за 1 минуту» всегда внизу экрана.',
      // подсказка в поле ввода видна, даже если клиент свернул кнопку значком ⌘
      reply_markup: { keyboard: [[{ text: MENU_BUTTON, style: 'primary' }]], resize_keyboard: true, is_persistent: true, input_field_placeholder: 'Подобрать тур за 1 минуту — значок справа ⌘' },
    });
  }
  await startWizard(env, chat_id, data, now);
  return new Response('ok');
}

// итог подбора: 3 подборки по рейтингу (поиск Tourvisor; при сбое — ссылки) + горящие туры + заявка менеджеру
async function results(env, w, now, chat_id, data, sum) {
  const ids = [];
  const send = async body => { const r = await tg(env, 'sendMessage', { chat_id, ...body }); if (r.ok) ids.push(r.result.message_id); return r; };
  if (w.c !== '*') {
    const wait = await send({ text: '🔎 Ищу туры у всех туроператоров, это займёт до 20 секунд…' });
    let groups = null;
    try {
      const hotels = await ratingSelections(env, w, now);
      groups = [...groupHotels(hotels), ...starGroups(hotels)].map(g => groupMessage(w, now, g)).concat(conceptMessages(w, now, hotels)); // рейтинг → звёздность → концепция, затем горящие
    } catch (e) {
      await alertAdmin(env, `Поиск Tourvisor не сработал (${String(e.message || e).slice(0, 150)}). Клиентам сейчас отправляются ссылки на Tourvisor.`);
    }
    if (wait.ok) { await tg(env, 'deleteMessage', { chat_id, message_id: wait.result.message_id }); ids.pop(); }
    if (groups) {
      for (const m of groups) {
        await send({ text: m.text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: m.kb } });
      }
    } else {
      // запасной вариант: ссылки на поиск Tourvisor с параметрами клиента
      await send({
        text: '⭐ Подборки по рейтингу отелей — туры всех туроператоров под ваш запрос, рейтинг указан у каждого отеля:',
        reply_markup: { inline_keyboard: RATINGS.map(([text, rating]) => [{ text, url: searchLink(w, now, rating) }]) },
      });
    }
  }
  const list = matches(w, data, now); // горящие туры из кабинета — только выбранного аэропорта
  for (const t of list) { const r = await sendTour(env, chat_id, t, data.updated); if (r.ok) ids.push(r.result.message_id); }
  const lead = `${env.CONTACT_URL}?text=${encodeURIComponent('Здравствуйте! Подберите, пожалуйста, тур.\n' + sum)}`;
  await send({
    text: (list.length
      ? '🔥 Выше — горящие туры по вашему запросу. Цены указаны за размещение из подборки туроператора (обычно 2 взрослых), точную цену на ваш состав посчитает менеджер.'
      : '🔥 Горящих туров по этим параметрам сейчас нет.')
      + (w.c === '*' ? '\n\nЧтобы получить подборки по рейтингу отелей, выберите конкретную страну.' : '')
      + '\n\n' + INCLUDED
      + '\n⏱ <b>Стоимость актуальна на момент поиска</b>, наличие уточняйте у менеджера',
    parse_mode: 'HTML',
    reply_markup: env.CONTACT_URL ? { inline_keyboard: [[{ text: '📩 Отправить запрос менеджеру', url: lead }]] } : undefined,
  });
  await remember(env, chat_id, ids);
}

// ---------- Канал: ежедневная подборка туров по всем направлениям ----------
// 2 взрослых, вылет в ближайшие 2 недели, 6–9 ночей; топ-3 самых дешёвых в каждой группе рейтинга и звёздности
const DIGEST_COUNTRIES = ['Турция', 'Египет', 'Таиланд', 'ОАЭ', 'Вьетнам', 'Китай'];
const STAR_GROUPS = [['ПЯТЬ ЗВЁЗД', 5], ['ЧЕТЫРЕ ЗВЕЗДЫ', 4], ['ТРИ ЗВЕЗДЫ', 3]];

export async function channelDigest(env, now, search = tvSearch) {
  const base = { d: '0', a: '2', k: '0', ages: [], f: '*', r: '', n: '1', p: '0' };
  const found = await Promise.allSettled(DIGEST_COUNTRIES.map(async name => {
    const w = { ...base, c: String(COUNTRIES.indexOf(name)) };
    return (await search(w, now)).map(h => ({ ...h, country: name, w }));
  }));
  const hotels = found.flatMap(x => (x.status === 'fulfilled' ? x.value : []));
  if (!hotels.length) throw new Error('ни одна страна не ответила: ' + found.map(x => x.reason?.message).filter(Boolean)[0]);
  const card = (h, i) => hotelCard(h, i, `${h.country}, ${h.region}`, searchLink(h.w, now, 0, h));
  const block = (title, list) => groupHeader(title) + '\n' + (list.length ? list.map(card).join('\n') : 'нет вариантов');
  const cheapest = list => [...list].sort((a, b) => a.price - b.price).slice(0, 3);
  const date = now.toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day: 'numeric', month: 'long' });
  const text = `🌍 <b>ПОДБОРКА ДНЯ · ${date}</b>\n<i>Самые выгодные туры из Астаны по всем направлениям</i>\n\n` +
    '👥 2 взрослых · 📅 вылет в ближайшие 2 недели · 🌙 6–9 ночей\n' + INCLUDED +
    '\n⏱ <b>Стоимость актуальна на момент публикации</b>, наличие уточняйте у менеджера\n\n' +
    groupHotels(hotels).map(g => block(ratingTitle(g), g.hotels)).join('\n\n') + '\n\n' +
    STAR_GROUPS.map(([title, s]) => block(`🌟 <b>${title}</b>`, cheapest(hotels.filter(h => h.stars === s && h.rating >= 3.7)))).join('\n\n') +
    (await hotBlock(env, now));
  return {
    text,
    kb: [[{ text: PICK_BUTTON, url: 'https://t.me/HotToursAstana_bot' }],
      ...(env.CONTACT_URL ? [[{ text: '📩 Написать менеджеру', url: `${env.CONTACT_URL}?text=${encodeURIComponent('Здравствуйте! Интересует тур из подборки дня в канале.')}` }]] : [])],
  };
}

// ---------- Горящие туры с открытой страницы Tourvisor (без входа в кабинет и без компьютера) ----------
// https://tourvisor.ru/goryashchie-tury?departure=<город> — страница отдаёт карточки прямо в HTML: отель, рейтинг, скидка, цена в тенге, дата, ночи, питание.
// Номера тура (tvofferid) там нет, поэтому ссылка ведёт на поиск Tourvisor по этому отелю и дате.
export function parseHot(html, dep) {
  const g = (c, re) => unxml(re.exec(c)?.[1] || '');
  const num = x => Number(x.replace(/\D/g, '')) || 0;
  const seen = new Set(), items = [];
  for (const c of html.match(/<a href="[^"]+" class="trv-hot-tours-2__item"[\s\S]*?<\/a>/g) || []) {
    const link = g(c, /href="([^"]+)"/);
    const q = new URL(link).searchParams;
    const [dd, mm] = (q.get('s_j_date_from') || '').split('.');
    const name = g(c, /item-name">\s*([^<]+?)\s*</), loc = g(c, /item-location">([^<]+)</), opt = g(c, /item-options">([^<]+)</).split(', ');
    const price = num(g(c, /item-price">\s*([\d\s]+)</));
    const sm = name.match(/^(\d)\*\s*(.+)$/), [country, ...region] = loc.split(', ');
    const id = `p${q.get('x_hotel_codes')}-${q.get('s_j_date_from')}-${q.get('s_nights_from')}-${q.get('s_meal')}`;
    if (!price || !mm || !name || !country || seen.has(id)) continue;
    seen.add(id);
    const rating = parseFloat(g(c, /item-score"[^>]*>([\d.]+)</)) || 0, meal = opt.slice(2, -1).join(', ');
    items.push({
      id, dep, country, link, rating, price, stars: sm ? +sm[1] : 0, title: sm ? sm[2] : name,
      oldPrice: num(g(c, /item-old-price">\s*([\d\s]+)</)), discount: g(c, /item-percent">([^<]+)</),
      img: g(c, /url\('([^']+)'\)/),
      // описание в том же виде, что у туров из кабинета: по нему бот находит дату, ночи и питание
      descr: `${sm ? sm[1] + '*, ' : ''}${[country, ...region].join(', ')}. Вылет: ${dep}, ${+dd} ${MONTHS[mm - 1]} на ${q.get('s_nights_from')} ночей, ${meal}. Рейтинг отеля ${rating.toFixed(1).replace('.', ',')}.`,
    });
  }
  return items;
}

// обходит все города вылета; город, который не ответил, сохраняет прежние туры
export async function scrapeHot(env) {
  const old = JSON.parse((await env.TOURS.get('tours')) || '{"items":[]}').items;
  const got = await Promise.allSettled(DEPARTURES.map(async ([name, id]) => {
    const html = await fetch(`https://tourvisor.ru/goryashchie-tury?departure=${id}`, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.text());
    if (!html.includes('trv-hot-tours-2')) throw new Error(name + ': страница без блока горящих туров');
    return parseHot(html, name);
  }));
  const items = got.flatMap((r, i) => (r.status === 'fulfilled' ? r.value : old.filter(t => depOf(t) === DEPARTURES[i][0])));
  if (!got.some(r => r.status === 'fulfilled' && r.value.length)) throw new Error(got.find(r => r.status === 'rejected')?.reason?.message || 'горящих туров нет ни в одном городе');
  await env.TOURS.put('tours', JSON.stringify({ updated: new Date().toISOString(), items }));
  return { saved: items.length, failed: got.filter(r => r.status === 'rejected').length };
}

// блок «Горящие» для канала: туры из кабинета всех городов, вылет не раньше чем через 2 дня, лучшие по скидке (не больше perCity с города)
export async function hotBlock(env, now, limit = 3, perCity = 99) {
  const data = JSON.parse((await env.TOURS.get('tours')) || '{"items":[]}');
  const soonest = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 2 * DAY;
  const off = t => (t.oldPrice > t.price ? (t.oldPrice - t.price) / t.oldPrice : 0);
  const list = data.items.filter(t => { const d = tourInfo(t, now).date; return d && d >= soonest; })
    .sort((a, b) => off(b) - off(a));
  const used = {};
  list.splice(0, list.length, ...list.filter(t => (used[depOf(t)] = (used[depOf(t)] || 0) + 1) <= perCity).slice(0, limit));
  if (!list.length) return '';
  const card = (t, i) => {
    const { date, nights, meal } = tourInfo(t, now);
    const hotel = (t.descr.match(/\.\s+([A-Z0-9][A-Z0-9 &'().,-]+?\s\d\*)/) || [])[1] || t.title;
    const old = t.oldPrice > t.price ? ` <s>${money(t.oldPrice)}</s> <b>${esc(t.discount)}</b>` : '';
    return `${NUM[i]} <b><a href="${t.link || env.TOUR_LINK.replace('{id}', t.id)}">${esc(hotel)}${t.stars ? ' ' + t.stars + '*' : ''}</a></b>\n` +
      `      ${esc(t.country)} · вылет ${esc(depOf(t))} · ${ddmmyyyy(date).slice(0, 5)} · ${nights} ноч.${meal !== undefined ? ' · ' + MEALS[meal] : ''}${t.rating ? ' · ' + badge(t.rating) + ' ' + String(t.rating).replace('.', ',') : ''}\n      💰 <b>${money(t.price)}</b>${old}`;
  };
  return '\n\n' + groupHeader('🔥 <b>ГОРЯЩИЕ</b>') + '\n' + list.map(card).join('\n');
}

// вечерний пост «Горящие туры» (19:00): топ-5 по скидке из кабинета; пусто — null
export async function channelHot(env, now) {
  const block = await hotBlock(env, now, 8, 2); // все города, до 2 туров с каждого
  if (!block) return null;
  const date = now.toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day: 'numeric', month: 'long' });
  return {
    text: `🔥 <b>ГОРЯЩИЕ ТУРЫ · ${date}</b>\n<i>Из городов Казахстана, самые большие скидки</i>\n\n` + INCLUDED +
      '\n⏱ <b>Стоимость актуальна на момент публикации</b>, наличие уточняйте у менеджера' + block,
    kb: [[{ text: PICK_BUTTON, url: 'https://t.me/HotToursAstana_bot' }],
      ...(env.CONTACT_URL ? [[{ text: '📩 Написать менеджеру', url: `${env.CONTACT_URL}?text=${encodeURIComponent('Здравствуйте! Интересуют горящие туры из вечерней подборки.')}` }]] : [])],
  };
}

// ---------- Канал: новости туризма (заголовок + ссылка на источник) ----------
const NEWS_FEEDS = [['Курсив', 'https://kz.kursiv.media/feed/'], ['Kazinform', 'https://www.inform.kz/rss/rus.xml'], ['TourDom', 'https://www.tourdom.ru/rss/']];
const NEWS_WORDS = /туризм|турист|туроператор|турагент|авиакомпани|авиабилет|рейс|перел[её]т|аэропорт|виз[аыу]|безвиз|отел[ьи]|курорт|отдых|путешеств|Air Astana|FlyArystan|SCAT|чартер/i;
const unxml = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&laquo;/g, '«').replace(/&raquo;/g, '»').replace(/&amp;/g, '&').trim();

export async function channelNews(env) {
  const posted = new Set(JSON.parse((await env.TOURS.get('news')) || '[]'));
  const fresh = [];
  for (const [source, url] of NEWS_FEEDS) { // сначала казахстанские источники
    try {
      const xml = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.text());
      for (const item of xml.match(/<item[\s\S]*?<\/item>/g) || []) {
        const title = unxml((item.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
        const link = unxml((item.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '');
        if (title && link && NEWS_WORDS.test(title) && !posted.has(link) && !posted.has(title) && !fresh.some(n => n.title === title)) fresh.push({ title, link, source });
      }
    } catch { /* источник не ответил — берём из остальных */ }
  }
  const pick = fresh.slice(0, 5);
  if (!pick.length) return null;
  // ponytail: храним последние 600 ссылок и заголовков (одна новость бывает в двух лентах), чтобы не повторяться
  await env.TOURS.put('news', JSON.stringify([...posted, ...pick.flatMap(n => [n.link, n.title])].slice(-600)));
  return '📰 <b>Новости туризма</b>\n\n' + pick.map(n => `• <a href="${esc(n.link)}">${esc(n.title)}</a> — ${n.source}`).join('\n\n');
}

// ---------- Канал: погода — Астана и курорт в разгаре сезона (Open-Meteo, бесплатно, без ключа) ----------
// [курорт, страна для кнопки, широта, долгота, точка в море для температуры воды, месяцы сезона]
const RESORTS = [
  ['Пхукет', 'Таиланд', 7.88, 98.39, [7.85, 98.25], [11, 12, 1, 2, 3, 4]],
  ['Шарм-эль-Шейх', 'Египет', 27.92, 34.33, [27.9, 34.4], [10, 11, 3, 4, 5]],
  ['Дубай', 'ОАЭ', 25.2, 55.27, [25.25, 55.2], [11, 12, 1, 2, 3, 4]],
  ['Фукуок', 'Вьетнам', 10.22, 103.96, [10.2, 103.9], [11, 12, 1, 2, 3, 4]],
  ['Санья (Хайнань)', 'Китай', 18.25, 109.51, [18.2, 109.5], [11, 12, 1, 2, 3]],
  ['Мальдивы', 'Мальдивы', 4.17, 73.51, [4.2, 73.45], [11, 12, 1, 2, 3, 4]],
  ['Гоа', 'Индия', 15.49, 73.83, [15.5, 73.75], [11, 12, 1, 2, 3]],
  ['Шри-Ланка', 'Шри-Ланка', 6.42, 80.0, [6.4, 79.95], [12, 1, 2, 3]],
  ['Хургада', 'Египет', 27.26, 33.81, [27.25, 33.9], [4, 5, 6, 9, 10, 11]],
  ['Анталья', 'Турция', 36.89, 30.71, [36.85, 30.7], [5, 6, 7, 8, 9, 10]],
];
const SKY = c => (c === 0 ? ['☀️', 'ясно'] : c <= 2 ? ['🌤', 'малооблачно'] : c === 3 ? ['☁️', 'облачно'] : c <= 48 ? ['🌫', 'туман']
  : c <= 57 ? ['🌦', 'морось'] : c <= 67 ? ['🌧', 'дождь'] : c <= 77 ? ['🌨', 'снег'] : c <= 82 ? ['🌧', 'ливень'] : c <= 86 ? ['🌨', 'снегопад'] : ['⛈', 'гроза']);
const deg = t => (t > 0 ? '+' : '') + Math.round(t) + '°';

// курорт дня: по очереди среди тех, где сейчас сезон
export function resortOfDay(now) {
  const season = RESORTS.filter(r => r[5].includes(now.getUTCMonth() + 1));
  return season[Math.floor(now.getTime() / DAY) % season.length];
}

export async function channelWeather(env, now) {
  const day = async (lat, lon) => (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=1`).then(r => r.json())).daily;
  const [name, country, lat, lon, [sLat, sLon]] = resortOfDay(now);
  const [ast, res, sea] = await Promise.all([day(51.17, 71.45), day(lat, lon),
    fetch(`https://marine-api.open-meteo.com/v1/marine?latitude=${sLat}&longitude=${sLon}&current=sea_surface_temperature`).then(r => r.json()).then(j => j.current?.sea_surface_temperature).catch(() => null)]);
  if (!ast?.temperature_2m_max || !res?.temperature_2m_max) throw new Error('нет данных о погоде');
  const [aSky, aTxt] = SKY(ast.weather_code[0]);
  const [rSky, rTxt] = SKY(res.weather_code[0]);
  const diff = Math.round(res.temperature_2m_max[0] - ast.temperature_2m_max[0]);
  const date = now.toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day: 'numeric', month: 'long' });
  const text = `🌡 <b>ПОГОДА · ${date}</b>\n\n` +
    `${groupHeader('🥶 <b>АСТАНА</b>')}\n      ${aSky} ${aTxt}\n      днём <b>${deg(ast.temperature_2m_max[0])}</b> · ночью ${deg(ast.temperature_2m_min[0])}\n\n` +
    `${groupHeader(`🏖 <b>${name.toUpperCase()}</b> · ${country}`)}\n      ${rSky} ${rTxt}\n      днём <b>${deg(res.temperature_2m_max[0])}</b> · ночью ${deg(res.temperature_2m_min[0])}` +
    (sea ? `\n      🌊 вода <b>${deg(sea)}</b>` : '') +
    `\n\n${diff > 0 ? `☀️ Там на <b>${diff}°</b> теплее, чем в Астане. ` : ''}Сейчас разгар сезона — самое время улететь к морю!`;
  return {
    text,
    kb: [[{ text: PICK_BUTTON, url: 'https://t.me/HotToursAstana_bot' }],
      ...(env.CONTACT_URL ? [[{ text: '📩 Написать менеджеру', url: `${env.CONTACT_URL}?text=${encodeURIComponent(`Здравствуйте! Хочу тур: ${name}, ${country}.`)}` }]] : [])],
  };
}

// ---------- Канал: вечерний пост в 19:00 — картинка с отдыха + призыв ехать (креативы меняются каждый день) ----------
// [что нарисовать (по-английски, нейросеть так понимает лучше), заголовок, текст, страна для WhatsApp]
const CREATIVES = [
  ['Phuket Thailand white sand beach, turquoise Andaman sea, limestone cliffs, longtail boats, golden hour', 'Ты это заслужил', 'Рабочий день позади. А где-то уже тёплое море и закат. Выбери тур сегодня — отпуск сам себя не купит.', 'Таиланд'],
  ['Dubai skyline at sunset from a luxury beach, calm sea, palm trees, warm golden light', 'Сегодня — самый подходящий день', 'Не откладывай на потом: цены на туры меняются каждый день, а лучшие места разбирают первыми.', 'ОАЭ'],
  ['Maldives overwater villas, crystal clear turquoise lagoon, white sand, sunset sky', 'Закрой ноутбук — открой море', 'Ты весь год работал. Пора отдохнуть так, чтобы было что вспомнить.', 'Мальдивы'],
  ['Phu Quoc Vietnam tropical beach, hammock between palm trees, calm sea at sunset', 'Тепло — это просто', 'Пока в Астане холодно, во Вьетнаме +30 и тёплое море. Билеты в рай ближе, чем кажется.', 'Вьетнам'],
  ['Sharm El Sheikh Egypt coral reef beach, clear blue Red Sea, sun umbrellas, evening light', 'Отпуск — не роскошь, а необходимость', 'Ты заслужил отдых. Напиши нам — подберём тур под твой бюджет за 5 минут.', 'Египет'],
  ['Sanya Hainan China tropical beach resort, palm trees, turquoise sea, golden sunset', 'Вечер. Диван. Или море?', 'Хватит откладывать отпуск. Горящие туры из Астаны — в нашем боте, пока они есть.', 'Китай'],
  ['Antalya Turkey Mediterranean coast, turquoise bay, pine trees, boats, golden hour', 'Мечтай сегодня — лети скоро', 'Самое лучшее время забронировать тур — сегодня. Завтра цена может быть другой.', 'Турция'],
  ['Goa India palm beach at sunset, golden sand, calm Arabian sea, silhouette of palm trees', 'Ты так долго ждал этот отпуск', 'Позволь себе отдых без вины. Подберём тур, где будет солнце, море и ничего лишнего.', 'Индия'],
  ['Bali Indonesia infinity pool overlooking rice terraces and ocean at sunset, tropical flowers', 'Тебе точно нужен отпуск', 'Усталость не лечится диваном. Лечится морем. Выбирай тур — мы всё организуем.', 'Индонезия'],
  ['Hurghada Egypt resort beach with palm trees and calm sea, soft evening sky', 'Сегодня можно всё изменить', 'Один вечер — и ты выбрал тур. Через пару недель — уже на пляже. Напиши нам.', 'Египет'],
];

export async function channelEvening(env, now) {
  const [scene, head, body, country] = CREATIVES[Math.floor(now.getTime() / DAY) % CREATIVES.length];
  const text = `🌅 <b>${head}</b>\n\n${body}\n\n🔥 Горящие туры из Астаны — в нашем боте. Цены меняются каждый день, наличие уточняйте у менеджера.\n\n<i>Иллюстрация создана нейросетью</i>`;
  const kb = [[{ text: PICK_BUTTON, url: 'https://t.me/HotToursAstana_bot' }],
    ...(env.CONTACT_URL ? [[{ text: '📩 Хочу в отпуск — написать менеджеру', url: `${env.CONTACT_URL}?text=${encodeURIComponent(`Здравствуйте! Хочу в отпуск: ${country}.`)}` }]] : [])];
  let image = null;
  try {
    const r = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', { prompt: `${scene}, photorealistic travel advertisement photo, vibrant colors, no text, no people faces`, steps: 4 });
    if (r?.image) image = Uint8Array.from(atob(r.image), c => c.charCodeAt(0));
  } catch (e) { await alertAdmin(env, `Вечерняя картинка не нарисовалась (${String(e.message || e).slice(0, 120)}), пост вышел без неё.`); }
  return { text, kb, image };
}

async function postEvening(env, now) {
  const { text, kb, image } = await channelEvening(env, now);
  if (!image) return tg(env, 'sendMessage', { chat_id: env.CHANNEL_ID, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
  const f = new FormData(); // фото отправляется файлом
  f.set('chat_id', env.CHANNEL_ID); f.set('caption', text); f.set('parse_mode', 'HTML');
  f.set('reply_markup', JSON.stringify({ inline_keyboard: kb }));
  f.set('photo', new Blob([image], { type: 'image/jpeg' }), 'rest.jpg');
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, { method: 'POST', body: f }).then(r => r.json());
}

async function runChannel(env, job, now = new Date()) {
  if (!env.CHANNEL_ID) return { ok: false, error: 'канал не задан' };
  try {
    if (job === 'news') {
      const text = await channelNews(env);
      if (!text) return { ok: true, posted: 0 };
      const r = await tg(env, 'sendMessage', { chat_id: env.CHANNEL_ID, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [[{ text: PICK_BUTTON, url: 'https://t.me/HotToursAstana_bot' }]] } });
      return { ok: r.ok, error: r.description };
    }
    if (job === 'scrape') return { ok: true, ...(await scrapeHot(env)) };
    if (job === 'evening') {
      const r = await postEvening(env, now);
      if (!r.ok) throw new Error(r.description);
      return { ok: true, withPicture: Array.isArray(r.result?.photo) };
    }
    const d = job === 'weather' ? await channelWeather(env, now) : job === 'hot' ? await channelHot(env, now) : await channelDigest(env, now);
    if (!d) { // в базе нет туров с вылетом через 2+ дня: пустое не публикуем, владельцу сообщаем
      await alertAdmin(env, 'Горящие туры 19:00 не вышли: в базе нет актуальных. Войдите в https://pro.tourvisor.ru в Chrome, чтобы они обновились.');
      return { ok: true, posted: 0 };
    }
    const r = await tg(env, 'sendMessage', { chat_id: env.CHANNEL_ID, text: d.text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: d.kb } });
    if (!r.ok) throw new Error(r.description);
    return { ok: true };
  } catch (e) {
    await alertAdmin(env, `Канал: не получилось опубликовать ${{ news: 'новости', weather: 'погоду', evening: 'вечерний пост', hot: 'горящие туры', scrape: 'обновить горящие туры' }[job] || 'подборку дня'} (${String(e.message || e).slice(0, 150)}).`);
    return { ok: false, error: String(e.message || e) };
  }
}

// /update вызывается прямо со страницы кабинета Tourvisor, поэтому разрешаем запросы оттуда
const CORS = { 'access-control-allow-origin': 'https://pro.tourvisor.ru', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type, x-secret' };

export default {
  async fetch(req, env, ctx) {
    const { pathname } = new URL(req.url);
    if (req.method === 'OPTIONS' && pathname === '/update') return new Response(null, { headers: CORS });
    if (req.method === 'POST' && pathname === '/update') {
      const r = await onUpdate(req, env);
      return new Response(r.body, { status: r.status, headers: { ...Object.fromEntries(r.headers), ...CORS } });
    }
    if (req.method === 'POST' && pathname === '/tg') return onTelegram(req, env, ctx);
    // проверка поиска Tourvisor с сервера бота (Турция, 2 взрослых, ближайшие 2 недели, 6–9 ночей)
    if (req.method === 'POST' && pathname === '/check-search') {
      if (req.headers.get('x-secret') !== env.UPDATE_SECRET) return new Response('forbidden', { status: 403 });
      try {
        const hotels = await tvSearch({ a: '2', k: '0', ages: [], f: '*', c: '0', n: '1', p: '0' }, new Date());
        return Response.json({ ok: true, hotels: hotels.length, groups: groupHotels(hotels).map(g => [g.title, g.hotels.length, g.hotels[0]?.name, g.hotels[0]?.rating]) });
      } catch (e) {
        return Response.json({ ok: false, error: String(e.message || e) });
      }
    }
    // ручной запуск публикации в канал: /run?job=tours или /run?job=news (заголовок X-Secret)
    if (req.method === 'POST' && pathname === '/run') {
      if (req.headers.get('x-secret') !== env.UPDATE_SECRET) return new Response('forbidden', { status: 403 });
      const q = new URL(req.url).searchParams;
      // to=admin — прислать пост только владельцу (предпросмотр), а не в канал
      const target = q.get('to') === 'admin' ? { ...env, CHANNEL_ID: await env.TOURS.get('admin') } : env;
      // /run?job=delete&id=<номер поста> — убрать ошибочно опубликованный пост бота в канале
      if (q.get('job') === 'delete') return Response.json(await tg(env, 'deleteMessage', { chat_id: env.CHANNEL_ID, message_id: Number(q.get('id')) }));
      return Response.json(await runChannel(target, q.get('job')));
    }
    return new Response('Not found', { status: 404 });
  },
  // расписание (wrangler.jsonc), время Астаны = UTC+5: 10:00 — подборка дня, 14:00 — новости, 15:00 — погода, 19:00 — вечерний пост-призыв и сразу за ним горящие туры
  async scheduled(event, env, ctx) {
    // горящие туры обновляются с открытой страницы Tourvisor перед постами и днём
    const jobs = { '0 9 * * *': ['news'], '0 10 * * *': ['scrape', 'weather'], '0 14 * * *': ['scrape', 'evening', 'hot'] }[event.cron] || ['scrape', 'tours'];
    ctx.waitUntil((async () => { for (const j of jobs) await runChannel(env, j); })());
  },
};
