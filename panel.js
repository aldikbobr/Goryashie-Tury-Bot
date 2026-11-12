// Пульт владельца: страница /panel. Ключ берётся из адреса после # (на сервер в адресе не уходит), данные тянутся из /panel/api.
// В тексте нет обратных кавычек и ${} — страница лежит в String.raw.
export const PANEL_HTML = String.raw`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Пульт — Горящие от ТурБота</title>
<style>
:root{--bg:#f4f7fb;--card:#fff;--tx:#10243a;--mut:#64748b;--bl:#1e6feb;--bd:#dbe4ef;--ok:#16a34a;--bad:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#0e1621;--card:#17212b;--tx:#e8eef5;--mut:#8ba0b5;--bd:#26364a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:16px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.w{max-width:880px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:4px 0 14px}h2{font-size:16px;margin:22px 0 8px}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{border:1px solid var(--bd);background:var(--card);color:var(--tx);padding:9px 14px;border-radius:999px;font:inherit;cursor:pointer}
.chip.on{background:var(--bl);border-color:var(--bl);color:#fff}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:12px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:14px}
.card b{display:block;font-size:28px}.card span{color:var(--mut);font-size:13px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--bd);border-radius:14px;overflow:hidden}
td,th{padding:9px 12px;text-align:left;border-bottom:1px solid var(--bd);font-size:14px}th{color:var(--mut);font-weight:600}
.bar{height:8px;background:var(--bl);border-radius:4px;margin-top:4px}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid var(--bd)}
.box{background:var(--card);border:1px solid var(--bd);border-radius:14px;overflow:hidden}.box .row:last-child{border:0}
select,input[type=date]{font:inherit;padding:8px;border-radius:8px;border:1px solid var(--bd);background:var(--card);color:var(--tx)}
.sw{position:relative;width:48px;height:28px;flex:none}.sw input{opacity:0;width:0;height:0}
.sw i{position:absolute;inset:0;background:#94a3b8;border-radius:28px;transition:.2s}.sw i:before{content:"";position:absolute;left:3px;top:3px;width:22px;height:22px;background:#fff;border-radius:50%;transition:.2s}
.sw input:checked+i{background:var(--ok)}.sw input:checked+i:before{transform:translateX(20px)}
.mut{color:var(--mut);font-size:13px}.err{color:var(--bad)}
#toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:#10243a;color:#fff;padding:10px 16px;border-radius:10px;opacity:0;transition:.3s;pointer-events:none}
#toast.on{opacity:1}
</style></head><body><div class="w">
<h1>Пульт · Горящие от ТурБота</h1>
<div id="msg" class="mut"></div>
<div class="chips" id="chips"></div>
<div class="chips" style="margin-top:10px"><input type="date" id="d1"><input type="date" id="d2"><button class="chip" id="apply">Показать</button></div>
<div class="grid" id="cards"></div>
<h2>По дням</h2><div id="days"></div>
<h2>Что выбирают в подборе</h2><div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr))"><div id="top1"></div><div id="top2"></div></div>
<h2>Переходы по отслеживаемым ссылкам</h2><div id="links"></div>
<h2>Управление</h2><div class="box" id="ctl"></div>
<p class="mut">Изменения применяются сразу. Статистика считается с 12 ноября 2026, время по Астане.</p>
</div><div id="toast"></div>
<script>
var KEY = location.hash.slice(1), FIRST = '2026-11-12';
var $ = function (id) { return document.getElementById(id); };
function dstr(d) { return new Date(d.getTime() + 5 * 3600000).toISOString().slice(0, 10); }
function shift(n) { return dstr(new Date(Date.now() - n * 86400000)); }
var PER = [['Сегодня', 0, 0], ['Вчера', 1, 1], ['2 дня', 1, 0], ['7 дней', 6, 0], ['30 дней', 29, 0], ['С 12 ноября', null, 0]];
var cur = 0, range = [shift(0), shift(0)];
function toast(t) { $('toast').textContent = t; $('toast').className = 'on'; setTimeout(function () { $('toast').className = ''; }, 1800); }
function api(path, body) {
  return fetch(path, { method: body ? 'POST' : 'GET', headers: { 'x-key': KEY, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    .then(function (r) { if (r.status === 401) throw new Error('Неверная ссылка пульта (ключ)'); return r.json(); });
}
function chips() {
  $('chips').innerHTML = '';
  PER.forEach(function (p, i) {
    var b = document.createElement('button'); b.className = 'chip' + (i === cur ? ' on' : ''); b.textContent = p[0];
    b.onclick = function () { cur = i; range = [p[1] === null ? FIRST : shift(p[1]), shift(p[2])]; $('d1').value = range[0]; $('d2').value = range[1]; load(); };
    $('chips').appendChild(b);
  });
}
$('apply').onclick = function () { cur = -1; range = [$('d1').value, $('d2').value]; load(); };
function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
function card(n, t) { return '<div class="card"><b>' + n + '</b><span>' + t + '</span></div>'; }
function bars(list, empty) {
  if (!list.length) return '<div class="mut">' + empty + '</div>';
  var m = list[0][1];
  return '<div class="card">' + list.map(function (x) { return '<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between"><span>' + esc(x[0]) + '</span><b style="font-size:15px">' + x[1] + '</b></div><div class="bar" style="width:' + Math.max(4, Math.round(100 * x[1] / m)) + '%"></div></div>'; }).join('') + '</div>';
}
function load() {
  chips();
  api('/panel/api?from=' + range[0] + '&to=' + range[1]).then(function (d) {
    $('msg').textContent = 'Период: ' + range[0] + (range[0] === range[1] ? '' : ' — ' + range[1]);
    var subs = d.subsNow === null ? '—' : d.subsNow, delta = d.subsDelta === null ? '' : ' (' + (d.subsDelta >= 0 ? '+' : '') + d.subsDelta + ' за период)';
    $('cards').innerHTML = card(d.users, 'человек зашло в бота') + card(d.newUsers, 'из них новых') + card(d.searches, 'подборок сделано') + card(d.starts, 'нажатий «Старт»') + card(d.presses, 'нажатий «Подобрать тур»') + card(d.locked, 'не пустили (не подписаны)') + card(subs, 'подписчиков в канале' + delta);
    $('days').innerHTML = '<table><tr><th>День</th><th>Людей</th><th>Подборок</th></tr>' + d.byDay.map(function (r) { return '<tr><td>' + r.day + '</td><td>' + r.users + '</td><td>' + r.searches + '</td></tr>'; }).join('') + '</table>';
    $('top1').innerHTML = '<div class="mut" style="margin-bottom:4px">Страны</div>' + bars(d.topCountries, 'пока нет подборок');
    $('top2').innerHTML = '<div class="mut" style="margin-bottom:4px">Города вылета</div>' + bars(d.topAirports, 'пока нет подборок');
    $('links').innerHTML = d.links.length ? bars(d.links, '') : '<div class="mut">Пока нет. Отслеживаемые ссылки: ' + location.origin + '/go/bot/instagram, /go/bot/whatsapp, /go/channel/instagram, /go/channel/whatsapp (вместо instagram и whatsapp можно писать любое слово — оно появится здесь).</div>';
    ctl(d.cfg);
  }).catch(function (e) { $('msg').innerHTML = '<span class="err">' + esc(e.message) + '</span>'; });
}
var POSTS = [['news', 'Новости в канале (14:00)'], ['weather', 'Погода в канале (15:00)'], ['tours', 'Подборка дня в канале (10:00)'], ['evening', 'Вечерний пост (19:00)'], ['hot', 'Горящие туры в канале (19:00)']];
function sw(id, on) { return '<label class="sw"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '><i></i></label>'; }
function ctl(c) {
  var h = '<div class="row"><div>Доступ к боту<div class="mut">Кого пускает бот</div></div><select id="access">' +
    [['auto', 'Всем до даты, потом только подписчикам'], ['open', 'Открыт всем'], ['subs', 'Только подписчикам канала']].map(function (o) { return '<option value="' + o[0] + '"' + (c.access === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>';
  h += '<div class="row"><div>Дата перехода на подписчиков<div class="mut">С этого дня 00:00 (Астана), если выбран первый режим</div></div><input type="date" id="until" value="' + c.openUntil + '"></div>';
  h += '<div class="row"><div>Разделы «Взрослая / Детская концепция»<div class="mut">В подборке бота</div></div>' + sw('concept', c.concept) + '</div>';
  POSTS.forEach(function (p) { h += '<div class="row"><div>' + p[1] + '</div>' + sw('p_' + p[0], c.posts[p[0]] !== false) + '</div>'; });
  $('ctl').innerHTML = h;
  function save(path, value) { api('/panel/api/set', { path: path, value: value }).then(function (r) { toast(r.ok ? 'Сохранено' : 'Ошибка: ' + (r.error || '')); }); }
  $('access').onchange = function () { save('access', this.value); };
  $('until').onchange = function () { save('openUntil', this.value); };
  $('concept').onchange = function () { save('concept', this.checked); };
  POSTS.forEach(function (p) { $('p_' + p[0]).onchange = function () { save('posts.' + p[0], this.checked); }; });
}
window.onhashchange = function () { location.reload(); }; // ключ в адресе поменяли — перечитываем
$('d1').value = range[0]; $('d2').value = range[1];
if (!KEY) $('msg').innerHTML = '<span class="err">Откройте пульт по полной ссылке с ключом после знака #</span>'; else load();
</script></body></html>`;
