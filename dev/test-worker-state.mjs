/**
 * Regression tests for the service worker's state handling, each against a
 * freshly "woken" worker (new module instance, mocked chrome + fetch):
 *
 *   node dev/test-worker-state.mjs
 *
 *  - a cold-start SET_SETTINGS must not overwrite stored settings or API keys
 *  - provider failures are never cached; a recovered provider is consulted again
 *  - the cache is keyed per engine (mock/no-key vs provider+model)
 *  - old-format and fallback cache entries are dropped on load
 *  - API keys live in their own storage key and never reach content scripts
 */

const EXT_URL = 'chrome-extension://test/';
const EXTENSION_PAGE = { url: `${EXT_URL}ui/popup.html` };
const CONTENT_SCRIPT = { url: 'https://www.linkedin.com/feed/', tab: { id: 7 } };

const nouls = (overrides = {}) => ({
  work_shown: 0.9,
  image_crafted: 0.05,
  stat_farming: 0.05,
  grandiose_claims: 0.05,
  technical_specifics: 0.9,
  headline_larp: 0.05,
  headline_supported: 0.9,
  is_ai_written: 0.05,
  verifiable_story: 0.9,
  borrowed_content: 0.05,
  virtue_performance: 0.02,
  news_report: 0.05,
  is_narrative: 0.2,
  plain_update: 0.05,
  sensitive_context: 0.02,
  is_satire: 0.02,
  manufactured_villain: 0.02,
  humblebrag: 0.02,
  basking: 0.02,
  ...overrides,
});

const jevResponse = () => ({
  model: 'jev-1.13.0',
  answers: {
    ...Object.fromEntries(Object.entries(nouls()).map(([k, v]) => [k, { type: 'noul', noul: v }])),
    larp_intensity: { type: 'score', score: 0, probabilities: { 0: 0.9 }, confidence: 0.9 },
  },
  usage: {},
});

const POST = {
  urn: 'x',
  post_text:
    'We shaved 400ms off p99 checkout latency. Root cause: a sequential scan on a 40M row postgres table, fixed with a compound index.',
  author_headline: 'Staff Engineer',
};

console.warn = () => {}; // the worker warns about the failures we inject on purpose

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, condition, extra = '') {
  if (!condition) failures++;
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${extra ? `  — ${extra}` : ''}`);
}

let runId = 0;

/** Install fresh chrome/fetch mocks, import a new worker instance, return helpers. */
async function wake({ stored = {}, latencyMs = 0, providerOk = true } = {}) {
  const store = new Map(Object.entries(structuredClone(stored)));
  const env = { providerOk, fetchCalls: 0, tabMessages: [], handler: null };

  globalThis.fetch = async () => {
    env.fetchCalls++;
    return env.providerOk
      ? new Response(JSON.stringify(jevResponse()), { status: 200 })
      : new Response('unauthorized', { status: 401 });
  };

  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          await delay(latencyMs);
          const list = typeof keys === 'string' ? [keys] : keys;
          return Object.fromEntries(list.filter((k) => store.has(k)).map((k) => [k, structuredClone(store.get(k))]));
        },
        set: async (obj) => {
          await delay(latencyMs);
          for (const [k, v] of Object.entries(obj)) store.set(k, structuredClone(v));
        },
        remove: async (k) => {
          for (const key of [].concat(k)) store.delete(key);
        },
        setAccessLevel: async () => {},
      },
    },
    tabs: {
      query: async () => [{ id: 7 }],
      sendMessage: async (id, message) => {
        env.tabMessages.push({ id, message });
      },
    },
    runtime: {
      getURL: (path) => `${EXT_URL}${path}`,
      onMessage: { addListener: (fn) => (env.handler = fn) },
    },
  };

  await import(`../background/service-worker.js?wake=${++runId}`);
  env.store = store;
  env.call = (message, sender = EXTENSION_PAGE) =>
    new Promise((resolve) => env.handler(message, sender, resolve));
  return env;
}

const LIVE_SETTINGS = {
  enabled: true,
  sensitivity: 3,
  showGenuine: true,
  provider: 'typesafe',
  model: 'jev-latest',
};
const KEYS = { apiKey: 'ts_REAL_KEY', openrouterApiKey: 'sk-or-REAL_KEY' };

/** Storage as written by the current build, and by earlier builds (keys inside larp_settings). */
const LAYOUTS = {
  current: (settings) => ({ larp_settings: settings, larp_secrets: KEYS }),
  legacy: (settings) => ({ larp_settings: { ...settings, ...KEYS } }),
};

for (const [layout, seed] of Object.entries(LAYOUTS)) {
  // 1. Cold start ------------------------------------------------------------
  {
    const w = await wake({ latencyMs: 25, stored: seed(LIVE_SETTINGS) });
    const res = await w.call({ type: 'SET_SETTINGS', patch: { sensitivity: 2 } }); // first message, load still in flight
    await delay(250);
    const saved = w.store.get('larp_settings');
    const keys = { ...w.store.get('larp_secrets'), ...saved }; // wherever this build keeps them
    check(`[${layout}] cold SET_SETTINGS keeps the patch`, saved.sensitivity === 2 && res.settings.sensitivity === 2);
    check(`[${layout}] cold SET_SETTINGS keeps other stored settings`, saved.showGenuine === true && saved.provider === 'typesafe');
    check(`[${layout}] cold SET_SETTINGS keeps the API keys`, keys.apiKey === KEYS.apiKey && keys.openrouterApiKey === KEYS.openrouterApiKey);
  }

  // 2. Provider failures are not cached --------------------------------------
  {
    const w = await wake({ stored: seed({ ...LIVE_SETTINGS, sensitivity: 0 }), providerOk: false });
    const first = await w.call({ type: 'ANALYZE_POST', post: POST }, CONTENT_SCRIPT);
    check(`[${layout}] provider failure still yields a (fallback) verdict`, first.ok && first.verdict?.source === 'heuristic-fallback');
    w.providerOk = true;
    const second = await w.call({ type: 'ANALYZE_POST', post: POST }, CONTENT_SCRIPT);
    check(`[${layout}] fallback verdict was not cached`, second.cached === false);
    check(`[${layout}] recovered provider is consulted again`, second.verdict?.source === 'jev', second.verdict?.source);
    const third = await w.call({ type: 'ANALYZE_POST', post: POST }, CONTENT_SCRIPT);
    check(`[${layout}] real Jev verdicts are cached`, third.cached === true && w.fetchCalls === 2, `fetchCalls=${w.fetchCalls}`);
  }
}

// 3. Cache is per engine ----------------------------------------------------
{
  const w = await wake({ stored: { larp_settings: { ...LIVE_SETTINGS, sensitivity: 0 }, larp_secrets: { apiKey: '', openrouterApiKey: '' } } });
  const noKey = await w.call({ type: 'ANALYZE_POST', post: POST }, CONTENT_SCRIPT);
  check('no key → heuristic verdict', noKey.verdict?.source === 'heuristic');
  const again = await w.call({ type: 'ANALYZE_POST', post: POST }, CONTENT_SCRIPT);
  check('heuristic verdicts are cached for that engine', again.cached === true);

  await w.call({ type: 'SET_SETTINGS', patch: { apiKey: KEYS.apiKey } });
  const withKey = await w.call({ type: 'ANALYZE_POST', post: POST }, CONTENT_SCRIPT);
  check('adding a key does not reuse the keyless verdict', withKey.cached === false && withKey.verdict?.source === 'jev');

  await w.call({ type: 'SET_SETTINGS', patch: { model: 'jev-1.13.0' } });
  const pinned = await w.call({ type: 'ANALYZE_POST', post: POST }, CONTENT_SCRIPT);
  check('pinning a model does not reuse the jev-latest verdict', pinned.cached === false);
}

// 4. Stale cache entries are dropped on load ---------------------------------
{
  const fresh = { verdict: { kind: 'larp', label: 'LARP', score: 3, pct: 80, source: 'jev', details: [] }, ts: 1, model: 'm' };
  const w = await wake({
    stored: {
      larp_settings: LIVE_SETTINGS,
      larp_verdict_cache: {
        'tax-5-abc123': { ...fresh, verdict: { ...fresh.verdict, source: 'heuristic-fallback' } }, // old key format
        'tax-5:typesafe:jev-latest:good': fresh,
        'tax-5:typesafe:jev-latest:bad': { ...fresh, verdict: { ...fresh.verdict, source: 'heuristic-fallback' } },
        'tax-2:typesafe:jev-latest:old': fresh, // older question set
      },
    },
  });
  const stats = await w.call({ type: 'GET_STATS' });
  check('cache load keeps only current-format, non-fallback entries', stats.stats.cacheSize === 1, `cacheSize=${stats.stats.cacheSize}`);
}

// 5. Keys stay out of content scripts ----------------------------------------
{
  // Legacy layout: keys inside larp_settings
  const w = await wake({ stored: { larp_settings: { ...LIVE_SETTINGS, ...KEYS } } });
  const got = await w.call({ type: 'GET_SETTINGS' }, CONTENT_SCRIPT);
  const blob = JSON.stringify(got);
  check('GET_SETTINGS for a content script has no key material', !blob.includes('REAL_KEY'));
  check('...but reports that keys are set', got.settings.hasApiKey === true && got.settings.hasOpenrouterApiKey === true);
  check('legacy keys migrated out of larp_settings', !('apiKey' in w.store.get('larp_settings')) && w.store.get('larp_secrets')?.apiKey === KEYS.apiKey);

  const secretsFromCs = await w.call({ type: 'GET_SECRETS' }, CONTENT_SCRIPT);
  check('GET_SECRETS refused for a content script', secretsFromCs.ok === false && !JSON.stringify(secretsFromCs).includes('REAL_KEY'));
  const setFromCs = await w.call({ type: 'SET_SETTINGS', patch: { apiKey: 'attacker' } }, CONTENT_SCRIPT);
  check('SET_SETTINGS refused for a content script', setFromCs.ok === false && w.store.get('larp_secrets').apiKey === KEYS.apiKey);
  const secretsFromOptions = await w.call({ type: 'GET_SECRETS' });
  check('GET_SECRETS works for extension pages', secretsFromOptions.ok && secretsFromOptions.secrets.apiKey === KEYS.apiKey);

  const stats = await w.call({ type: 'GET_STATS' });
  check('GET_STATS has no key material', !JSON.stringify(stats).includes('REAL_KEY'));

  w.tabMessages.length = 0;
  await w.call({ type: 'SET_SETTINGS', patch: { sensitivity: 1 } });
  const pushed = w.tabMessages.find((m) => m.message.type === 'SETTINGS_CHANGED');
  check('settings changes are pushed to tabs', pushed?.message.settings.sensitivity === 1);
  check('...without key material', !JSON.stringify(w.tabMessages).includes('REAL_KEY'));
}

console.log(failures === 0 ? '\nAll worker-state tests passed.' : `\n${failures} worker-state test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
