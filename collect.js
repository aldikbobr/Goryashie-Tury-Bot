// Запускается в Chrome на странице https://pro.tourvisor.ru/search?tab=hotOffers (кабинет агентства).
// Перед кодом нужно подставить строку: const SECRET = '<содержимое файла .update-secret>';
// Собирает горящие туры из ленты и отправляет их боту. Возвращает ответ бота: {"saved":N,"posted":M}.
await (async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  for (let t = 0; t < 40 && !document.querySelector('.TVHotOfferControl'); t++) await wait(300);
  const txt = (el, sel) => (el.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
  const num = s => Number(s.replace(/\D/g, '')) || 0;
  const items = [];
  for (const c of document.querySelectorAll('.TVHotOfferControl')) {
    const descr = txt(c, '.TVHotOfferDescr');
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
    if (!id) continue;
    items.push({
      id, country, img, descr,
      title: txt(c, '.TVHotOfferTitle'),
      price: num(vals[0]?.textContent || ''),
      oldPrice: num(vals[1]?.textContent || ''),
      discount: txt(c, '.TVOfferPriceDiscount'),
      date: txt(c, '.TVHotOfferDate'),
    });
  }
  if (!items.length) return 'ОШИБКА: на странице не найдено ни одного тура';
  const r = await fetch('https://goryashie-tury-bot.qazstudio.workers.dev/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-secret': SECRET },
    body: JSON.stringify({ updated: new Date().toISOString(), items }),
  });
  return r.status + ' ' + (await r.text());
})();
