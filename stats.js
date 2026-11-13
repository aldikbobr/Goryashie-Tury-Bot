// Статистика бота (база Cloudflare D1, бесплатно) и настройки пульта (KV). Сбой статистики никогда не ломает бота.
import { PANEL_HTML } from './panel.js';

export const DEFAULT_CFG = { access: 'auto', openUntil: '2026-11-30', concept: true, posts: {} };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const astanaDay = d => new Date(d.getTime() + 5 * 3600e3).toISOString().slice(0, 10);

// настройки: access = auto (всем до даты, потом подписчикам) | open | subs; concept — разделы концепции; posts.<задача> = false — пост выключен
export async function getCfg(env) {
  try {
    const c = JSON.parse((await env.TOURS.get('cfg')) || '{}');
    return { ...DEFAULT_CFG, ...c, posts: { ...DEFAULT_CFG.posts, ...(c.posts || {}) } };
  } catch { return { ...DEFAULT_CFG }; }
}

// событие: start | press | search | locked | link; uid 0 — переход по ссылке (не человек)
export async function track(env, type, uid, val = '') {
  try {
    if (!env.DB) return;
    const now = new Date();
    await env.DB.prepare('INSERT INTO events (ts, day, uid, type, val) VALUES (?, ?, ?, ?, ?)').bind(now.getTime(), astanaDay(now), Number(uid) || 0, type, String(val)).run();
  } catch { /* статистика не важнее бота */ }
}

// число подписчиков канала раз в день (и при каждом открытии пульта)
export async function snapshotSubs(env, tg) {
  try {
    const r = await tg(env, 'getChatMemberCount', { chat_id: env.CHANNEL_ID });
    if (!r.ok) return null;
    await env.DB.prepare('INSERT OR REPLACE INTO subs (day, n) VALUES (?, ?)').bind(astanaDay(new Date()), r.result).run();
    return r.result;
  } catch { return null; }
}

// Журнал изменений: правки кода берём из истории публичной копии репозитория (каждая публикация бота = запись с описанием), настройки — из событий пульта.
// Ответ GitHub кэшируется на 10 минут средствами Cloudflare (в базу и KV ничего не пишем).
async function commits() {
  try {
    const url = 'https://api.github.com/repos/aldikbobr/Goryashie-Tury-Bot/commits?per_page=40';
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    let r = cache ? await cache.match(url) : null;
    if (!r) {
      r = await fetch(url, { headers: { 'user-agent': 'goryashie-panel', accept: 'application/vnd.github+json' } });
      if (!r.ok) return [];
      if (cache) { const c = new Response(r.clone().body, r); c.headers.set('cache-control', 'max-age=600'); await cache.put(url, c); }
    }
    return (await r.json()).map(c => ({ ts: Date.parse(c.commit.author.date), text: c.commit.message.split('\n')[0], src: 'код' }));
  } catch { return []; }
}
async function changes(env) {
  const cfg = (await all(env, "SELECT ts, val FROM events WHERE type = 'cfg' ORDER BY ts DESC LIMIT 20")).map(r => ({ ts: r.ts, text: 'Настройка в пульте: ' + r.val, src: 'пульт' }));
  return [...(await commits()), ...cfg].sort((a, b) => b.ts - a.ts).slice(0, 30);
}

const all = async (env, sql, ...b) => (await env.DB.prepare(sql).bind(...b).all()).results || [];

export async function report(env, from, to, tg) {
  const w = 'day BETWEEN ? AND ? AND uid > 0';
  const one = async (sql, ...b) => (await all(env, sql, ...b))[0]?.n ?? 0;
  const counts = Object.fromEntries((await all(env, `SELECT type, COUNT(*) n FROM events WHERE ${w} GROUP BY type`, from, to)).map(r => [r.type, r.n]));
  const searches = await all(env, `SELECT val, COUNT(*) n FROM events WHERE type = 'search' AND ${w} GROUP BY val`, from, to);
  const tally = i => Object.entries(searches.reduce((m, r) => { const k = r.val.split('|')[i] || '—'; m[k] = (m[k] || 0) + r.n; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const subsNow = (await snapshotSubs(env, tg)) ?? (await all(env, 'SELECT n FROM subs ORDER BY day DESC LIMIT 1'))[0]?.n ?? null;
  const before = (await all(env, 'SELECT n FROM subs WHERE day < ? ORDER BY day DESC LIMIT 1', from))[0]?.n;
  return {
    users: await one(`SELECT COUNT(DISTINCT uid) n FROM events WHERE ${w}`, from, to),
    newUsers: await one('SELECT COUNT(*) n FROM (SELECT uid, MIN(day) d FROM events WHERE uid > 0 GROUP BY uid) WHERE d BETWEEN ? AND ?', from, to),
    searches: counts.search || 0, starts: counts.start || 0, presses: counts.press || 0, locked: counts.locked || 0,
    byDay: await all(env, `SELECT day, COUNT(DISTINCT uid) users, SUM(type = 'search') searches FROM events WHERE ${w} GROUP BY day ORDER BY day DESC`, from, to),
    topCountries: tally(0), topAirports: tally(1),
    links: (await all(env, "SELECT val, COUNT(*) n FROM events WHERE type = 'link' AND day BETWEEN ? AND ? GROUP BY val ORDER BY n DESC LIMIT 20", from, to)).map(r => [r.val, r.n]),
    changes: await changes(env),
    subsNow, subsDelta: subsNow !== null && before !== undefined ? subsNow - before : null,
  };
}

// запись настройки из пульта: только известные поля и значения
export async function setCfg(env, path, value) {
  const c = await getCfg(env);
  if (path === 'access' && ['auto', 'open', 'subs'].includes(value)) c.access = value;
  else if (path === 'openUntil' && DATE_RE.test(value)) c.openUntil = value;
  else if (path === 'concept' && typeof value === 'boolean') c.concept = value;
  else if (/^posts\.(news|weather|tours|evening|hot)$/.test(path) && typeof value === 'boolean') c.posts[path.slice(6)] = value;
  else return { ok: false, error: 'неизвестная настройка' };
  await env.TOURS.put('cfg', JSON.stringify(c));
  await track(env, 'cfg', 0, path + ' = ' + value);
  return { ok: true };
}

// маршруты пульта и отслеживаемых ссылок; null — не наш адрес
export async function route(req, env, tg) {
  const url = new URL(req.url), p = url.pathname;
  const go = p.match(/^\/go\/(bot|channel)(?:\/([\w-]{1,30}))?$/);
  if (go) { // отслеживаемая ссылка: считаем переход и отправляем в Telegram
    const target = go[1] === 'bot' ? (env.BOT_USERNAME || 'HotToursAstana_bot') : String(env.CHANNEL_ID || '@goryashie_tury_astana').replace('@', '');
    await track(env, 'link', 0, go[1] + ':' + (go[2] || 'без метки'));
    return Response.redirect('https://t.me/' + target, 302);
  }
  if (p === '/panel') return new Response(PANEL_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
  if (p === '/panel/api' || p === '/panel/api/set') {
    if (!env.PANEL_KEY || req.headers.get('x-key') !== env.PANEL_KEY) return new Response('forbidden', { status: 401 });
    if (p === '/panel/api/set') { const b = await req.json().catch(() => ({})); return Response.json(await setCfg(env, b.path, b.value)); }
    const from = url.searchParams.get('from') || '', to = url.searchParams.get('to') || '';
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) return Response.json({ error: 'даты' }, { status: 400 });
    try { return Response.json({ ...(await report(env, from, to, tg)), cfg: await getCfg(env) }); }
    catch (e) { return Response.json({ error: String(e.message || e) }, { status: 500 }); }
  }
  return null;
}
