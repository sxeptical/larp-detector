/** LARP Detector — options page. */

const $ = (id) => document.getElementById(id);

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res);
    });
  });
}

async function load() {
  const { ok, settings } = await send({ type: 'GET_SETTINGS' });
  if (!ok) return;
  $('provider').value = settings.provider;
  $('apiKey').value = settings.apiKey || '';
  $('model').value = settings.model || '';
}

function save() {
  return send({
    type: 'SET_SETTINGS',
    patch: {
      provider: $('provider').value,
      apiKey: $('apiKey').value.trim(),
      model: $('model').value.trim() || 'jev-latest',
    },
  });
}

$('provider').addEventListener('change', save);
$('apiKey').addEventListener('change', save);
$('model').addEventListener('change', save);

$('reveal').addEventListener('click', () => {
  const input = $('apiKey');
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  $('reveal').textContent = showing ? 'show' : 'hide';
});

$('test').addEventListener('click', async () => {
  const box = $('test-result');
  box.hidden = false;
  box.className = 'result';
  box.textContent = 'Running…';
  await save();

  const res = await send({ type: 'TEST_PROVIDER' });
  if (!res?.ok) {
    box.classList.add('result--bad');
    box.textContent = `✗ ${res?.error || 'Unknown error'}`;
    return;
  }

  const v = res.verdict;
  box.classList.add('result--ok');
  const lines = [
    `✓ provider responded in ${res.latencyMs}ms`,
    `source:  ${res.source}`,
    `model:   ${res.model || '—'}`,
  ];
  if (v) {
    lines.push('', `${v.emoji} ${v.label} · ${v.pct ?? '?'}%  (intensity ${v.score ?? '?'} / 4)`, ...v.details);
  }
  box.textContent = lines.join('\n');
});

$('clear').addEventListener('click', async () => {
  await send({ type: 'CLEAR_CACHE' });
  $('clear-status').textContent = 'cache cleared ✓';
  setTimeout(() => ($('clear-status').textContent = ''), 2500);
});

load();
