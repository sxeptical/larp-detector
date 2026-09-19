/**
 * Integration smoke test: runs the real service worker under a mocked
 * `chrome` API and exercises the full message → queue → cache → verdict flow.
 *
 *   node dev/smoke.mjs
 */

let messageHandler = null;

// Mock upstream OpenRouter before the service worker imports so we can test
// the emulation provider without network access.
const openrouterCalls = [];
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('openrouter.ai')) {
    openrouterCalls.push(JSON.parse(opts.body));
    const payload = {
      id: 'gen-smoke',
      model: 'deepseek/deepseek-v4-flash',
      choices: [
        {
          message: {
            content: JSON.stringify({
              persona_performance: 0.93,
              stat_farming: 0.8,
              grandiose_claims: 0.9,
              technical_specifics: 0.05,
              headline_larp: 0.9,
              is_ai_written: 0.4,
              larp_role: 'tech_visionary',
              role_confidence: 0.88,
              larp_intensity: 3.5,
            }),
          },
        },
      ],
      usage: { prompt_tokens: 500, completion_tokens: 90 },
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  throw new Error(`unexpected fetch in smoke test: ${url}`);
};

const store = new Map();

globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => {
        const keys =
          typeof key === 'string' ? [key] : Array.isArray(key) ? key : Object.keys(key || {});
        const out = {};
        for (const k of keys) if (store.has(k)) out[k] = store.get(k);
        return out;
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) store.set(k, v);
      },
      remove: async (key) => {
        for (const k of [].concat(key)) store.delete(k);
      },
    },
    onChanged: { addListener: () => {} },
  },
  runtime: {
    onMessage: {
      addListener: (fn) => {
        messageHandler = fn;
      },
    },
  },
};

await import('../background/service-worker.js');

if (!messageHandler) throw new Error('service worker never registered a message handler');

function call(message) {
  return new Promise((resolve) => {
    messageHandler(message, {}, resolve);
  });
}

let failures = 0;
function check(name, condition, extra = '') {
  const mark = condition ? '✓' : '✗';
  if (!condition) failures++;
  console.log(`${mark} ${name}${extra ? `  — ${extra}` : ''}`);
}

const COFFEE = {
  urn: 'urn:li:activity:1',
  post_text:
    'I bought a lukewarm coffee this morning. The barista said the machine was slow. That\'s when I realized — leadership is brewing. Agree?',
  author_headline: 'Founder | Speaker',
  isPromoted: false,
};

const HEADLINE_COSTUME = {
  urn: 'urn:li:activity:2',
  post_text:
    'We scaled to 40 million users in 3 weekends with our AI platform. The engineering team is unstoppable.',
  author_headline: 'Visionary | Disruptor | Keynote Speaker',
  isPromoted: false,
};

const SHORT = { urn: 'urn:li:activity:3', post_text: 'Congrats!', author_headline: '', isPromoted: false };

const AD = { urn: 'urn:li:activity:4', post_text: 'Buy our thing. '.repeat(10), author_headline: 'Vendor', isPromoted: true };

// 1. Settings round-trip
let res = await call({ type: 'SET_SETTINGS', patch: { provider: 'mock', sensitivity: 1.5 } });
check('SET_SETTINGS', res.ok && res.settings.provider === 'mock');
res = await call({ type: 'GET_SETTINGS' });
check('GET_SETTINGS reads back persisted settings', res.ok && res.settings.provider === 'mock');

// 2. Analysis through the queue (mock provider = heuristics path)
res = await call({ type: 'ANALYZE_POST', post: COFFEE });
const coffeeLabel = res.verdict?.label;
check('ANALYZE_POST returns a verdict', res.ok && Boolean(res.verdict), res.verdict?.label);
check('coffee parable → PHILOSOPHER', res.verdict?.role === 'philosopher', `${res.verdict?.emoji} ${res.verdict?.label} ${res.verdict?.pct}%`);
check('coffee parable is shown at default sensitivity', res.show === true);

res = await call({ type: 'ANALYZE_POST', post: HEADLINE_COSTUME });
check('tech-larp + costume headline → 10X ENGINEER', res.verdict?.role === 'tech_visionary', `${res.verdict?.emoji} ${res.verdict?.label} ${res.verdict?.pct}%`);

// 3. Cache: second call is a hit, same verdict
const again = await call({ type: 'ANALYZE_POST', post: COFFEE });
check('cache hit on repeat post', again.ok && again.cached === true);
check('cached verdict is identical', again.verdict?.label === coffeeLabel);

// 4. Sensitivity filtering (cached verdict, no re-analysis)
await call({ type: 'SET_SETTINGS', patch: { sensitivity: 4 } });
const hidden = await call({ type: 'ANALYZE_POST', post: COFFEE });
check('high sensitivity hides mild larp', hidden.ok && hidden.show === false);
await call({ type: 'SET_SETTINGS', patch: { sensitivity: 1.5 } });

// 5. Edge cases
res = await call({ type: 'ANALYZE_POST', post: SHORT });
check('short post → no verdict', res.ok && res.verdict === null);
res = await call({ type: 'ANALYZE_POST', post: AD });
check('promoted post → SPONSORED, no analysis', res.ok && res.verdict?.role === 'sponsored' && res.show === true);

// 6. Stats + cache persistence
await new Promise((r) => setTimeout(r, 1800)); // let the debounced cache persist
res = await call({ type: 'GET_STATS' });
check('stats report cached verdicts', res.ok && res.stats.cacheSize >= 2, `cacheSize=${res.stats.cacheSize}`);
check('verdict cache persisted to storage', store.has('larp_verdict_cache'));

// 7. Clear cache
res = await call({ type: 'CLEAR_CACHE' });
const after = await call({ type: 'GET_STATS' });
check('CLEAR_CACHE empties the cache', res.ok && after.stats.cacheSize === 0);

// 8. Test-provider message
res = await call({ type: 'TEST_PROVIDER' });
check('TEST_PROVIDER returns a verdict preview', res.ok && Boolean(res.verdict), res.verdict?.label);

// 9. OpenRouter emulation provider (mocked fetch)
const OPENROUTER_POST = {
  urn: 'urn:li:activity:9',
  post_text:
    'We processed 2 billion events and hit 50M users in three weekends. Our AI platform is unstoppable. The vision is everything.',
  author_headline: 'Visionary | Disruptor | Keynote Speaker',
  isPromoted: false,
};

await call({ type: 'SET_SETTINGS', patch: { provider: 'openrouter', openrouterApiKey: 'sk-or-test', model: '' } });
res = await call({ type: 'ANALYZE_POST', post: OPENROUTER_POST });
check('OpenRouter provider returns a composed verdict', res.ok && res.verdict?.role === 'tech_visionary', `${res.verdict?.emoji} ${res.verdict?.label} ${res.verdict?.pct}%`);
check('mapped confidence becomes the badge pct', res.verdict?.pct === 94, `pct=${res.verdict?.pct}`);
check('request used the OpenRouter default model', openrouterCalls[0]?.model === 'deepseek/deepseek-v4-flash', openrouterCalls[0]?.model);
check('request used json_schema response format', openrouterCalls[0]?.response_format?.type === 'json_schema');
check('request body includes every taxonomy question in the prompt', String(openrouterCalls[0]?.messages?.[0]?.content).includes('larp_role'));

// Model leak guard: a typesafe model id must not be sent to OpenRouter
await call({ type: 'SET_SETTINGS', patch: { provider: 'openrouter', openrouterApiKey: 'sk-or-test', model: 'jev-latest' } });
const leaked = await call({ type: 'ANALYZE_POST', post: { ...OPENROUTER_POST, post_text: OPENROUTER_POST.post_text + ' More.' } });
check('typesafe model id falls back to the OpenRouter default', openrouterCalls[1]?.model === 'deepseek/deepseek-v4-flash', openrouterCalls[1]?.model);

console.log(failures === 0 ? '\nAll smoke tests passed.' : `\n${failures} smoke test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
