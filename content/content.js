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
  // Verified against the live feed on 2026-09-19: posts are
  //   [componentkey^="update-card-focus"]  (role=listitem, no data-urn anymore)
  //   text: [data-testid="expandable-text-box"]
  // Legacy selectors are kept as fallbacks for older/AB-tested UIs.
  // -------------------------------------------------------------------------
  const SELECTORS = {
    feedRoots: ['[data-testid="mainFeed"]', '.scaffold-finite-scroll__content', 'main'],
    posts: [
      '[componentkey^="update-card-focus"]', // current LinkedIn (2026-09)
      'div[data-urn^="urn:li:activity:"]', // legacy
      'div[data-urn^="urn:li:ugcPost:"]', // legacy
      'div.feed-shared-update-v2[data-urn]', // legacy
    ],
    text: [
      '[data-testid="expandable-text-box"]', // current LinkedIn (2026-09)
      '.feed-shared-update-v2__description',
      '.update-components-text',
      '.feed-shared-inline-show-more-text',
      '.feed-shared-text',
    ],
    // Legacy DOM only — the current UI has no stable selector for the actor
    // subtitle, so headlines are parsed from the card's text lines instead.
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
  /** textHash -> { verdict, show } — LinkedIn re-renders cards with NEW ids for the
   *  same post, so identity needs a content fallback to avoid re-analyzing. */
  const verdictByText = new Map();
  /** node -> urn last analyzed for that node (nodes get recycled) */
  const analyzedNodeUrn = new WeakMap();

  let intersectionObserver = null;
  let mutationObserver = null;
  let mutationTimer = null;
  let scanTimer = null;
  let localAnalyzerPromise = null;

  /** Debug counters — read from the console or the browser-control test harness. */
  const debug = (window.__larpDebug = {
    scans: 0,
    observed: 0,
    visible: 0,
    analyzed: 0,
    skipped: 0,
    lastScanAt: 0,
  });

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
    mutationObserver = new MutationObserver((mutations) => {
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
    mutationObserver.observe(document.body, { childList: true, subtree: true });
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
    debug.scans++;
    debug.lastScanAt = Date.now();
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
      debug.observed++;
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
    return (
      el.getAttribute('data-urn') ||
      el.closest('[data-urn]')?.getAttribute('data-urn') ||
      el.getAttribute('componentkey') || // current LinkedIn: update-card-focus<id>FeedType_...
      el.closest('[componentkey^="update-card-focus"]')?.getAttribute('componentkey') ||
      null
    );
  }

  /** FNV-1a — content identity fallback when the DOM id changes between renders. */
  function textHash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  // -------------------------------------------------------------------------
  // Card-text parsers — the current UI has no stable class/testid anchors for
  // actor chrome, so we parse the card's rendered lines. Durable against
  // LinkedIn's hashed-class churn; adjust the patterns when the layout shifts.
  // -------------------------------------------------------------------------
  const RE_CHROME_LINE = /^(feed post|suggested|promoted|sponsored)$/i;
  const RE_TIME_LINE = /^\d+(s|m|h|d|w|mo|y)(\s*[•·]\s*edited)?$/i;
  const RE_DEGREE_LINE = /^[•·]\s*\d+(st|nd|rd|th)\+?$/i;
  const RE_FOLLOW_LINE = /^[•·]?\s*(follow|following|connect|\+)$/i;
  const RE_SOCIAL_LINE = /(likes|liked|reposted|commented on|celebrates) this|and \d+ others/i;
  // Our own badge renders inside the card and pollutes innerText — filter it.
  // The pill is inline-flex, so it appears as ONE line: "INFLUENCER | 33%".
  const RE_BADGE_LABEL = /^(real one|philosopher|10x engineer|influencer|martyr|bait|ai slop|sponsored|larp)(\s*[|·]?\s*\d{1,3}%)?$/i;
  const RE_PERCENT = /^\d{1,3}%$/;

  function cardLines(el) {
    return el.innerText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !RE_BADGE_LABEL.test(l) && !RE_PERCENT.test(l));
  }

  /**
   * Headline = the line between "<name> [• 3rd+]" and the timestamp, e.g.
   *   Feed post / Suggested / Fathan Kartagama / • 3rd+ / <HEADLINE> / 2d / Follow
   * Company pages have no headline line — then the next line is the post body,
   * which we must not mistake for one.
   */
  function extractHeadlineFromLines(lines, postText) {
    let i = 0;
    while (i < lines.length && (RE_CHROME_LINE.test(lines[i]) || RE_SOCIAL_LINE.test(lines[i]))) i++;
    i++; // skip the author name
    while (i < lines.length && (RE_DEGREE_LINE.test(lines[i]) || RE_CHROME_LINE.test(lines[i]))) i++;
    while (i < lines.length && (RE_TIME_LINE.test(lines[i]) || RE_FOLLOW_LINE.test(lines[i]))) i++;
    const candidate = lines[i] || '';
    if (!candidate || RE_TIME_LINE.test(candidate) || RE_FOLLOW_LINE.test(candidate)) return '';

    // Company posts: the "headline" slot holds the post body — reject that.
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const firstBodyLine = norm(postText.split('\n')[0]);
    const c = norm(candidate);
    if (firstBodyLine && (c.startsWith(firstBodyLine.slice(0, 30)) || firstBodyLine.startsWith(c))) {
      return '';
    }
    return candidate.slice(0, 200);
  }

  function isPromotedCard(el, lines) {
    if (lines.slice(0, 4).some((l) => /^promoted$/i.test(l))) return true;
    for (const sel of SELECTORS.actor) {
      const actorText = el.querySelector(sel)?.innerText?.slice(0, 200) || '';
      if (/\bpromoted\b/i.test(actorText)) return true;
    }
    return false;
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
    post_text = post_text
      .replace(/\s*…?\s*see more\s*$/i, '')
      .trim()
      .slice(0, MAX_TEXT_CHARS);

    let author_headline = '';
    for (const sel of SELECTORS.headline) {
      const text = el.querySelector(sel)?.innerText?.trim() || '';
      if (text) {
        author_headline = text.slice(0, 200);
        break;
      }
    }

    const lines = cardLines(el);
    if (!author_headline) author_headline = extractHeadlineFromLines(lines, post_text);

    return { urn, post_text, author_headline, isPromoted: isPromotedCard(el, lines) };
  }

  // -------------------------------------------------------------------------
  // Analysis flow
  // -------------------------------------------------------------------------
  function onPostVisible(el, force = false) {
    const urn = urnOf(el);
    if (!urn) return;
    debug.visible++;

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
    if (!post.post_text || post.post_text.trim().length < 20) {
      debug.skipped++;
      return;
    }

    // Same post rendered as a fresh card (new componentkey)? Re-badge from the
    // text cache without another analysis round-trip. Hash a normalized prefix:
    // LinkedIn re-renders long posts with different collapse/truncation states,
    // and the prefix is what stays stable across those renders.
    const textKey = textHash(post.post_text.slice(0, 160).toLowerCase());
    const knownByText = verdictByText.get(textKey);
    if (knownByText && !force) {
      applyVerdict(el, urn, knownByText.verdict, knownByText.show);
      return;
    }

    debug.analyzed++;
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
        if (res.verdict) {
          verdictByUrn.set(urn, { verdict: res.verdict, show: res.show });
          verdictByText.set(textKey, { verdict: res.verdict, show: res.show });
        }
        return;
      }
      applyVerdict(el, urn, res.verdict, res.show, { store: true, textKey });
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
        verdictByText.set(textKey, { verdict, show: show(verdict, settings) });
        return;
      }
      applyVerdict(el, urn, verdict, show(verdict, settings), { store: true, textKey });
    } catch (err) {
      console.warn('[LARP] local analysis failed', err);
    }
  }

  function sponsored() {
    return {
      kind: 'sponsored',
      role: 'sponsored',
      label: 'SPONSORED',
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
    return el.querySelectorAll('.larp-badge');
  }

  /** Clear any pending fade timer before removing a badge. */
  function disposeBadge(badge) {
    if (badge._larpTimer) {
      clearTimeout(badge._larpTimer);
      badge._larpTimer = null;
    }
    badge.remove();
  }

  function purgeStaleBadges(el, urn) {
    for (const badge of badgesOf(el)) {
      if (badge.dataset.urn !== urn) disposeBadge(badge);
    }
  }

  function removeBadge(el, urn, kind) {
    for (const badge of badgesOf(el)) {
      if (badge.dataset.urn === urn && (!kind || badge.dataset.kind === kind)) disposeBadge(badge);
    }
  }

  /**
   * Badges are transient: fade in, hold BADGE_VISIBLE_MS, fade out, remove.
   * Tab-scroll re-visits don't re-trigger (analysis is keyed per node+urn);
   * a re-rendered card or a new sighting does.
   * `window.__larpBadgeVisibleMs` overrides the hold time (test harnesses).
   */
  const BADGE_VISIBLE_MS = 3000;
  const BADGE_FADE_MS = 600;

  function scheduleBadgeFade(badge) {
    const override = Number(window.__larpBadgeVisibleMs);
    const visibleMs = override > 0 ? override : BADGE_VISIBLE_MS;
    badge._larpTimer = setTimeout(() => {
      badge.classList.add('larp-badge--leaving');
      badge._larpTimer = setTimeout(() => disposeBadge(badge), BADGE_FADE_MS);
    }, visibleMs);
  }

  /**
   * Place the badge under the post text (like a status chip), left-aligned.
   * LinkedIn's wrappers are flex containers in unpredictable places, so in-flow
   * insertion lands in odd spots depending on the card template. Rect math is
   * deterministic across templates; the pill is transient, so a stale offset
   * after a late reflow is not a concern.
   */
  function insertBadge(el, badge) {
    const textSelector = SELECTORS.text.join(', ');
    const textEl = el.querySelector(textSelector);

    if (textEl && el.contains(textEl)) {
      const cardRect = el.getBoundingClientRect();
      const textRect = textEl.getBoundingClientRect();
      el.classList.add('larp-post-anchor');
      badge.classList.add('larp-badge--anchored');
      badge.dataset.anchor = 'rect';
      badge.style.top = `${Math.round(textRect.bottom - cardRect.top + 8)}px`;
      badge.style.left = `${Math.round(textRect.left - cardRect.left)}px`;
      el.appendChild(badge);
      return;
    }

    el.classList.add('larp-post-anchor');
    badge.classList.add('larp-badge--floating');
    badge.dataset.anchor = 'corner';
    el.appendChild(badge);
  }

  function showAnalyzing(el, urn) {
    removeBadge(el, urn, 'analyzing');
    if (badgesOf(el).length > 0) return; // a verdict badge already sits there
    const badge = document.createElement('div');
    badge.className = 'larp-badge larp-badge--analyzing';
    badge.dataset.urn = urn;
    badge.dataset.kind = 'analyzing';
    badge.textContent = 'checking for larp…';
    insertBadge(el, badge);
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

    if (opts.store) {
      verdictByUrn.set(urn, { verdict, show });
      if (opts.textKey && verdict) verdictByText.set(opts.textKey, { verdict, show });
    }

    const badge = document.createElement('div');
    badge.className = 'larp-badge';
    badge.dataset.urn = urn;
    badge.dataset.kind = 'verdict';
    badge.dataset.label = verdict.label || 'LARP';
    badge.dataset.pct = String(verdict.pct ?? '');

    const dot = document.createElement('span');
    dot.className = `larp-badge__dot larp-badge__dot--${
      verdict.kind === 'genuine' ? 'green' : verdict.kind === 'sponsored' ? 'gold' : 'red'
    }`;

    const label = document.createElement('span');
    label.className = 'larp-badge__label';
    label.textContent = verdict.label || 'LARP';

    badge.append(dot, label);

    if (typeof verdict.pct === 'number') {
      const sep = document.createElement('span');
      sep.className = 'larp-badge__sep';
      sep.textContent = '|';
      const pct = document.createElement('span');
      pct.className = 'larp-badge__pct';
      pct.textContent = `${verdict.pct}%`;
      badge.append(sep, pct);
    }

    badge.title = [`LARPING AS: ${verdict.label}`, ...(verdict.details || [])].join('\n');

    insertBadge(el, badge);
    scheduleBadgeFade(badge);
  }

  function removeAllBadges() {
    for (const badge of document.querySelectorAll('.larp-badge')) disposeBadge(badge);
    verdictByUrn.clear();
    verdictByText.clear();
    for (const el of document.querySelectorAll(POST_SELECTOR)) {
      analyzedNodeUrn.delete(el);
      delete el.dataset.larpObserved;
    }
  }

  // -------------------------------------------------------------------------
  // Cleanup / bfcache
  // -------------------------------------------------------------------------
  /** Lets a test harness (or a session teardown) stop this instance cleanly. */
  window.__larpTeardown = () => {
    clearInterval(scanTimer);
    scanTimer = null;
    intersectionObserver?.disconnect();
    mutationObserver?.disconnect();
  };

  window.addEventListener('pagehide', () => {
    clearInterval(scanTimer);
    scanTimer = null;
  });
  window.addEventListener('pageshow', () => {
    if (!scanTimer) scanTimer = setInterval(scan, SCAN_INTERVAL_MS);
    scheduleScan();
  });
})();
