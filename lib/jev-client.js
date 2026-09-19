/**
 * Provider adapter for the Jev call.
 *
 * Providers:
 *   typesafe    — direct API (default). POST /v1/systemone, documented shape.
 *                 https://api.typesafe.ai  (waitlist: typesafe.ai)
 *   openrouter  — stub. OpenRouter has placeholder pages for typesafe/jev-1.13
 *                 but does NOT serve it through the API yet (verified Sep 19,
 *                 2026 against /api/v1/models). Flips on here when it lands.
 *   mock        — never called; the caller goes straight to heuristics.
 */

import { buildQuestions } from './questions.js';

export class JevError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'JevError';
    this.status = status;
  }
}

const ENDPOINTS = {
  typesafe: 'https://api.typesafe.ai/v1/systemone',
};

const RETRYABLE = new Set([429, 529, 500, 502, 503, 504]);

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
 * @param {object} settings  { provider, apiKey, model }
 * @returns {Promise<{answers: object, model: string, usage: object}>}
 */
export async function callJev(state, settings) {
  const provider = settings.provider || 'typesafe';

  if (!settings.apiKey) {
    throw new JevError('No API key set. Add one in the extension options (or use mock mode).');
  }

  if (provider === 'openrouter') {
    // Pre-wired for the day OpenRouter starts serving the model.
    throw new JevError(
      'OpenRouter does not serve Jev through its API yet (placeholder listing only). Use the TypeSafe provider or mock mode.'
    );
  }

  const url = ENDPOINTS[provider];
  if (!url) throw new JevError(`Unknown provider: ${provider}`);

  const body = {
    model: settings.model || 'jev-latest',
    state,
    questions: buildQuestions(),
  };

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
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
