// Ссылки на отели на сайте туроператора KOMPAS (kompastour.com): по названию отеля из Tourvisor ищем страницу отеля в индексе kompas-index.js.
// Не нашли — вызывающий код оставляет прежнюю ссылку на поиск Tourvisor.
import INDEX from './kompas-index.js';

// страна бота → адрес страны на kompastour.com
const SLUGS = { 'Турция': 'turkey', 'Египет': 'egypt', 'Таиланд': 'thailand', 'ОАЭ': 'uae', 'Китай': 'china', 'Вьетнам': 'vietnam', 'Азербайджан': 'azerbaijan',
  'Армения': 'armenia', 'Бахрейн': 'bahrain', 'Венгрия': 'hungary', 'Греция': 'greece', 'Грузия': 'georgia', 'Доминикана': 'dominicana', 'Индия': 'india',
  'Индонезия': 'indonesia', 'Испания': 'spain', 'Италия': 'italy', 'Казахстан': 'kazakhstan', 'Катар': 'qatar', 'Кипр': 'cyprus', 'Кыргызстан': 'kyrgyzstan',
  'Маврикий': 'mauritius', 'Малайзия': 'malaysia', 'Мальдивы': 'maldives', 'Оман': 'oman', 'Сейшелы': 'seychelles', 'Сингапур': 'singapore', 'Словения': 'slovenia',
  'Танзания': 'tanzania', 'Узбекистан': 'uzbekistan', 'Франция': 'france', 'Черногория': 'montenegro', 'Чехия': 'czech', 'Шри-Ланка': 'srilanka', 'Австрия': 'austria' };
const STOP = new Set(['hotel', 'resort', 'spa', 'the', 'and', 'by', 'club', 'beach', 'hotels', 'resorts', 'apart', 'aparthotel', 'residence', 'suites', 'suite', 'inn', 'ex', 'all', 'inclusive']);

// «ALBA QUEEN HOTEL» и «alba_queen_hotel» дают один ключ «alba queen»; цифры и другие слова сохраняются
export function hotelKey(name) {
  return String(name).toLowerCase().replace(/&amp;/g, ' ').replace(/[^a-z0-9а-яё]+/g, ' ').split(' ').filter(x => x && !STOP.has(x)).join(' ');
}

// названия вида «SAYGILI BEACH (EX. SEDEF HOTEL)» или «SELINA HOTEL (THUY NGA HOTEL)» — пробуем и основное название, и то, что в скобках
function candidates(name) {
  const text = String(name);
  const inner = [...text.matchAll(/\(([^)]*)\)?/g)].map(m => m[1].replace(/^\s*ex\.?\s*/i, ''));
  return [text.replace(/\([^)]*\)?/g, ' '), ...inner].map(hotelKey).filter(Boolean);
}

// число правок (вставка, удаление, замена буквы) между двумя строками; лишнее прекращаем считать, когда больше лимита
function distance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (Math.min(...cur) > limit) return limit + 1;
    prev = cur;
  }
  return prev[b.length];
}

// индекс страны без пробелов в названиях («phu quoc» = «phuquoc»); строится один раз
const COMPACT = new Map();
function compactOf(slug) {
  if (!COMPACT.has(slug)) COMPACT.set(slug, Object.entries(INDEX[slug]).map(([k, path]) => [k.replace(/ /g, ''), path, k]));
  return COMPACT.get(slug);
}

// Ищем от точного совпадения к приблизительному; приблизительные варианты принимаем только если подходит ровно один отель
export function kompasUrl(country, name) {
  const slug = SLUGS[country];
  const idx = slug && INDEX[slug];
  if (!idx) return null;
  const url = p => `https://kompastour.com/kz/rus/country/${slug}/${p}/`;
  const cands = candidates(name);
  const list = compactOf(slug);
  const unique = hits => (new Set(hits.map(h => h[1])).size === 1 ? url(hits[0][1]) : null);
  // 1. то же название; 2. то же без пробелов («Phu Quoc» и «Phuquoc»)
  for (const k of cands) if (idx[k]) return url(idx[k]);
  for (const k of cands) { const c = k.replace(/ /g, ''); const hit = list.find(x => x[0] === c); if (hit) return url(hit[1]); }
  // 3. слова одного названия целиком входят в другое (не меньше двух слов)
  for (const k of cands) {
    const a = k.split(' ');
    if (a.length < 2 && a[0].length < 6) continue; // одно слово — только длинное (не меньше шести букв), чтобы не путать разные отели
    const hits = list.filter(x => { const b = x[2].split(' '); const [s, l] = a.length <= b.length ? [a, b] : [b, a]; return (s.length >= 2 || (s.length === 1 && s[0].length >= 6)) && s.every(t => l.includes(t)); });
    const u = unique(hits); if (u) return u;
  }
  // 4. одно название содержится в другом без пробелов (от 9 букв), 5. отличается на 1–2 буквы (опечатка, «ph» и «f», «y» и «i»)
  for (const k of cands) {
    const c = k.replace(/ /g, '');
    if (c.length < 9) continue;
    const u = unique(list.filter(x => x[0].length >= 9 && (x[0].includes(c) || c.includes(x[0]))));
    if (u) return u;
  }
  for (const k of cands) {
    const c = k.replace(/ /g, ''), limit = c.length >= 14 ? 2 : 1;
    if (c.length < 8) continue;
    let best = limit + 1, hits = [];
    for (const x of list) { const d = distance(c, x[0], limit); if (d < best) { best = d; hits = [x]; } else if (d === best && d <= limit) hits.push(x); }
    if (best <= limit) { const u = unique(hits); if (u) return u; }
  }
  return null;
}
