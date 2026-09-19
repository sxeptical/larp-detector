// Diagnostic: does the extension run on a FRESH LinkedIn page? And is the
// chrome-extension://invalid/ flood from LinkedIn, Browser Control, or us?

const events = [];
const watch = (tag) => {
  const onConsole = (m) => events.push({ tag, type: m.type(), text: m.text().slice(0, 140) });
  const onFailed = (r) => events.push({ tag, failed: r.url().slice(0, 140), err: r.failure()?.errorText });
  page.on('console', onConsole);
  page.on('requestfailed', onFailed);
  return () => {
    page.off('console', onConsole);
    page.off('requestfailed', onFailed);
  };
};

// Phase 1: a completely unrelated site — does the flood appear with no LinkedIn?
const stop1 = watch('example');
await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
stop1();

// Phase 2: fresh LinkedIn feed page, loaded after any extension install
const stop2 = watch('linkedin');
await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(10000);
const linkedinState = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  feedPresent: Boolean(document.querySelector('[data-testid="mainFeed"]')),
  cards: document.querySelectorAll('[componentkey^="update-card-focus"]').length,
  observed: document.querySelectorAll('[data-larp-observed]').length,
  badges: document.querySelectorAll('.larp-badge').length,
  anchors: document.querySelectorAll('.larp-post-anchor').length,
  testBundleAlive: typeof window.__larpTeardown === 'function' || Boolean(window.__larpDetectorLoaded),
}));
stop2();

const invalid = (tag) =>
  events.filter((e) => e.tag === tag && JSON.stringify(e).includes('chrome-extension://invalid')).length;

return {
  exampleCom: {
    totalEvents: events.filter((e) => e.tag === 'example').length,
    invalidFlood: invalid('example'),
    sample: events.filter((e) => e.tag === 'example').slice(0, 3),
  },
  linkedin: {
    state: linkedinState,
    totalEvents: events.filter((e) => e.tag === 'linkedin').length,
    invalidFlood: invalid('linkedin'),
    sample: events.filter((e) => e.tag === 'linkedin').slice(0, 5),
  },
};
