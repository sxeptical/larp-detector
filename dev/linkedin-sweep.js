// Sweep test: inject fresh, then bring every card into view one at a time via
// scrollIntoView (works regardless of which container actually scrolls) and
// report badges + debug counters.

const ROOT = '/Users/steventok/Documents/code/larp';
const bundle = fs.readFileSync(`${ROOT}/dev/test-bundle.js`, 'utf8').replace(/;\s*$/, '');
const css = fs.readFileSync(`${ROOT}/content/content.css`, 'utf8');

// Fresh page = only ONE content-script instance (production-like). Old test
// injections from earlier runs can't be torn down retroactively.
if (!page.url().includes('linkedin.com')) {
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
}
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);

await page.evaluate((styleText) => {
  const nonce = document.querySelector('script[nonce]')?.nonce || '';
  const el = document.createElement('style');
  if (nonce) el.nonce = nonce;
  el.textContent = styleText;
  document.head.append(el);
}, css);

await page.evaluate(bundle);
await page.waitForTimeout(2000);

// Scroll mechanics probe: which element actually scrolls?
const scrollProbe = await page.evaluate(() => {
  const se = document.scrollingElement;
  const before = se.scrollTop;
  se.scrollTop += 600;
  const after = se.scrollTop;
  se.scrollTop = before;
  const scrollables = [...document.querySelectorAll('div')]
    .filter((el) => {
      const s = getComputedStyle(el);
      return (
        (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
        el.scrollHeight > el.clientHeight + 200 &&
        el.clientHeight > 300
      );
    })
    .slice(0, 4)
    .map((el) => ({ cls: String(el.className).slice(0, 40), sh: el.scrollHeight, ch: el.clientHeight }));
  return { seTopBefore: before, seTopAfter: after, documentScrolls: after !== before, scrollables };
});

// Sweep every card into view
const sweep = await page.evaluate(async () => {
  const cards = [...document.querySelectorAll('[componentkey^="update-card-focus"]')];
  for (const card of cards) {
    card.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 900));
  }
  return cards.length;
});

await page.waitForTimeout(2000);

const result = await page.evaluate(() => {
  const POST_SEL = '[componentkey^="update-card-focus"]';
  const shorten = (s, n = 34) => (s || '').replace(/\s+/g, ' ').slice(0, n);
  const cards = [...document.querySelectorAll(POST_SEL)];
  return {
    cards: cards.length,
    badgeCount: document.querySelectorAll('.larp-badge').length,
    debug: { ...window.__larpDebug },
    perCard: cards.map((el) => {
      const textEl = el.querySelector('[data-testid="expandable-text-box"]');
      return {
        id: shorten(el.getAttribute('componentkey'), 30),
        textLen: textEl ? textEl.innerText.trim().length : -1,
        badge: shorten(el.querySelector('.larp-badge')?.innerText, 28) || null,
      };
    }),
    log: (window.__larpTestLog || []).map((e) => ({
      label: e.label,
      pct: e.pct,
      hl: e.headline,
      text: e.text.slice(0, 45),
    })),
  };
});

// Back to the top of the feed for the screenshot, with badges still held
// (the test bundle sets __larpBadgeVisibleMs = 60000)
const firstCard = await page.$$('[componentkey^="update-card-focus"]');
if (firstCard.length > 0) {
  await firstCard[0].scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
}
await page.screenshot({ path: `${ROOT}/dev/linkedin-sweep.png`, fullPage: false });
return { scrollProbe, swept: sweep, ...result };
