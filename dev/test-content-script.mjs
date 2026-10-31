/**
 * Regression tests for the content script's DOM handling, against a minimal
 * mocked DOM and chrome.runtime:
 *
 *   node dev/test-content-script.mjs
 *
 *  - only the outermost card of a reshare is analyzed
 *  - CACHE_CLEARED forgets page verdicts without re-analyzing or re-slamming
 *  - SETTINGS_CHANGED rescans visible posts; off-screen posts re-evaluate on scroll
 *  - under prefers-reduced-motion the LARP stamp starts settled
 *  - the pill clears LinkedIn controls on its row, measured per card
 *  - pills dropped by a LinkedIn re-render come back; textless cards are retried
 */

const EXT_URL = 'chrome-extension://test/';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, condition, extra = '') {
  if (!condition) failures++;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${extra ? `  — ${extra}` : ''}`);
}

function makeEl(tag = 'div', attrs = {}) {
  const children = [];
  const classes = new Set();
  const listeners = {};
  const el = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    dataset: {},
    style: {
      _props: {},
      setProperty(k, v) {
        this._props[k] = v;
      },
      getPropertyValue(k) {
        return this._props[k] ?? '';
      },
    },
    parentElement: null,
    innerText: '',
    textContent: '',
    tabIndex: -1,
    offsetWidth: 200,
    offsetHeight: 80,
    _top: 100,
    _bottom: 300,
    get className() {
      return [...classes].join(' ');
    },
    set className(v) {
      classes.clear();
      for (const c of String(v).split(/\s+/).filter(Boolean)) classes.add(c);
    },
    classList: {
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      contains: (c) => classes.has(c),
    },
    getAttribute: (k) => attrs[k] ?? null,
    setAttribute: (k, v) => {
      attrs[k] = String(v);
    },
    addEventListener: (ev, fn) => {
      (listeners[ev] ??= []).push(fn);
    },
    getBoundingClientRect: () => ({ top: el._top, bottom: el._bottom, right: 400 }),
    appendChild: (child) => {
      child.parentElement = el;
      children.push(child);
      return child;
    },
    append: (...nodes) => nodes.forEach((n) => el.appendChild(n)),
    remove: () => {
      if (!el.parentElement) return;
      const idx = el.parentElement._children.indexOf(el);
      if (idx !== -1) el.parentElement._children.splice(idx, 1);
      el.parentElement = null;
    },
    matches: (sel) => {
      if (sel.includes('update-card-focus')) {
        return String(attrs.componentkey || '').startsWith('update-card-focus');
      }
      return false;
    },
    contains: (other) => {
    for (let cur = other; cur; cur = cur.parentElement) if (cur === el) return true;
    return false;
  },
  closest: (sel) => {
      let cur = el;
      while (cur) {
        if (cur.matches?.(sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    querySelector: (sel) => el.querySelectorAll(sel)[0] ?? null,
    querySelectorAll: (sel) => {
      const out = [];
      const visit = (node) => {
        for (const ch of node._children) {
          if (
            (sel === '.larp-badge' && ch.classList.contains('larp-badge')) ||
            (sel.includes('update-card-focus') && ch.matches(sel)) ||
            (sel === '[data-testid="expandable-text-box"]' && ch.getAttribute('data-testid') === 'expandable-text-box') ||
            (sel.startsWith('button,') && ch.tagName === 'BUTTON')
          ) {
            out.push(ch);
          }
          visit(ch);
        }
      };
      visit(el);
      return out;
    },
    _children: children,
  };
  return el;
}

function makePostCard(urn, text, { top = 100, bottom = 300 } = {}) {
  const card = makeEl('div', { componentkey: urn });
  card._top = top;
  card._bottom = bottom;
  card.innerText = `Feed post\nJane Doe\n• 2nd\nFounder | Visionary\n2d\nFollow\n${text}`;
  const box = makeEl('div', { 'data-testid': 'expandable-text-box' });
  box.innerText = text;
  card.appendChild(box);
  return card;
}

// <main> wraps the feed root, as on the live site: both match SELECTORS.feedRoots.
const main = makeEl('main');
const root = makeEl('div');
main.appendChild(root);
const FEED_ROOTS = { '[data-testid="mainFeed"]': [root], main: [main] };
const outerReshare = makePostCard('update-card-focus-outer', 'Outer reshare commentary that is definitely over twenty chars.');
const innerReshare = makePostCard('update-card-focus-inner', 'Inner reshared post text that is also over twenty characters long.');
outerReshare.appendChild(innerReshare);

const offscreenPost = makePostCard('update-card-focus-offscreen', 'Offscreen post text that is definitely over twenty characters long.', {
  top: 2000,
  bottom: 2200,
});

root.append(outerReshare, offscreenPost);

let runtimeListener = null;
let ioCallback = null;
let reducedMotion = true;
const analyzedUrns = [];
let currentShow = true;

globalThis.Node = { ELEMENT_NODE: 1 };
const windowListeners = {};
globalThis.window = {
  innerHeight: 800,
  innerWidth: 1200,
  addEventListener: (ev, fn) => (windowListeners[ev] = fn),
  matchMedia: () => ({ matches: reducedMotion }),
};
globalThis.document = {
  body: main,
  createElement: (tag) => makeEl(tag),
  querySelectorAll: (sel) => FEED_ROOTS[sel] ?? main.querySelectorAll(sel),
};
globalThis.history = { pushState: () => {}, replaceState: () => {} };
globalThis.requestIdleCallback = (fn) => fn();
globalThis.IntersectionObserver = class {
  constructor(cb) {
    ioCallback = cb;
  }
  observe() {}
  disconnect() {}
};
let mutationCallback = null;
globalThis.MutationObserver = class {
  constructor(cb) {
    mutationCallback = cb;
  }
  observe() {}
  disconnect() {}
};
// Track the content script's periodic scan.
const activeIntervals = new Set();
let intervalFn = null;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (fn, ms) => {
  const id = realSetInterval(fn, ms);
  activeIntervals.add(id);
  intervalFn = fn;
  return id;
};
globalThis.clearInterval = (id) => {
  activeIntervals.delete(id);
  realClearInterval(id);
};

globalThis.chrome = {
  runtime: {
    id: 'test-ext',
    lastError: null,
    getURL: (p) => `${EXT_URL}${p}`,
    onMessage: {
      addListener: (fn) => (runtimeListener = fn),
      removeListener: () => {},
    },
    sendMessage: (msg, cb) => {
      if (msg.type === 'GET_SETTINGS') {
        cb({ ok: true, settings: { enabled: true, showGenuine: false, sensitivity: 1.5 } });
      } else if (msg.type === 'ANALYZE_POST') {
        analyzedUrns.push(msg.post.urn);
        cb({
          ok: true,
          verdict: { kind: 'larp', label: 'LARP', pct: 80, score: 3.2, details: [] },
          show: currentShow,
        });
      }
    },
  },
};

await import('../content/content.js');
await delay(20);

check('reshare: only outer post is analyzed on initial scan', analyzedUrns.length === 1 && analyzedUrns[0] === 'update-card-focus-outer', analyzedUrns.join(','));
const stamps = outerReshare.querySelectorAll('.larp-badge').filter((b) => b.classList.contains('larp-stamp'));
check('reduced-motion stamp starts settled immediately', stamps.length === 1 && stamps[0].classList.contains('is-settled'));
check('periodic scan runs while the page has posts', activeIntervals.size === 1);

// Nested feed roots (<main> around the feed) must not visit each post twice per scan
const visibleBefore = window.__larpDebug.visible;
intervalFn();
check('a scan visits each visible post once despite nested feed roots', window.__larpDebug.visible - visibleBefore === 1, `visits=${window.__larpDebug.visible - visibleBefore}`);

const initialStamp = stamps[0];
analyzedUrns.length = 0;

// CACHE_CLEARED: must NOT re-analyze visible posts or replace their settled stamp
runtimeListener({ type: 'CACHE_CLEARED' });
check('CACHE_CLEARED triggers zero immediate ANALYZE_POST calls', analyzedUrns.length === 0);
const stampAfterClear = outerReshare.querySelectorAll('.larp-badge').find((b) => b.classList.contains('larp-stamp'));
check('CACHE_CLEARED keeps existing stamp on screen without re-slamming', stampAfterClear === initialStamp);

// A re-rendered card with the same text (new componentkey) must re-query after CACHE_CLEARED
const rerendered = makePostCard('update-card-focus-outer-v2', 'Outer reshare commentary that is definitely over twenty chars.');
root.appendChild(rerendered);
ioCallback([{ isIntersecting: true, target: rerendered }]);
check('CACHE_CLEARED emptied page text cache so re-rendered card re-analyzes', analyzedUrns.includes('update-card-focus-outer-v2'));
rerendered.remove();

// SETTINGS_CHANGED: inner reshare still skipped, unchanged visible LARP post keeps its settled stamp
analyzedUrns.length = 0;
runtimeListener({ type: 'SETTINGS_CHANGED', settings: { enabled: true, showGenuine: false, sensitivity: 2.0 } });
check('SETTINGS_CHANGED rescans outer post but never inner reshare', analyzedUrns.length === 1 && analyzedUrns[0] === 'update-card-focus-outer');
const stampAfterSettings = outerReshare.querySelectorAll('.larp-badge').find((b) => b.classList.contains('larp-stamp'));
check('SETTINGS_CHANGED preserves settled stamp when verdict stays shown', stampAfterSettings === initialStamp);

// Off-screen post: when scrolled into view after SETTINGS_CHANGED, it evaluates under current settings
currentShow = false;
offscreenPost._top = 100;
offscreenPost._bottom = 300;
ioCallback([{ isIntersecting: true, target: offscreenPost }]);
check('off-screen post is analyzed when scrolled into view', analyzedUrns.includes('update-card-focus-offscreen'));
check('off-screen post respects updated show=false setting', offscreenPost.querySelectorAll('.larp-badge').length === 0);

// Pill placement: clear LinkedIn controls that share the pill's row ----------
currentShow = true;
const pillOf = (card) => card.querySelectorAll('.larp-badge').find((b) => b.dataset.kind === 'verdict' && !b.classList.contains('larp-stamp'));
const rect = (left, top, width, height) => () => ({ left, top, width, height, right: left + width, bottom: top + height });
{
  const card = makePostCard('update-card-focus-follow-row', 'A post whose Follow button shares the top row with the menu.');
  card.getBoundingClientRect = rect(0, 100, 400, 200);
  const follow = makeEl('button');
  follow.getBoundingClientRect = rect(230, 104, 90, 28); // "+ Follow" left of "…" on the top row
  const secondRow = makeEl('button');
  secondRow.getBoundingClientRect = rect(150, 140, 90, 28); // below the pill's row: ignored
  const hidden = makeEl('button');
  hidden.getBoundingClientRect = rect(0, 0, 0, 0);
  card.append(follow, secondRow, hidden);
  root.appendChild(card);
  ioCallback([{ isIntersecting: true, target: card }]);
  const pill = pillOf(card);
  check('pill clears a Follow button on its row', pill?.style.getPropertyValue('--larp-pill-right') === '178px', pill?.style.getPropertyValue('--larp-pill-right'));
  const stamp = card.querySelectorAll('.larp-badge').find((b) => b.classList.contains('larp-stamp'));
  check('stamp follows the pill offset', stamp?.style.getPropertyValue('--larp-pill-right') === '178px');

  follow.getBoundingClientRect = rect(300, 140, 90, 28); // Follow moved to a second row
  intervalFn();
  check('pill re-measures on rescan and falls back to 96px', pill.style.getPropertyValue('--larp-pill-right') === '96px', pill.style.getPropertyValue('--larp-pill-right'));

  // LinkedIn re-renders the card contents in place and drops our pill
  analyzedUrns.length = 0;
  for (const b of card.querySelectorAll('.larp-badge')) b.remove();
  intervalFn();
  check('a pill dropped by a re-render is restored on rescan', Boolean(pillOf(card)));
  check('...without another ANALYZE_POST call', analyzedUrns.length === 0, analyzedUrns.join(','));
  card.remove();
}

// Card seen before its text rendered: retried, not skipped forever ----------
{
  const card = makePostCard('update-card-focus-lazy', '');
  root.appendChild(card);
  analyzedUrns.length = 0;
  ioCallback([{ isIntersecting: true, target: card }]);
  check('textless card is not analyzed yet', !analyzedUrns.includes('update-card-focus-lazy'));
  card.querySelector('[data-testid="expandable-text-box"]').innerText = 'The text arrived a moment after the card shell rendered.';
  intervalFn();
  check('card is analyzed once its text renders', analyzedUrns.includes('update-card-focus-lazy'));
  card.remove();

  const imageOnly = makePostCard('update-card-focus-image-only', '');
  root.appendChild(imageOnly);
  for (let i = 0; i < 8; i++) intervalFn();
  const skippedBefore = window.__larpDebug.skipped;
  intervalFn();
  check('a card that never gets text stops being retried', window.__larpDebug.skipped === skippedBefore);
  imageOnly.remove();
}

// Page without posts (messaging, settings…): the periodic scan stops
outerReshare.remove();
offscreenPost.remove();
intervalFn();
check('periodic scan stops on a page with no posts', activeIntervals.size === 0);

// Posts appear again (SPA navigation back to the feed): the mutation observer restarts it
root.appendChild(outerReshare);
mutationCallback([{ addedNodes: [outerReshare] }]);
await delay(300);
check('periodic scan restarts when posts appear', activeIntervals.size === 1);

globalThis.window.__larpTeardown?.();
check('teardown stops the periodic scan', activeIntervals.size === 0);
windowListeners.pageshow?.();
check('pageshow after teardown does not restart the scan', activeIntervals.size === 0);

console.log(failures === 0 ? '\nAll content-script tests passed.' : `\n${failures} content-script test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
