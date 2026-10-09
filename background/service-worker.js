/**
 * LARP Detector — background service worker.
 *
 * Holds the API key (never exposed to the page), owns the request queue,
 * the verdict cache, and all provider calls. The content script only does
 * DOM work and talks to this worker via runtime messages.
 */

import { callJev, providerApiKey, resolveModel } from '../lib/jev-client.js';
import { analyzeHeuristically } from '../lib/heuristics.js';
import { composeVerdict, shouldShow, sponsoredVerdict, DEFAULT_SENSITIVITY, COMPOSER_VERSION } from '../lib/verdict.js';

const STORAGE_KEYS = {
  settings: 'larp_settings', // everything except the API keys
  secrets: 'larp_secrets', // API keys only — never sent to content scripts
  cache: 'larp_verdict_cache',
};
const SECRET_FIELDS = ['apiKey', 'openrouterApiKey'];

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

/** Bump when the question set changes; invalidates the verdict cache. */
const TAX_VERSION = 'tax-5';
/** Cache key prefix: question set + composition rules (COMPOSER_VERSION). */
const CACHE_VERSION = `${TAX_VERSION}.c${COMPOSER_VERSION}`;

/** Verdicts produced because a provider call failed — shown, but never cached. */
const FALLBACK_SOURCE = 'heuristic-fallback';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * The in-memory copy is authoritative once loaded. Every message handler waits
 * on ensureSettingsLoaded() first: a freshly woken worker would otherwise merge
 * a patch into DEFAULT_SETTINGS and write that over the stored settings (API
 * keys included).
 */
let settings = { ...DEFAULT_SETTINGS };
let settingsReady = null;

function ensureSettingsLoaded() {
  settingsReady ??= loadSettings().catch((err) => {
    settingsReady = null;
    throw err;
  });
  return settingsReady;
}

async function loadSettings() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.secrets]);
  const saved = stored[STORAGE_KEYS.settings] || {};
  settings = { ...DEFAULT_SETTINGS, ...saved, ...(stored[STORAGE_KEYS.secrets] || {}) };
  // Earlier builds kept the keys inside larp_settings — move them out.
  if (SECRET_FIELDS.some((field) => field in saved)) await persistSettings();
}

function persistSettings() {
  const { apiKey, openrouterApiKey, ...rest } = settings;
  return chrome.storage.local.set({
    [STORAGE_KEYS.settings]: rest,
    [STORAGE_KEYS.secrets]: { apiKey, openrouterApiKey },
  });
}

async function saveSettings(patch) {
  await ensureSettingsLoaded();
  for (const field of Object.keys(DEFAULT_SETTINGS)) {
    if (field in patch) settings = { ...settings, [field]: patch[field] };
  }
  await persistSettings();
  broadcastSettings();
}

/** Settings as content scripts and the popup see them: key presence, never the keys. */
function publicSettings() {
  const { apiKey, openrouterApiKey, ...rest } = settings;
  return { ...rest, hasApiKey: Boolean(apiKey), hasOpenrouterApiKey: Boolean(openrouterApiKey) };
}

/**
 * Content scripts can't read chrome.storage (see restrictStorageAccess), so
 * the worker pushes changes to open tabs. Tabs without our content script
 * reject the message; that's expected.
 */
async function broadcastSettings() {
  const message = { type: 'SETTINGS_CHANGED', settings: publicSettings() };
  try {
    for (const tab of await chrome.tabs.query({})) {
      if (tab.id != null) chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  } catch (err) {
    console.warn('[LARP] could not broadcast settings:', err);
  }
}

/** Keep content scripts, which run next to LinkedIn's page, out of storage.local entirely. */
function restrictStorageAccess() {
  try {
    chrome.storage.local
      .setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })
      ?.catch((err) => console.warn('[LARP] setAccessLevel failed:', err));
  } catch (err) {
    console.warn('[LARP] setAccessLevel failed:', err);
  }
}

/** Content scripts may ask for verdicts and public settings — nothing else. */
const CONTENT_SCRIPT_MESSAGES = new Set(['ANALYZE_POST', 'GET_SETTINGS']);

// The sender URL is what tells an extension page from a content script: a
// content script reports the page it runs in (linkedin.com), an extension page
// its own chrome-extension:// or moz-extension:// URL. `sender.tab` cannot be
// used — the options page opens in a tab (options_ui.open_in_tab).
function isExtensionPage(sender) {
  return (
    sender?.id === chrome.runtime.id &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(chrome.runtime.getURL(''))
  );
}

// ---------------------------------------------------------------------------
// Verdict cache — keyed by a hash of (post text + author headline)
// ---------------------------------------------------------------------------

const cache = new Map(); // key -> { verdict, ts, model }
let cacheLoaded = false;
let persistTimer = null;
/** Bumped by CLEAR_CACHE so requests already in flight don't write back. */
let cacheGeneration = 0;

function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Who produced a verdict. Switching provider, model, or going from mock/no-key
 * to a real key must not serve verdicts from the other engine.
 */
function engineTag(s) {
  if (s.provider === 'mock' || !providerApiKey(s)) return 'heuristic';
  const provider = s.provider || 'typesafe';
  return `${provider}:${resolveModel(provider, s.model)}`;
}

function cacheKey({ post_text, author_headline, media }, s) {
  // CACHE_VERSION rejects verdicts cached under older questions or rules — the
  // composer requires the new nouls and old answers fail the missing-noul
  // check, which would silently disable badges for every cached post.
  return `${CACHE_VERSION}:${engineTag(s)}:${fnv1a(`${author_headline || ''}\u0000${post_text || ''}\u0000${media || ''}`)}`;
}

async function ensureCacheLoaded() {
  if (cacheLoaded) return;
  const stored = await chrome.storage.local.get(STORAGE_KEYS.cache);
  const obj = stored[STORAGE_KEYS.cache] || {};
  let dropped = 0;
  for (const [k, v] of Object.entries(obj)) {
    // Entries from an older key format or question set can never be hit again.
    if (k.startsWith(`${CACHE_VERSION}:`) && v?.verdict?.source !== FALLBACK_SOURCE) cache.set(k, v);
    else dropped++;
  }
  cacheLoaded = true;
  if (dropped) persistCacheSoon();
}

function pruneCache() {
  if (cache.size <= CACHE_LIMIT) return;
  const entries = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
  for (const [k] of entries.slice(0, cache.size - CACHE_LIMIT)) cache.delete(k);
}

function persistCacheSoon() {
  // Prune now, not in the timer: MV3 can kill the worker before it fires.
  pruneCache();
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
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

/** `s` is a settings snapshot, so a call queued under one engine can't run under another. */
async function analyzeRaw(post, s) {
  // Provider chosen in settings; heuristics double as mock mode and fallback.
  if (s.provider === 'mock' || !providerApiKey(s)) {
    const result = analyzeHeuristically(post);
    if (!result) return null;
    return { ...result, source: 'heuristic' };
  }

  try {
    const result = await callJev(
      { post_text: post.post_text, author_headline: post.author_headline, media: String(post.media || '').slice(0, 400) },
      s
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
    return { ...result, source: FALLBACK_SOURCE };
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
  const snapshot = settings;
  const key = cacheKey(post, snapshot);

  const generation = cacheGeneration;
  let entry = cache.get(key);
  const wasCached = Boolean(entry);
  if (!entry) {
    if (!inflight.has(key)) {
      inflight.set(
        key,
        enqueue(() => analyzeRaw(post, snapshot))
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
    // A fallback verdict means the provider hiccuped; caching it would pin the
    // noisy heuristic answer to this post long after the provider recovers.
    if (entry && entry.verdict.source !== FALLBACK_SOURCE && generation === cacheGeneration) {
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!isExtensionPage(sender) && !CONTENT_SCRIPT_MESSAGES.has(msg?.type)) {
        sendResponse({ ok: false, error: `${msg?.type} is not available from this context` });
        return;
      }
      await ensureSettingsLoaded(); // SW may have restarted; settings live in storage

      switch (msg?.type) {
        case 'ANALYZE_POST': {
          const result = await analyzePost(msg.post);
          sendResponse({ ok: true, ...(result || { verdict: null, show: false }) });
          break;
        }

        case 'GET_SETTINGS': {
          sendResponse({ ok: true, settings: publicSettings() });
          break;
        }

        case 'GET_SECRETS': {
          // Options page only — it needs the keys to show and edit them.
          const { apiKey, openrouterApiKey } = settings;
          sendResponse({ ok: true, secrets: { apiKey, openrouterApiKey } });
          break;
        }

        case 'SET_SETTINGS': {
          await saveSettings(msg.patch || {});
          sendResponse({ ok: true, settings: publicSettings() });
          break;
        }

        case 'GET_STATS': {
          await ensureCacheLoaded();
          sendResponse({
            ok: true,
            stats: { ...stats, cacheSize: cache.size, settings: publicSettings() },
          });
          break;
        }

        case 'CLEAR_CACHE': {
          await ensureCacheLoaded(); // else the pending load would repopulate what we just cleared
          cacheGeneration++;
          inflight.clear();
          clearTimeout(persistTimer);
          cache.clear();
          await chrome.storage.local.remove(STORAGE_KEYS.cache);
          sendResponse({ ok: true });
          break;
        }

        case 'TEST_PROVIDER': {
          const started = performance.now();
          const result = await analyzeRaw(msg.post || TEST_POST, settings);
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
          break;
        }

        default:
          sendResponse({ ok: false, error: `Unknown message type: ${msg?.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true; // async sendResponse
});

// ---------------------------------------------------------------------------

restrictStorageAccess();
ensureSettingsLoaded();
ensureCacheLoaded();
