// Live test: extension-context invalidation must tear the instance down
// quietly — no uncaught errors — in both failure modes:
//   A. chrome.runtime.id disappears (extension reloaded while tab stays open)
//   B. sendMessage throws synchronously ("Extension context invalidated")

const ROOT = '/Users/steventok/Documents/code/larp';
const bundle = fs.readFileSync(`${ROOT}/dev/test-bundle.js`, 'utf8').replace(/;\s*$/, '');
const css = fs.readFileSync(`${ROOT}/content/content.css`, 'utf8');

const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));

const inject = async () => {
  await page.evaluate((styleText) => {
    if (!document.getElementById('larp-test-style')) {
      const nonce = document.querySelector('script[nonce]')?.nonce || '';
      const el = document.createElement('style');
      el.id = 'larp-test-style';
      if (nonce) el.nonce = nonce;
      el.textContent = styleText;
      document.head.append(el);
    }
  }, css);
  await page.evaluate(bundle);
  await page.waitForTimeout(2500);
};

// Scroll card-by-card (text-bearing, no verdict yet) until a send is attempted.
// Returns per-attempt diagnostics so we can see which path each card took.
const triggerAnalysisAttempts = async (maxAttempts = 4) => {
  const log = [];
  for (let i = 0; i < maxAttempts; i++) {
    const state = await page.evaluate(() => ({
      loaded: window.__larpDetectorLoaded,
      debug: { ...window.__larpDebug },
    }));
    if (!state.loaded) {
      log.push({ stoppedAlready: true });
      break;
    }
    const scrolled = await page.evaluate(() => {
      const card = [...document.querySelectorAll('[componentkey^="update-card-focus"]')].find(
        (c) =>
          !c.querySelector('.larp-badge') &&
          !c.dataset.larpTestVisited &&
          (c.querySelector('[data-testid="expandable-text-box"]')?.innerText || '').trim().length > 80
      );
      if (!card) return false;
      card.dataset.larpTestVisited = '1';
      card.scrollIntoView({ block: 'center' });
      return true;
    });
    await page.waitForTimeout(1600);
    const post = await page.evaluate(() => ({
      loaded: window.__larpDetectorLoaded,
      debug: { ...window.__larpDebug },
    }));
    log.push({
      scrolled,
      loadedAfter: post.loaded,
      analyzed: post.debug.analyzed,
      skipped: post.debug.skipped,
      visible: post.debug.visible,
    });
    if (!post.loaded) break;
  }
  return log;
};

if (!page.url().includes('linkedin.com')) {
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
}
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);

// --- Case A: runtime.id vanishes -----------------------------------------
await inject();
const baseline = await page.evaluate(() => ({
  loaded: window.__larpDetectorLoaded,
  badges: document.querySelectorAll('.larp-badge').length,
  scans: window.__larpDebug?.scans ?? 0,
}));

await page.evaluate(() => {
  window.chrome.runtime.id = undefined;
});
const caseALog = await triggerAnalysisAttempts();
const scansAfterA1 = await page.evaluate(() => window.__larpDebug?.scans ?? 0);
await page.waitForTimeout(4000);
const afterA = await page.evaluate(() => ({
  loaded: window.__larpDetectorLoaded,
  scans: window.__larpDebug?.scans ?? 0,
}));

// --- Case B: sendMessage throws while id still exists ---------------------
await page.evaluate(() => {
  window.chrome.runtime.id = 'test-shim';
});
await inject(); // fresh instance (init works: id is back)
const caseBReady = await page.evaluate(() => window.__larpDetectorLoaded);

await page.evaluate(() => {
  window.chrome.runtime.sendMessage = () => {
    throw new Error('Extension context invalidated.');
  };
});
const caseBLog = await triggerAnalysisAttempts();
const scansAfterB1 = await page.evaluate(() => window.__larpDebug?.scans ?? 0);
await page.waitForTimeout(4000);
const afterB = await page.evaluate(() => ({
  loaded: window.__larpDetectorLoaded,
  scans: window.__larpDebug?.scans ?? 0,
}));

return {
  baseline,
  caseA: {
    attempts: caseALog,
    teardownRan: afterA.loaded === false,
    scanningStopped: afterA.scans === scansAfterA1,
    scansDelta: afterA.scans - scansAfterA1,
  },
  caseB: {
    instanceWasAlive: caseBReady === true,
    attempts: caseBLog,
    teardownRan: afterB.loaded === false,
    scanningStopped: afterB.scans === scansAfterB1,
    scansDelta: afterB.scans - scansAfterB1,
  },
  uncaughtErrors: errors,
};
