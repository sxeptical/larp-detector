// Measure what occupies the top-right corner of feed cards, relative to the
// card's top/right edges, so the badge offset can clear LinkedIn's own buttons.
if (!page.url().includes('linkedin.com')) {
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
}

const out = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('[componentkey^="update-card-focus"]')].slice(0, 5);
  return cards.map((card, i) => {
    const cr = card.getBoundingClientRect();
    const buttons = [...card.querySelectorAll('button')]
      .map((b) => {
        const r = b.getBoundingClientRect();
        return {
          label: (b.getAttribute('aria-label') || b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 34),
          topFromCard: Math.round(r.top - cr.top),
          rightFromCard: Math.round(cr.right - r.right),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      })
      .filter((b) => b.topFromCard < 120 && b.w < 200)
      .slice(0, 8);
    return { card: i, cardTop: Math.round(cr.top), cardH: Math.round(cr.height), buttons };
  });
});
return out;
