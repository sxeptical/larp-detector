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
    style: {},
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
            (sel === '[data-testid="expandable-text-box"]' && ch.getAttribute('data-testid') === 'expandable-text-box')
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

const root = makeEl('div');
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
globalThis.window = {
  innerHeight: 800,
  innerWidth: 1200,
  addEventListener: () => {},
  matchMedia: () => ({ matches: reducedMotion }),
};
globalThis.document = {
  body: root,
  createElement: (tag) => makeEl(tag),
  querySelectorAll: (sel) => root.querySelectorAll(sel),
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
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
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

globalThis.window.__larpTeardown?.();

console.log(failures === 0 ? '\nAll content-script tests passed.' : `\n${failures} content-script test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
