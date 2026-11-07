// Запускается в Chrome на странице pro.tourvisor.ru/search?tab=hotOffers.
// Собирает горящие туры из ленты и возвращает JSON для бота.
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
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
    // ссылка для клиента из окна «Поделиться»
    document.querySelectorAll('input,textarea').forEach(i => (i.dataset.old = '1'));
    c.querySelector('.TVHotOfferShare').click();
    let link = '';
    for (let t = 0; t < 20 && !link; t++) {
      await wait(150);
      const v = [...document.querySelectorAll('input,textarea')].map(i => i.value).find(v => /tvofferid=/.test(v));
      link = v ? v.match(/https?:\/\/\S+/)[0] : '';
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const id = (link.match(/tvofferid=([^&]+)/) || [])[1] || txt(c, '.TVHotOfferTitle');
    items.push({
      id, country, link, img,
      title: txt(c, '.TVHotOfferTitle'),
      descr,
      price: num(vals[0]?.textContent || ''),
      oldPrice: num(vals[1]?.textContent || ''),
      discount: txt(c, '.TVOfferPriceDiscount'),
      date: txt(c, '.TVHotOfferDate'),
    });
  }
  return JSON.stringify({ updated: new Date().toISOString(), items });
})();
