/**
 * LARP Detector — content script.
 *
 * Watches the LinkedIn feed, extracts feed posts as they scroll into view,
 * asks the service worker for a verdict, and paints a badge on the post.
 *
 * All judgment lives in the background worker (and lib/). This file only does
 * DOM work. LinkedIn is Ember with obfuscated classes and a virtualized feed
 * (nodes are recycled for different posts), so we:
 *   - anchor identity on `data-urn` attributes, not classes
 *   - keep every selector in SELECTORS, with fallbacks, so fixes are one-file
 *   - key analysis on (node, current urn) so recycled nodes get re-analyzed
 *   - keep a per-page verdict map so re-scrolled posts re-badge instantly
 */

(() => {
  if (window.__larpDetectorLoaded) return;
  window.__larpDetectorLoaded = true;

  // -------------------------------------------------------------------------
  // Selectors — when LinkedIn changes its DOM, fix it here.
  // -------------------------------------------------------------------------
  const SELECTORS = {
    feedRoots: ['div[data-testid="mainFeed"]', '.scaffold-finite-scroll__content', 'main'],
    posts: ['div[data-urn^="urn:li:activity:"]', 'div[data-urn^="urn:li:ugcPost:"]'],
    text: [
      '.feed-shared-update-v2__description',
      '.update-components-text',
      '.feed-shared-inline-show-more-text',
      '.feed-shared-text',
      '[data-testid="expandable-text-box"]',
    ],
    headline: ['.update-components-actor__description', '.feed-shared-actor__description'],
    actor: ['.update-components-actor', '.feed-shared-actor'],
  };

  const POST_SELECTOR = SELECTORS.posts.join(',');
  const SCAN_INTERVAL_MS = 3000;
  const MAX_TEXT_CHARS = 1800;

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  let settings = { enabled: true, showGenuine: false, sensitivity: 1.5 };

  /** urn -> { verdict, show } — lets recycled/re-scrolled posts re-badge with no round-trip */
  const verdictByUrn = new Map();
  /** node -> urn last analyzed for that node (nodes get recycled) */
  const analyzedNodeUrn = new WeakMap();

  let intersectionObserver = null;
  let mutationTimer = null;
  let scanTimer = null;
  let localAnalyzerPromise = null;

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  init();

  async function init() {
    settings = await getSettings();
    setupIntersectionObserver();
    setupMutationObserver();
    patchHistory();
    scan();
    scanTimer = setInterval(scan, SCAN_INTERVAL_MS);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const next = changes['larp_settings']?.newValue;
      if (!next) return;
      const wasEnabled = settings.enabled;
      settings = { ...settings, ...next };
      if (!settings.enabled && wasEnabled) removeAllBadges();
      if (settings.enabled && !wasEnabled) scan();
      if (wasEnabled) rescanVisible(); // sensitivity / showGenuine changed
    });
  }

  function getSettings() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (res) => {
        if (chrome.runtime.lastError || !res?.ok) {
          resolve({ enabled: true, showGenuine: false, sensitivity: 1.5 });
        } else {
          resolve(res.settings);
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // Observers
  // -------------------------------------------------------------------------
  function setupIntersectionObserver() {
    intersectionObserver = new IntersectionObserver(
      (entries) => {
        if (!settings.enabled) return;
        for (const entry of entries) {
          if (entry.isIntersecting) onPostVisible(entry.target);
        }
      },
      { rootMargin: '150px 0px' }
    );
  }

  function setupMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      let interesting = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.matches?.(POST_SELECTOR) || node.querySelector?.(POST_SELECTOR)) {
            interesting = true;
            break;
          }
        }
        if (interesting) break;
      }
      if (!interesting) return;
      clearTimeout(mutationTimer);
      mutationTimer = setTimeout(scheduleScan, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function patchHistory() {
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      history[method] = function (...args) {
        const result = original.apply(this, args);
        setTimeout(scheduleScan, 500);
        return result;
      };
    }
    window.addEventListener('popstate', () => setTimeout(scheduleScan, 500));
  }

  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestIdleCallback(() => {
      scanScheduled = false;
      scan();
    });
  }

  function feedRoots() {
    const roots = [];
    for (const sel of SELECTORS.feedRoots) {
      for (const root of document.querySelectorAll(sel)) roots.push(root);
    }
    return roots.length ? roots : [document.body];
  }

  function scan() {
    if (!settings.enabled) return;
    for (const root of feedRoots()) {
      for (const el of root.querySelectorAll(POST_SELECTOR)) {
        observePost(el);
      }
    }
  }

  function observePost(el) {
    // Only badge the outermost activity node — reshares nest one inside another.
    if (el.parentElement?.closest(POST_SELECTOR)) return;
    if (!el.dataset.larpObserved) {
      el.dataset.larpObserved = '1';
      intersectionObserver.observe(el);
    }
    // Already visible (e.g. after a rescan)? Analyze immediately.
    if (isInViewport(el)) onPostVisible(el);
  }

  function rescanVisible() {
    for (const el of document.querySelectorAll(POST_SELECTOR)) {
      if (isInViewport(el)) onPostVisible(el, true);
    }
  }

  function isInViewport(el) {
    const rect = el.getBoundingClientRect();
    return rect.top < window.innerHeight + 150 && rect.bottom > -150;
  }

  // -------------------------------------------------------------------------
  // Extraction
  // -------------------------------------------------------------------------
  function urnOf(el) {
    return el.getAttribute('data-urn') || el.closest('[data-urn]')?.getAttribute('data-urn') || null;
  }

  function extractPost(el) {
    const urn = urnOf(el);
    if (!urn) return null;

    let post_text = '';
    for (const sel of SELECTORS.text) {
      const node = el.querySelector(sel);
      const text = node?.innerText?.trim() || '';
      if (text.length > post_text.length) post_text = text;
    }
    post_text = post_text.slice(0, MAX_TEXT_CHARS);

    let author_headline = '';
    for (const sel of SELECTORS.headline) {
      const text = el.querySelector(sel)?.innerText?.trim() || '';
      if (text) {
        author_headline = text.slice(0, 200);
        break;
      }
    }

    let isPromoted = false;
    for (const sel of SELECTORS.actor) {
      const actorText = el.querySelector(sel)?.innerText?.slice(0, 200) || '';
      if (/\bpromoted\b/i.test(actorText)) {
        isPromoted = true;
        break;
      }
      if (actorText) break;
    }

    return { urn, post_text, author_headline, isPromoted };
  }

  // -------------------------------------------------------------------------
  // Analysis flow
  // -------------------------------------------------------------------------
  function onPostVisible(el, force = false) {
    const urn = urnOf(el);
    if (!urn) return;

    // Node recycled to a different post? Drop stale badges first.
    purgeStaleBadges(el, urn);

    const lastUrn = analyzedNodeUrn.get(el);
    if (!force && lastUrn === urn) return;

    // Instant re-badge from the per-page map.
    const known = verdictByUrn.get(urn);
    if (known && !force) {
      applyVerdict(el, urn, known.verdict, known.show);
      return;
    }

    const post = extractPost(el);
    if (!post) return;

    analyzedNodeUrn.set(el, urn);

    if (post.isPromoted) {
      applyVerdict(el, urn, sponsored(), true, { store: true });
      return;
    }
    if (!post.post_text || post.post_text.trim().length < 20) return;

    showAnalyzing(el, urn);

    chrome.runtime.sendMessage({ type: 'ANALYZE_POST', post }, (res) => {
      removeBadge(el, urn, 'analyzing');
      if (chrome.runtime.lastError || !res?.ok) {
        analyzeLocally(el, urn, post); // service worker unreachable → heuristics
        return;
      }
      if (urnOf(el) !== urn) {
        // Node was recycled while the answer was in flight — stash it so the
        // post re-badges instantly when it scrolls back into view.
        if (res.verdict) verdictByUrn.set(urn, { verdict: res.verdict, show: res.show });
        return;
      }
      applyVerdict(el, urn, res.verdict, res.show, { store: true });
    });
  }

  /** Offline path: dynamic-import the heuristics + composer from the extension bundle. */
  async function analyzeLocally(el, urn, post) {
    try {
      if (!localAnalyzerPromise) {
        localAnalyzerPromise = Promise.all([
          import(chrome.runtime.getURL('lib/heuristics.js')),
          import(chrome.runtime.getURL('lib/verdict.js')),
        ]).then(([h, v]) => ({ analyze: h.analyzeHeuristically, compose: v.composeVerdict, show: v.shouldShow }));
      }
      const { analyze, compose, show } = await localAnalyzerPromise;
      const result = analyze(post);
      const verdict = result
        ? compose(result.answers, { model: result.model, usage: result.usage, source: 'offline-heuristic' })
        : null;
      if (!verdict) return;
      if (urnOf(el) !== urn) {
        verdictByUrn.set(urn, { verdict, show: show(verdict, settings) });
        return;
      }
      applyVerdict(el, urn, verdict, show(verdict, settings), { store: true });
    } catch (err) {
      console.warn('[LARP] local analysis failed', err);
    }
  }

  function sponsored() {
    return {
      kind: 'sponsored',
      role: 'sponsored',
      label: 'SPONSORED',
      emoji: '💰',
      color: 'gold',
      pct: null,
      score: null,
      source: 'platform',
      model: null,
      details: ['Paid placement — no LARP analysis performed'],
    };
  }

  // -------------------------------------------------------------------------
  // Badge rendering
  // -------------------------------------------------------------------------
  function badgesOf(el) {
    return el.querySelectorAll(':scope > .larp-badge');
  }

  function purgeStaleBadges(el, urn) {
    for (const badge of badgesOf(el)) {
      if (badge.dataset.urn !== urn) badge.remove();
    }
  }

  function removeBadge(el, urn, kind) {
    for (const badge of badgesOf(el)) {
      if (badge.dataset.urn === urn && (!kind || badge.dataset.kind === kind)) badge.remove();
    }
  }

  function showAnalyzing(el, urn) {
    removeBadge(el, urn, 'analyzing');
    if (badgesOf(el).length > 0) return; // a verdict badge already sits there
    const badge = document.createElement('div');
    badge.className = 'larp-badge larp-badge--analyzing';
    badge.dataset.urn = urn;
    badge.dataset.kind = 'analyzing';
    badge.textContent = '⏳ checking for larp…';
    el.classList.add('larp-post-anchor');
    el.appendChild(badge);
  }

  function applyVerdict(el, urn, verdict, show, opts = {}) {
    // Idempotence: the 3s scan re-visits visible posts. If the badge already
    // shows this exact verdict, do nothing — no re-render, no re-animation.
    const existing = [...badgesOf(el)].find(
      (b) => b.dataset.urn === urn && b.dataset.kind === 'verdict'
    );
    if (existing && verdict && show) {
      if (
        existing.dataset.label === verdict.label &&
        existing.dataset.pct === String(verdict.pct ?? '')
      ) {
        return;
      }
    }

    removeBadge(el, urn, 'analyzing');
    removeBadge(el, urn, 'verdict');

    if (!verdict || !show) {
      if (opts.store) verdictByUrn.set(urn, { verdict, show: false });
      return;
    }

    if (opts.store) verdictByUrn.set(urn, { verdict, show });

    const badge = document.createElement('div');
    badge.className = `larp-badge larp-badge--${verdict.color || 'gray'}`;
    badge.dataset.urn = urn;
    badge.dataset.kind = 'verdict';
    badge.dataset.label = verdict.label || 'LARP';
    badge.dataset.pct = String(verdict.pct ?? '');

    const emoji = document.createElement('span');
    emoji.className = 'larp-badge__emoji';
    emoji.textContent = verdict.emoji || '🎭';

    const label = document.createElement('span');
    label.className = 'larp-badge__label';
    label.textContent = verdict.label || 'LARP';

    badge.append(emoji, label);

    if (typeof verdict.pct === 'number') {
      const pct = document.createElement('span');
      pct.className = 'larp-badge__pct';
      pct.textContent = `${verdict.pct}%`;
      badge.appendChild(pct);
    }

    badge.title = [`LARPING AS: ${verdict.label}`, ...(verdict.details || [])].join('\n');

    el.classList.add('larp-post-anchor');
    el.appendChild(badge);
  }

  function removeAllBadges() {
    for (const badge of document.querySelectorAll('.larp-badge')) badge.remove();
    verdictByUrn.clear();
    for (const el of document.querySelectorAll(POST_SELECTOR)) {
      analyzedNodeUrn.delete(el);
      delete el.dataset.larpObserved;
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup / bfcache
  // -------------------------------------------------------------------------
  window.addEventListener('pagehide', () => {
    clearInterval(scanTimer);
    scanTimer = null;
  });
  window.addEventListener('pageshow', () => {
    if (!scanTimer) scanTimer = setInterval(scan, SCAN_INTERVAL_MS);
    scheduleScan();
  });
})();
