// Собирает kompas-index.js — список отелей с сайта туроператора KOMPAS (из его публичной карты сайта).
// Запуск: node tools/build-kompas.mjs  (нужен интернет). Индекс: страна → ключ названия отеля → «регион/отель».
import fs from 'node:fs';
import { hotelKey } from '../kompas.js';

const xml = await fetch('https://kompastour.com/kz/rus/sitemap/', { headers: { 'user-agent': 'Mozilla/5.0' } }).then(r => r.text());
const index = {};
let n = 0;
for (const m of xml.matchAll(/<loc>https:\/\/kompastour\.com\/kz\/rus\/country\/([a-z_]+)\/([A-Za-z0-9_]+)\/([A-Za-z0-9_]+)\/<\/loc>/g)) {
  const [, country, region, hotel] = m;
  const key = hotelKey(hotel.replace(/_/g, ' '));
  if (!key) continue;
  (index[country] ||= {})[key] ||= region + '/' + hotel;
  n++;
}
const body = '// Создано tools/build-kompas.mjs из карты сайта kompastour.com. Не править вручную.\nexport default ' + JSON.stringify(index) + ';\n';
fs.writeFileSync(new URL('../kompas-index.js', import.meta.url), body);
console.log('отелей', n, 'стран', Object.keys(index).length, 'байт', body.length);
