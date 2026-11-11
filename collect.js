// Запускается в Chrome на странице https://pro.tourvisor.ru/search?tab=hotOffers (кабинет агентства).
// Перед кодом нужно подставить строку: const SECRET = '<содержимое файла .update-secret>';
// Проходит по всем городам вылета РК, где в ленте есть горящие туры (в списке они жирным), собирает туры и
// отправляет их боту одним запросом. Возвращает ответ бота: {"saved":N,"posted":M,"cities":{...}}.
await (async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const txt = (el, sel) => (el.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
  const num = s => Number(s.replace(/\D/g, '')) || 0;
  const NAME = { Караганды: 'Караганда' }; // как город называется у бота
  for (let t = 0; t < 40 && !document.querySelector('.TVHotOfferControl'); t++) await wait(300);

  const openList = async () => {
    if (!document.querySelector('.TVDepartureTableItemControl')) { document.querySelector('.TVDepartureSelect .TVAddSelectPlaceholder').click(); await wait(600); }
  };
  await openList();
  const cities = [...document.querySelectorAll('.TVDepartureTableItemControl.TVItemBold')].map(e => e.textContent.trim());
  if (!cities.length) return 'ОШИБКА: не найден список городов вылета';

  const items = [], count = {};
  for (const city of cities) {
    await openList();
    [...document.querySelectorAll('.TVDepartureTableItemControl')].find(e => e.textContent.trim() === city).click();
    // ждём, пока лента перерисуется под выбранный город: в описании «… из Алматы 13 ноября …»
    const stem = 'из ' + city.slice(0, 4);
    for (let t = 0; t < 40; t++) {
      await wait(250);
      const first = document.querySelector('.TVHotOfferDescr');
      if (first && first.textContent.replace(/\s+/g, ' ').includes(stem)) break;
    }
    for (const c of document.querySelectorAll('.TVHotOfferControl')) {
      const descr = txt(c, '.TVHotOfferDescr');
      if (!descr.includes(stem)) continue; // страховка: тур другого города не берём
      // "5*, Таиланд, Пхукет из Астаны 18 ноября ..." -> "Таиланд"
      const country = (descr.match(/^\d\*,\s*([^,]+?)(?:,| из )/) || [])[1] || 'Другое';
      const vals = c.querySelectorAll('.TVOfferPriceValue');
      const imgEl = c.querySelector('.TVHotOfferImg');
      const img = imgEl.querySelector('img')?.src || (getComputedStyle(imgEl).backgroundImage.match(/url\("?(.+?)"?\)/) || [])[1] || '';
      // номер тура берём из окна «Поделиться»; ссылку для клиента бот соберёт сам
      c.querySelector('.TVHotOfferShare').click();
      let id = '';
      for (let t = 0; t < 20 && !id; t++) {
        await wait(150);
        const v = [...document.querySelectorAll('input,textarea')].map(i => i.value).find(v => /tvofferid=/.test(v));
        id = v ? v.match(/tvofferid=(\d+)/)[1] : '';
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      if (!id || items.some(t => t.id === id)) continue;
      items.push({
        id, country, img, descr, dep: NAME[city] || city,
        title: txt(c, '.TVHotOfferTitle'),
        price: num(vals[0]?.textContent || ''),
        oldPrice: num(vals[1]?.textContent || ''),
        discount: txt(c, '.TVOfferPriceDiscount'),
        date: txt(c, '.TVHotOfferDate'),
      });
      count[NAME[city] || city] = (count[NAME[city] || city] || 0) + 1;
    }
  }
  if (!items.length) return 'ОШИБКА: на странице не найдено ни одного тура';
  const r = await fetch('https://goryashie-tury-bot.qazstudio.workers.dev/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-secret': SECRET },
    body: JSON.stringify({ updated: new Date().toISOString(), items }),
  });
  return r.status + ' ' + (await r.text()) + ' ' + JSON.stringify(count);
})();
