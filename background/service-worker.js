/**
 * LARP Detector — background service worker.
 *
 * Holds the API key (never exposed to the page), owns the request queue,
 * the verdict cache, and all provider calls. The content script only does
 * DOM work and talks to this worker via runtime messages.
 */

import { callJev, providerApiKey } from '../lib/jev-client.js';
import { analyzeHeuristically } from '../lib/heuristics.js';
import { composeVerdict, shouldShow, sponsoredVerdict, DEFAULT_SENSITIVITY } from '../lib/verdict.js';

const STORAGE_KEYS = {
  settings: 'larp_settings',
  cache: 'larp_verdict_cache',
};

const DEFAULT_SETTINGS = {
  enabled: true,
  sensitivity: DEFAULT_SENSITIVITY,
  showGenuine: false,
  provider: 'typesafe',
  apiKey: '',
  openrouterApiKey: '',
  model: 'jev-latest',
};

const CACHE_LIMIT = 2000;
const CONCURRENCY = 3;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

let settings = { ...DEFAULT_SETTINGS };

async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  settings = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] || {}) };
  return settings;
}

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
  return settings;
}

// ---------------------------------------------------------------------------
// Verdict cache — keyed by a hash of (post text + author headline)
// ---------------------------------------------------------------------------

const cache = new Map(); // key -> { verdict, ts, model }
let cacheLoaded = false;
let persistTimer = null;

function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function cacheKey({ post_text, author_headline }) {
  return fnv1a(`${author_headline || ''}\u0000${post_text || ''}`);
}

async function ensureCacheLoaded() {
  if (cacheLoaded) return;
  const stored = await chrome.storage.local.get(STORAGE_KEYS.cache);
  const obj = stored[STORAGE_KEYS.cache] || {};
  for (const [k, v] of Object.entries(obj)) cache.set(k, v);
  cacheLoaded = true;
}

function persistCacheSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    // Prune oldest if over the limit
    if (cache.size > CACHE_LIMIT) {
      const entries = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
      for (const [k] of entries.slice(0, cache.size - CACHE_LIMIT)) cache.delete(k);
    }
    await chrome.storage.local.set({
      [STORAGE_KEYS.cache]: Object.fromEntries(cache),
    });
  }, 1500);
}

// ---------------------------------------------------------------------------
// Queue — concurrency cap + in-flight dedupe
// ---------------------------------------------------------------------------

let active = 0;
const pending = [];

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    pending.push({ fn, resolve, reject });
    pump();
  });
}

function pump() {
  while (active < CONCURRENCY && pending.length > 0) {
    const { fn, resolve, reject } = pending.shift();
    active++;
    fn()
      .then(resolve, reject)
      .finally(() => {
        active--;
        pump();
      });
  }
}

const inflight = new Map(); // cacheKey -> Promise<verdict>

// ---------------------------------------------------------------------------
// Session stats
// ---------------------------------------------------------------------------

const stats = {
  sessionCalls: 0,
  sessionFallbacks: 0,
  lastModel: null,
  lastError: null,
  startedAt: Date.now(),
};

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

async function analyzeRaw(post) {
  // Provider chosen in settings; heuristics double as mock mode and fallback.
  if (settings.provider === 'mock' || !providerApiKey(settings)) {
    const result = analyzeHeuristically(post);
    if (!result) return null;
    return { ...result, source: 'heuristic' };
  }

  try {
    const result = await callJev(
      { post_text: post.post_text, author_headline: post.author_headline },
      settings
    );
    stats.sessionCalls++;
    stats.lastModel = result.model;
    stats.lastError = null;
    return { ...result, source: 'jev' };
  } catch (err) {
    stats.sessionFallbacks++;
    stats.lastError = err.message || String(err);
    console.warn('[LARP] Jev call failed, falling back to heuristics:', err);
    const result = analyzeHeuristically(post);
    if (!result) return null;
    return { ...result, source: 'heuristic-fallback' };
  }
}

async function analyzePost(post) {
  if (post.isPromoted) {
    return { verdict: sponsoredVerdict(), show: true, cached: false };
  }
  if (!post.post_text || post.post_text.trim().length < 20) {
    return null; // nothing to judge
  }

  await ensureCacheLoaded();
  const key = cacheKey(post);

  let entry = cache.get(key);
  const wasCached = Boolean(entry);
  if (!entry) {
    if (!inflight.has(key)) {
      inflight.set(
        key,
        enqueue(() => analyzeRaw(post))
          .then((result) => {
            if (!result) return null;
            const verdict = composeVerdict(result.answers, {
              model: result.model,
              usage: result.usage,
              source: result.source,
            });
            return verdict ? { verdict, ts: Date.now(), model: result.model } : null;
          })
          .finally(() => inflight.delete(key))
      );
    }
    entry = await inflight.get(key);
    if (entry) {
      cache.set(key, entry);
      persistCacheSoon();
    }
  }

  if (!entry?.verdict) return null;
  return { verdict: entry.verdict, show: shouldShow(entry.verdict, settings), cached: wasCached };
}

/** Small sample used by the "Test connection" button in options. */
const TEST_POST = {
  post_text:
    "I'm thrilled to announce I woke up at 4am to buy a lukewarm coffee, and that coffee taught me more about leadership than my MBA. Here's what it taught me about disruption. Agree?",
  author_headline: 'Visionary Founder | Disruptor | Keynote Speaker | Top Voice',
};

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'ANALYZE_POST': {
        try {
          await loadSettings(); // SW may have restarted; settings live in storage
          const result = await analyzePost(msg.post);
          sendResponse({ ok: true, ...(result || { verdict: null, show: false }) });
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
        break;
      }

      case 'GET_SETTINGS': {
        await loadSettings();
        sendResponse({ ok: true, settings });
        break;
      }

      case 'SET_SETTINGS': {
        const next = await saveSettings(msg.patch || {});
        sendResponse({ ok: true, settings: next });
        break;
      }

      case 'GET_STATS': {
        await ensureCacheLoaded();
        sendResponse({
          ok: true,
          stats: {
            ...stats,
            cacheSize: cache.size,
            settings: {
              ...settings,
              apiKey: settings.apiKey ? '(set)' : '',
              openrouterApiKey: settings.openrouterApiKey ? '(set)' : '',
            },
          },
        });
        break;
      }

      case 'CLEAR_CACHE': {
        cache.clear();
        await chrome.storage.local.remove(STORAGE_KEYS.cache);
        sendResponse({ ok: true });
        break;
      }

      case 'TEST_PROVIDER': {
        const started = performance.now();
        try {
          await loadSettings();
          const post = msg.post || TEST_POST;
          const result = await analyzeRaw(post);
          const verdict = result
            ? composeVerdict(result.answers, {
                model: result.model,
                usage: result.usage,
                source: result.source,
              })
            : null;
          sendResponse({
            ok: true,
            latencyMs: Math.round(performance.now() - started),
            model: result?.model ?? null,
            source: result?.source ?? null,
            verdict,
          });
        } catch (err) {
          sendResponse({ ok: false, error: err.message || String(err) });
        }
        break;
      }

      default:
        sendResponse({ ok: false, error: `Unknown message type: ${msg?.type}` });
    }
  })();
  return true; // async sendResponse
});

// ---------------------------------------------------------------------------

loadSettings();
ensureCacheLoaded();
