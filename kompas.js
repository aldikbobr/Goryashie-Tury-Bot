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

// названия вида «SAYGILI BEACH (EX. SEDEF HOTEL)» — пробуем и основное, и прежнее название
function candidates(name) {
  const m = String(name).match(/^(.*?)\s*\(\s*ex\.?\s*(.*?)\)?\s*$/i);
  return (m ? [m[1], m[2]] : [name]).map(hotelKey).filter(Boolean);
}

// адрес страницы отеля на kompastour.com или null
export function kompasUrl(country, name) {
  const slug = SLUGS[country];
  const idx = slug && INDEX[slug];
  if (!idx) return null;
  const url = p => `https://kompastour.com/kz/rus/country/${slug}/${p}/`;
  const cands = candidates(name);
  for (const k of cands) if (idx[k]) return url(idx[k]);
  // не нашли точно — берём единственный отель, у которого слова названия целиком входят в другое (не меньше двух слов, чтобы не путать разные отели)
  for (const k of cands) {
    const a = k.split(' ');
    if (a.length < 2) continue;
    const hits = Object.keys(idx).filter(x => { const b = x.split(' '); const [s, l] = a.length <= b.length ? [a, b] : [b, a]; return s.length >= 2 && s.every(t => l.includes(t)); });
    if (hits.length === 1) return url(idx[hits[0]]);
  }
  return null;
}
