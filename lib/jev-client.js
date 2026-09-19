/**
 * Provider adapter for the judgment call.
 *
 * Providers:
 *   typesafe        — Jev direct. POST /v1/systemone, native schema.
 *                     https://api.typesafe.ai
 *   openrouter      — Jev via OpenRouter's alpha Decisions API
 *                     (POST /api/alpha/decisions, verified Sep 19 2026).
 *                     Same {model, state, questions} body, same answers shape.
 *                     Note: chat completions do NOT work with Jev — it only
 *                     speaks the Decisions router.
 *   openrouter-chat — Emulation fallback for accounts without Decisions access:
 *                     a cheap chat model answers the same question set in
 *                     structured JSON, mapped back into Jev's answer shape.
 *   mock            — handled in the service worker; heuristics, no network.
 */

import { buildQuestions } from './questions.js';

export class JevError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'JevError';
    this.status = status;
  }
}

export const DEFAULT_MODELS = {
  typesafe: 'jev-latest',
  openrouter: 'typesafe/jev-1.13',
  'openrouter-chat': 'deepseek/deepseek-v4-flash',
};

const ENDPOINTS = {
  typesafe: 'https://api.typesafe.ai/v1/systemone',
  openrouter: 'https://openrouter.ai/api/alpha/decisions',
  'openrouter-chat': 'https://openrouter.ai/api/v1/chat/completions',
};

const RETRYABLE = new Set([429, 529, 500, 502, 503, 504]);

/** The API key belonging to the currently selected provider. */
export function providerApiKey(settings) {
  const provider = settings.provider || 'typesafe';
  if (provider === 'openrouter' || provider === 'openrouter-chat') {
    return settings.openrouterApiKey || '';
  }
  return settings.apiKey || '';
}

/**
 * Guard against a model ID leaking across providers (e.g. `jev-latest` sent to
 * OpenRouter, or an OpenRouter `org/model` slug sent to TypeSafe).
 */
function resolveModel(provider, model) {
  const fallback = DEFAULT_MODELS[provider] || '';
  const m = String(model || '').trim();
  if (!m) return fallback;
  const isOpenRouter = provider === 'openrouter' || provider === 'openrouter-chat';
  if (isOpenRouter && !m.includes('/')) return fallback;
  if (!isOpenRouter && m.includes('/')) return fallback;
  return m;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, options, { retries = 2, timeoutMs = 8000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      if (res.ok) return res;
      const body = await res.text().catch(() => '');
      lastError = new JevError(
        `HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`,
        res.status
      );
      if (!RETRYABLE.has(res.status)) throw lastError;
    } catch (err) {
      if (err instanceof JevError && !RETRYABLE.has(err.status)) throw err;
      lastError = err.name === 'AbortError' ? new JevError(`Timed out after ${timeoutMs}ms`) : err;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await sleep(600 * 2 ** attempt + Math.random() * 300);
  }
  throw lastError;
}

/**
 * @param {{post_text: string, author_headline: string}} state
 * @param {object} settings  { provider, apiKey, openrouterApiKey, model }
 * @returns {Promise<{answers: object, model: string, usage: object}>}
 */
export async function callJev(state, settings) {
  const provider = settings.provider || 'typesafe';
  const apiKey = providerApiKey(settings);

  if (!apiKey) {
    const label = provider.startsWith('openrouter') ? 'OpenRouter' : 'TypeSafe';
    throw new JevError(`No ${label} API key set. Add one in the extension options (or use mock mode).`);
  }

  if (provider === 'openrouter') {
    return callOpenRouterDecisions(state, settings, apiKey);
  }

  if (provider === 'openrouter-chat') {
    return callOpenRouterChat(state, settings, apiKey);
  }

  if (provider !== 'typesafe') throw new JevError(`Unknown provider: ${provider}`);

  const body = {
    model: resolveModel('typesafe', settings.model),
    state,
    questions: buildQuestions(),
  };

  const res = await fetchWithRetry(ENDPOINTS.typesafe, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  let json;
  try {
    json = await res.json();
  } catch {
    throw new JevError('Response was not valid JSON');
  }

  if (!json?.answers) throw new JevError('Response contained no `answers` object');
  return { answers: json.answers, model: json.model ?? body.model, usage: json.usage ?? {} };
}

// ---------------------------------------------------------------------------
// OpenRouter — Jev via the alpha Decisions API
// ---------------------------------------------------------------------------

async function callOpenRouterDecisions(state, settings, apiKey) {
  const body = {
    model: resolveModel('openrouter', settings.model),
    state,
    questions: buildQuestions(),
  };

  const res = await fetchWithRetry(
    ENDPOINTS.openrouter,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'LARP Detector',
      },
      body: JSON.stringify(body),
    },
    { timeoutMs: 15000 }
  );

  let json;
  try {
    json = await res.json();
  } catch {
    throw new JevError('OpenRouter Decisions response was not valid JSON');
  }

  if (!json?.answers) {
    throw new JevError('OpenRouter Decisions response contained no `answers` object');
  }
  return { answers: json.answers, model: json.model ?? body.model, usage: json.usage ?? {} };
}

// ---------------------------------------------------------------------------
// OpenRouter — chat-model emulation (fallback for keys without Decisions access)
// ---------------------------------------------------------------------------

function describeQuestions(questions) {
  const lines = ['Questions to answer about the post:'];
  for (const [id, q] of Object.entries(questions)) {
    lines.push(`\n## ${id} (${q.type})`);
    lines.push(q.instructions);
    if (q.criteria && Array.isArray(q.criteria)) {
      lines.push('Scale, from low to high:');
      q.criteria.forEach((c, i) => lines.push(`  ${i} = ${c}`));
    } else if (q.criteria) {
      lines.push('Options:');
      for (const [key, desc] of Object.entries(q.criteria)) {
        lines.push(`  ${key} = ${desc ?? 'none of the above'}`);
      }
    }
  }
  return lines.join('\n');
}

/** JSON schema for strict structured output, derived from the taxonomy. */
function buildSchema(questions) {
  const properties = {};
  const required = [];
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'noul') {
      properties[id] = {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Probability the answer is yes (0 = no, 1 = yes)',
      };
    } else if (q.type === 'choice') {
      properties[id] = { type: 'string', enum: Object.keys(q.criteria) };
    } else {
      properties[id] = {
        type: 'number',
        minimum: 0,
        maximum: q.criteria.length - 1,
        description: 'Position on the scale',
      };
    }
    required.push(id);
  }
  properties.role_confidence = {
    type: 'number',
    minimum: 0,
    maximum: 1,
    description: 'How confident you are in your larp_role choice',
  };
  required.push('role_confidence');

  return {
    name: 'larp_verdict',
    strict: true,
    schema: { type: 'object', properties, required, additionalProperties: false },
  };
}

function buildMessages(state) {
  const questions = buildQuestions();
  const system = [
    'You classify LinkedIn posts for LARP — identity performance: the author playing the character of visionary executive, elite expert, or thought leader instead of showing real work.',
    'Answer every question about the post in the provided state. Noul answers are numbers from 0 to 1 (probability the answer is yes). Choice answers are exactly one option key. Score answers are a number on the defined scale.',
    'Judge only what the text shows. Do not invent context about the author.',
    describeQuestions(questions),
    'Respond with one JSON object containing a field for every question id above, plus "role_confidence" (0 to 1).',
  ].join('\n\n');

  return {
    questions,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `Post state:\n${JSON.stringify(state, null, 2)}` },
    ],
    schema: buildSchema(questions),
  };
}

function parseLlmJson(content) {
  const text = String(content || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return JSON.parse(text);
}

const clampNum = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));

/** Map the LLM's flat JSON into Jev's typed answer shape. Exported for tests. */
export function mapLlmAnswers(llm, questions = buildQuestions()) {
  const answers = {};
  for (const [id, q] of Object.entries(questions)) {
    const value = llm[id];
    if (q.type === 'noul') {
      answers[id] = { type: 'noul', noul: clampNum(value, 0, 1) };
    } else if (q.type === 'choice') {
      const options = Object.keys(q.criteria);
      const choice = options.includes(value) ? value : options.includes('other') ? 'other' : options[0];
      const confidence = clampNum(llm.role_confidence ?? 0.75, 0, 1);
      answers[id] = { type: 'choice', choice, probabilities: { [choice]: confidence }, confidence };
    } else {
      answers[id] = {
        type: 'score',
        score: clampNum(value, 0, q.criteria.length - 1),
        legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])),
        probabilities: {},
        confidence: clampNum(llm.role_confidence ?? 0.7, 0, 1),
      };
    }
  }
  return answers;
}

async function callOpenRouterChat(state, settings, apiKey) {
  const model = resolveModel('openrouter-chat', settings.model);
  const { messages, schema, questions } = buildMessages(state);

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-Title': 'LARP Detector',
  };

  const post = (responseFormat) =>
    fetchWithRetry(
      ENDPOINTS['openrouter-chat'],
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages, response_format: responseFormat }),
      },
      { timeoutMs: 20000 }
    );

  let res;
  try {
    res = await post({ type: 'json_schema', json_schema: schema });
  } catch (err) {
    // Some models on OpenRouter don't accept json_schema — retry in JSON mode.
    if (err instanceof JevError && err.status === 400) {
      res = await post({ type: 'json_object' });
    } else {
      throw err;
    }
  }

  let json;
  try {
    json = await res.json();
  } catch {
    throw new JevError('OpenRouter response was not valid JSON');
  }

  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new JevError('OpenRouter response contained no message content');

  let parsed;
  try {
    parsed = parseLlmJson(content);
  } catch {
    throw new JevError(`OpenRouter model returned unparseable JSON: ${String(content).slice(0, 200)}`);
  }

  return {
    answers: mapLlmAnswers(parsed, questions),
    model: json.model ?? model,
    usage: json.usage ?? {},
  };
}
