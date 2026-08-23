// Debatidor popup — cero fricción: detecta el host en la pestaña activa,
// guarda la config en chrome.storage.local y muestra un toggle de inyección
// por pestaña. Los inputs viven detrás de "Ajustes".

const HOSTS = {
  'chat.qwen.ai': { name: 'Qwen', match: ['https://chat.qwen.ai/*'] },
  'chatgpt.com': { name: 'ChatGPT', match: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] },
  'claude.ai': { name: 'Claude', match: ['https://claude.ai/*'] },
  'gemini.google.com': { name: 'Gemini', match: ['https://gemini.google.com/*'] },
};
const DEFAULTS = {
  backendUrl: 'ws://localhost:3001/extension',
  connectionId: 'conn_dom_qwen_01',
  debateId: '',
  apiKey: '',
};

const $ = (id) => document.getElementById(id);
let activeTabId = null;

init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  $('agent-url').textContent = tab?.url ?? '';

  const stored = await chrome.storage.local.get(DEFAULTS);
  fillSettings(stored);

  await refresh();
  setInterval(refresh, 1500);
}

// --------------------------------------------------------------- routing

function hostFor(url) {
  if (!url) return null;
  try {
    return HOSTS[new URL(url).hostname] ?? null;
  } catch {
    return null;
  }
}

function show(view) {
  for (const id of ['view-agent', 'view-empty', 'view-first']) {
    $(id).classList.toggle('hidden', id !== view);
    $(id).classList.toggle('flex', id === view);
  }
}

let didFocusApiKey = false;

async function refresh() {
  // 1. ¿Hay API key? Sin ella, todo lo demás es ruido.
  const stored = await chrome.storage.local.get(['apiKey']);
  if (!stored.apiKey) {
    show('view-first');
    renderStatus({ socket: 'closed', hasKey: false });
    return;
  }
  didFocusApiKey = false;

  // 2. ¿La pestaña activa es un host compatible?
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const host = hostFor(tab?.url);
  $('ws-label').textContent = '…';
  chrome.runtime.sendMessage({ type: 'status' }, (status) => {
    renderStatus(status);
    if (!host) {
      show('view-empty');
      renderHostList();
      return;
    }
    show('view-agent');
    renderAgentView(host, tab);
  });
}

function renderStatus(status) {
  const dot = $('ws-dot');
  const label = $('ws-label');
  dot.className = 'dot';
  if (!status) {
    dot.classList.add('dot-dead');
    label.textContent = 'SW muerto';
    return;
  }
  if (!status.hasKey) {
    dot.classList.add('dot-dead');
    label.textContent = 'Sin API Key';
    return;
  }
  dot.classList.add(status.socket === 'open' ? 'dot-open' : 'dot-closed');
  label.textContent = status.socket === 'open' ? 'Conectado' : 'Conectando…';
}

function renderHostList() {
  const list = $('host-list');
  list.innerHTML = '';
  for (const { name } of Object.values(HOSTS)) {
    const li = document.createElement('li');
    li.className = 'text-xs text-slate-400';
    li.textContent = `• ${name}`;
    list.appendChild(li);
  }
}

async function renderAgentView(host, tab) {
  $('agent-name').textContent = host.name;
  const stored = await chrome.storage.session.get(`injection:${tab.id}`);
  const enabled = Boolean(stored[`injection:${tab.id}`]);
  setToggle(enabled);
}

// ---------------------------------------------------------------- toggle

function setToggle(enabled) {
  $('inject-toggle').checked = enabled;
  $('toggle-hint').textContent = enabled
    ? 'Activa — recibiendo turnos y transmitiendo respuestas'
    : 'Apagada';
}

$('inject-toggle').addEventListener('change', async (event) => {
  if (activeTabId == null) return;
  const enabled = event.target.checked;
  chrome.runtime.sendMessage(
    { type: 'toggle-injection', tabId: activeTabId, enabled },
    () => setToggle(enabled)
  );
});

// -------------------------------------------------------------- settings

function openSettings(highlightApiKey) {
  $('settings').classList.remove('hidden');
  $('btn-settings').textContent = 'Ajustes ▴';
  if (highlightApiKey && !didFocusApiKey) {
    $('apiKey').focus();
    didFocusApiKey = true;
  }
}

$('btn-goto-key').addEventListener('click', () => {
  openSettings(true);
  $('apiKey').focus();
});

function toggleSettings() {
  const hidden = $('settings').classList.toggle('hidden');
  $('btn-settings').textContent = hidden ? 'Ajustes ▾' : 'Ajustes ▴';
}

$('btn-settings').addEventListener('click', toggleSettings);

function fillSettings(stored) {
  $('backendUrl').value = stored.backendUrl ?? '';
  $('connectionId').value = stored.connectionId ?? '';
  $('debateId').value = stored.debateId ?? '';
  $('apiKey').value = stored.apiKey ?? '';
}

$('chip-local').addEventListener('click', () => {
  $('backendUrl').value = 'ws://localhost:3001/extension';
});
$('chip-prod').addEventListener('click', () => {
  $('backendUrl').value = 'wss://api.debatidor.com/extension';
});

$('save').addEventListener('click', () => {
  const config = {};
  for (const id of ['backendUrl', 'connectionId', 'debateId', 'apiKey']) {
    config[id] = $(id).value.trim();
  }
  chrome.runtime.sendMessage({ type: 'save-config', config }, () => {
    closeSettingsAfterSave();
    refresh();
  });
});

function closeSettingsAfterSave() {
  const stored = chrome.storage.local.get(['apiKey']);
  Promise.resolve(stored).then((s) => {
    if (s.apiKey) toggleSettings(); // colapsa si ya hay key guardada
  });
}
