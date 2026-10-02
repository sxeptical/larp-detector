/** LARP Detector — options page. */

const $ = (id) => document.getElementById(id);

const DEFAULT_MODELS = {
  typesafe: 'jev-latest',
  openrouter: 'typesafe/jev-1.13',
  'openrouter-chat': 'deepseek/deepseek-v4-flash',
};

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res);
    });
  });
}

function applyProviderVisibility() {
  const provider = $('provider').value;
  const isOpenRouter = provider.startsWith('openrouter');
  $('key-typesafe').hidden = provider !== 'typesafe';
  $('key-openrouter').hidden = !isOpenRouter;
  $('model').placeholder = DEFAULT_MODELS[provider] || '';
  $('model-hint').textContent = isOpenRouter
    ? provider === 'openrouter'
      ? 'Leave empty for typesafe/jev-1.13. Any model the Decisions router serves works.'
      : 'Leave empty for the default. Any OpenRouter chat model with structured output works, e.g. openai/gpt-5-nano.'
    : "Leave empty for the default. Pin the versioned ID (e.g. jev-1.13.0) once you've tuned the sensitivity.";
}

// Keys come from a separate message (the worker only serves it to extension
// pages). Until they've loaded, saving must not send the empty fields — that
// would overwrite the stored keys.
let secretsLoaded = false;

async function load() {
  const [{ ok, settings }, secretsRes] = await Promise.all([
    send({ type: 'GET_SETTINGS' }),
    send({ type: 'GET_SECRETS' }),
  ]);
  if (!ok) return;
  $('provider').value = settings.provider;
  $('model').value = settings.model || '';
  if (secretsRes?.ok) {
    $('apiKey').value = secretsRes.secrets.apiKey || '';
    $('openrouterApiKey').value = secretsRes.secrets.openrouterApiKey || '';
    secretsLoaded = true;
  }
  applyProviderVisibility();
}

function save() {
  const patch = { provider: $('provider').value, model: $('model').value.trim() };
  if (secretsLoaded) {
    patch.apiKey = $('apiKey').value.trim();
    patch.openrouterApiKey = $('openrouterApiKey').value.trim();
  }
  return send({ type: 'SET_SETTINGS', patch });
}

$('provider').addEventListener('change', () => {
  applyProviderVisibility();
  save();
});
$('apiKey').addEventListener('change', save);
$('openrouterApiKey').addEventListener('change', save);
$('model').addEventListener('change', save);

for (const btn of document.querySelectorAll('.reveal')) {
  btn.addEventListener('click', () => {
    const input = $(btn.dataset.target);
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.textContent = showing ? 'show' : 'hide';
  });
}

$('test').addEventListener('click', async () => {
  const box = $('test-result');
  box.hidden = false;
  box.className = 'result';
  box.textContent = 'Running…';
  await save();

  const res = await send({ type: 'TEST_PROVIDER' });
  if (!res?.ok) {
    box.classList.add('result--bad');
    box.textContent = `failed — ${res?.error || 'Unknown error'}`;
    return;
  }

  const v = res.verdict;
  box.classList.add('result--ok');
  const lines = [
    `ok — provider responded in ${res.latencyMs}ms`,
    `source:  ${res.source}`,
    `model:   ${res.model || '—'}`,
  ];
  if (v) {
    lines.push('', `${v.label} · ${v.pct ?? '?'}%  (intensity ${v.score ?? '?'} / 4)`, ...v.details);
  }
  box.textContent = lines.join('\n');
});

$('clear').addEventListener('click', async () => {
  await send({ type: 'CLEAR_CACHE' });
  $('clear-status').textContent = 'cache cleared';
  setTimeout(() => ($('clear-status').textContent = ''), 2500);
});

load();
