// LARP Detector — live LinkedIn content-script test.
// Injects the real content script + heuristics/verdict pipeline (with a chrome
// shim) into the attached LinkedIn tab, scrolls the feed, and reports what
// actually happened: selector hits, badges, verdicts, screenshots.

const ROOT = '/Users/steventok/Documents/code/larp';
// Trailing semicolon would make the IIFE a statement, not an expression.
const bundle = fs.readFileSync(`${ROOT}/dev/test-bundle.js`, 'utf8').replace(/;\s*$/, '');
const css = fs.readFileSync(`${ROOT}/content/content.css`, 'utf8');

// Fresh page = only ONE content-script instance (production-like).
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);

// Badge styles. LinkedIn's CSP may block naive <style> injection — fall back
// to reusing the page's own CSP nonce.
let styleInjected = 'ok';
try {
  await page.addStyleTag({ content: css });
} catch {
  try {
    styleInjected = await page.evaluate((styleText) => {
      const nonce = document.querySelector('script[nonce]')?.nonce || '';
      const el = document.createElement('style');
      if (nonce) el.nonce = nonce;
      el.textContent = styleText;
      document.head.append(el);
      return el.nonce ? 'nonce' : 'no-nonce';
    }, css);
  } catch (err) {
    styleInjected = `blocked: ${String(err).slice(0, 80)}`;
  }
}

// CDP evaluation bypasses the page CSP, unlike addScriptTag.
await page.evaluate(bundle);

// Let settings load + first viewport analyze
await page.waitForTimeout(3000);

// Realistic scroll: mouse wheel over the feed (window.scrollBy does nothing —
// LinkedIn's feed scrolls inside its own container)
await page.mouse.move(700, 500);
for (let i = 0; i < 10; i++) {
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(1300);
}
// Back to the top for a clean screenshot
for (let i = 0; i < 12; i++) {
  await page.mouse.wheel(0, -900);
  await page.waitForTimeout(350);
}
await page.waitForTimeout(2500);

// Verify the scan loop is alive (counters should advance while we idle)
const debugBefore = await page.evaluate(() => ({ ...window.__larpDebug }));
await page.waitForTimeout(4000);
const debugAfter = await page.evaluate(() => ({ ...window.__larpDebug }));

const result = await page.evaluate(() => {
  const POST_SEL =
    '[componentkey^="update-card-focus"], div[data-urn^="urn:li:activity:"], div[data-urn^="urn:li:ugcPost:"]';
  const TEXT_SELS = [
    '[data-testid="expandable-text-box"]',
    '.feed-shared-update-v2__description',
    '.update-components-text',
    '.feed-shared-inline-show-more-text',
    '.feed-shared-text',
  ];

  const shorten = (s, n = 40) => (s || '').replace(/\s+/g, ' ').slice(0, n);

  const posts = [...document.querySelectorAll(POST_SEL)];
  const diagnostics = posts.map((el) => {
    const textLen = Math.max(
      ...TEXT_SELS.map((s) => {
        const n = el.querySelector(s);
        return n ? n.innerText.trim().length : -1;
      })
    );
    return {
      id: shorten(el.getAttribute('componentkey') || el.getAttribute('data-urn'), 46),
      textLen,
      firstLines: el.innerText.split('\n').filter(Boolean).slice(0, 5).map((l) => shorten(l, 44)),
      hasBadge: Boolean(el.querySelector(':scope > .larp-badge')),
      badgeText: shorten(el.querySelector(':scope > .larp-badge')?.innerText, 30),
    };
  });

  return {
    url: location.href,
    postCount: posts.length,
    badgeCount: document.querySelectorAll('.larp-badge').length,
    anchorCount: document.querySelectorAll('.larp-post-anchor').length,
    analyzed: (window.__larpTestLog || []).length,
    log: (window.__larpTestLog || []).map((e) => ({
      label: e.label,
      pct: e.pct,
      score: e.score,
      headline: e.headline,
      text: e.text.slice(0, 55),
    })),
    diagnostics,
  };
});

await page.screenshot({ path: `${ROOT}/dev/linkedin-test.png`, fullPage: false });
result.styleInjected = styleInjected;
result.debug = debugAfter;
result.scansDuringIdle = debugAfter.scans - debugBefore.scans;
return result;
