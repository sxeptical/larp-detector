/** LARP Detector — popup logic. Talks to the service worker for all state. */

const $ = (id) => document.getElementById(id);

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res);
    });
  });
}

async function refresh() {
  const [{ ok: sOk, settings }, { ok: stOk, stats }] = await Promise.all([
    send({ type: 'GET_SETTINGS' }),
    send({ type: 'GET_STATS' }),
  ]);

  if (sOk) {
    $('enabled').checked = settings.enabled;
    $('sensitivity').value = settings.sensitivity;
    $('sensitivity-value').textContent = Number(settings.sensitivity).toFixed(1);
    $('showGenuine').checked = Boolean(settings.showGenuine);
    $('provider').value = settings.provider;
    const keyEl = $('key-status');
    if (settings.apiKey) {
      keyEl.textContent = 'key: set ✓';
      keyEl.className = 'status status--ok';
    } else {
      keyEl.textContent = settings.provider === 'mock' ? 'no key needed in mock mode' : 'key: not set — add it in Options';
      keyEl.className = settings.provider === 'mock' ? 'status' : 'status status--bad';
    }
  }

  if (stOk) {
    $('stat-cache').textContent = stats.cacheSize ?? 0;
    $('stat-model').textContent = stats.lastModel ? `model: ${stats.lastModel}` : 'model: —';
    if (stats.lastError) $('stat-model').title = stats.lastError;
  }
}

function patch(patchObj) {
  return send({ type: 'SET_SETTINGS', patch: patchObj });
}

$('enabled').addEventListener('change', (e) => patch({ enabled: e.target.checked }));
$('showGenuine').addEventListener('change', (e) => patch({ showGenuine: e.target.checked }));
$('sensitivity').addEventListener('input', (e) => {
  $('sensitivity-value').textContent = Number(e.target.value).toFixed(1);
  patch({ sensitivity: Number(e.target.value) });
});
$('provider').addEventListener('change', (e) => {
  patch({ provider: e.target.value }).then(refresh);
});
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('clear').addEventListener('click', async () => {
  await send({ type: 'CLEAR_CACHE' });
  refresh();
});

refresh();
