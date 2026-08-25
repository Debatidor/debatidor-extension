// Debatidor popup: a compact control surface for the active browser agent.

const HOSTS = {
  'chat.qwen.ai': { name: 'Qwen', url: 'https://chat.qwen.ai/', available: true },
  'chatgpt.com': { name: 'ChatGPT', url: 'https://chatgpt.com/', available: true },
};

const ROADMAP_HOSTS = [
  { name: 'Claude', available: false },
  { name: 'Gemini', available: false },
];

const DEFAULTS = {
  backendUrl: 'wss://api.debatidor.com/extension',
  connectionId: 'conn_dom',
  debateId: '',
  apiKey: '',
};

const VIEW_IDS = ['view-agent', 'view-empty', 'view-first'];
const $ = (id) => document.getElementById(id);

let activeTabId = null;
let isSettingsOpen = false;
let toastTimer = 0;

void init();

async function init() {
  const manifest = chrome.runtime.getManifest();
  $('app-version').textContent = `Extensión · v${manifest.version}`;

  const stored = await chrome.storage.local.get(DEFAULTS);
  fillSettings(stored);
  renderHostList();
  renderOpenHostButtons();

  await refresh();
  window.setInterval(() => void refresh(), 1800);
}

function hostFor(url) {
  if (!url) return null;
  try {
    return HOSTS[new URL(url).hostname] ?? null;
  } catch {
    return null;
  }
}

function showView(viewId) {
  if (isSettingsOpen) return;
  for (const id of VIEW_IDS) {
    $(id).classList.toggle('hidden', id !== viewId);
  }
}

async function refresh() {
  if (isSettingsOpen) return;

  const [stored, tabs] = await Promise.all([
    chrome.storage.local.get(['apiKey']),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);

  const tab = tabs[0];
  activeTabId = tab?.id ?? null;

  if (!stored.apiKey) {
    showView('view-first');
    renderStatus({ socket: 'closed', hasKey: false });
    return;
  }

  const status = await getRuntimeStatus();
  renderStatus(status);

  const host = hostFor(tab?.url);
  if (!host) {
    showView('view-empty');
    return;
  }

  showView('view-agent');
  await renderAgentView(host, tab);
}

function getRuntimeStatus() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'status' }, (status) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(status ?? null);
    });
  });
}

function renderStatus(status) {
  const pill = $('connection-pill');
  pill.className = 'status-pill';

  if (!status) {
    pill.classList.add('is-error');
    $('ws-label').textContent = 'Servicio no disponible';
    return;
  }

  if (!status.hasKey) {
    pill.classList.add('is-error');
    $('ws-label').textContent = 'Sin acceso';
    return;
  }

  const connected = status.socket === 'open';
  pill.classList.add(connected ? 'is-open' : 'is-loading');
  $('ws-label').textContent = connected ? 'Hub listo' : 'Reconectando';
}

function renderHostList() {
  const hostList = $('host-list');
  hostList.replaceChildren();

  const liveCount = Object.values(HOSTS).filter((h) => h.available).length;
  const countBadge = $('host-count');
  if (countBadge) countBadge.textContent = `${liveCount} activos`;

  for (const host of [...Object.values(HOSTS), ...ROADMAP_HOSTS]) {
    const item = document.createElement('div');
    item.className = `host-item${host.available ? ' is-live' : ''}`;

    const name = document.createElement('strong');
    name.textContent = host.name;

    const state = document.createElement('span');
    state.textContent = host.available ? 'Disponible' : 'Próximamente';

    item.append(name, state);
    hostList.appendChild(item);
  }
}

/** Botones "Abrir <host>" para cada host vivo (vista sin pestaña compatible). */
function renderOpenHostButtons() {
  const wrap = $('open-host-buttons');
  if (!wrap) return;
  wrap.replaceChildren();

  for (const host of Object.values(HOSTS).filter((h) => h.available)) {
    const button = document.createElement('button');
    button.className = 'button button--primary';
    button.type = 'button';
    button.textContent = `Abrir ${host.name}`;

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 20 20');
    icon.setAttribute('aria-hidden', 'true');
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrow.setAttribute('d', 'M6 14 14 6m-6 0h6v6');
    icon.appendChild(arrow);
    button.appendChild(icon);

    button.addEventListener('click', () => {
      chrome.tabs.create({ url: host.url });
    });
    wrap.appendChild(button);
  }
}

async function renderAgentView(host, tab) {
  $('agent-name').textContent = host.name;
  $('agent-url').textContent = readableTabUrl(tab?.url);

  if (tab?.id == null) {
    setToggle(false);
    return;
  }

  const key = `injection:${tab.id}`;
  const stored = await chrome.storage.session.get(key);
  setToggle(Boolean(stored[key]));
}

function readableTabUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return '';
  }
}

function setToggle(enabled) {
  $('inject-toggle').checked = enabled;
  $('toggle-hint').textContent = enabled ? 'Activa · intercambiando turnos' : 'La extensión está en pausa';
  $('flow-tab-dot').classList.toggle('is-ready', enabled);
  $('flow-answer-dot').classList.toggle('is-ready', enabled);
}

$('inject-toggle').addEventListener('change', (event) => {
  if (activeTabId == null) {
    event.target.checked = false;
    return;
  }

  const enabled = event.target.checked;
  chrome.runtime.sendMessage(
    { type: 'toggle-injection', tabId: activeTabId, enabled },
    (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        setToggle(!enabled);
        showToast('No pudimos cambiar el estado', true);
        return;
      }
      setToggle(enabled);
      showToast(enabled ? 'Pestaña vinculada' : 'Pestaña en pausa');
    },
  );
});

function openSettings({ focusApiKey = false } = {}) {
  isSettingsOpen = true;
  for (const id of VIEW_IDS) $(id).classList.add('hidden');
  $('settings').classList.remove('hidden');
  $('btn-settings').setAttribute('aria-expanded', 'true');
  $('btn-settings').setAttribute('aria-label', 'Cerrar ajustes');
  if (focusApiKey) window.setTimeout(() => $('apiKey').focus(), 0);
}

function closeSettings() {
  isSettingsOpen = false;
  $('settings').classList.add('hidden');
  $('btn-settings').setAttribute('aria-expanded', 'false');
  $('btn-settings').setAttribute('aria-label', 'Abrir ajustes');
  void refresh();
}

$('btn-settings').addEventListener('click', () => {
  if (isSettingsOpen) closeSettings();
  else openSettings();
});

$('btn-close-settings').addEventListener('click', closeSettings);
$('btn-goto-key').addEventListener('click', () => openSettings({ focusApiKey: true }));

function fillSettings(stored) {
  $('backendUrl').value = stored.backendUrl ?? '';
  $('connectionId').value = stored.connectionId ?? '';
  $('debateId').value = stored.debateId ?? '';
  $('apiKey').value = stored.apiKey ?? '';
  updateEnvironmentSelection();
}

function updateEnvironmentSelection() {
  const current = $('backendUrl').value.trim();
  for (const id of ['chip-prod', 'chip-local']) {
    $(id).classList.toggle('is-selected', $(id).dataset.url === current);
  }
}

for (const id of ['chip-prod', 'chip-local']) {
  $(id).addEventListener('click', () => {
    $('backendUrl').value = $(id).dataset.url;
    updateEnvironmentSelection();
  });
}

$('backendUrl').addEventListener('input', updateEnvironmentSelection);

$('btn-toggle-key').addEventListener('click', () => {
  const input = $('apiKey');
  const reveal = input.type === 'password';
  input.type = reveal ? 'text' : 'password';
  $('btn-toggle-key').textContent = reveal ? 'Ocultar' : 'Mostrar';
  $('btn-toggle-key').setAttribute('aria-label', `${reveal ? 'Ocultar' : 'Mostrar'} API Key`);
});

$('save').addEventListener('click', () => {
  const config = Object.fromEntries(
    ['backendUrl', 'connectionId', 'debateId', 'apiKey'].map((id) => [id, $(id).value.trim()]),
  );

  if (!config.apiKey) {
    $('apiKey').focus();
    showToast('Añade una API Key para continuar', true);
    return;
  }

  if (!isWebSocketUrl(config.backendUrl)) {
    $('backendUrl').focus();
    showToast('Usa una dirección ws:// o wss:// válida', true);
    return;
  }

  const button = $('save');
  button.classList.add('is-saving');
  button.disabled = true;
  button.querySelector('span').textContent = 'Guardando…';

  chrome.runtime.sendMessage({ type: 'save-config', config }, (response) => {
    button.classList.remove('is-saving');
    button.disabled = false;
    button.querySelector('span').textContent = 'Guardar y reconectar';

    if (chrome.runtime.lastError || !response?.ok) {
      showToast('No pudimos guardar los ajustes', true);
      return;
    }

    closeSettings();
    showToast('Configuración guardada');
  });
});

function isWebSocketUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'ws:' || url.protocol === 'wss:';
  } catch {
    return false;
  }
}

function showToast(message, isError = false) {
  window.clearTimeout(toastTimer);
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.toggle('is-error', isError);
  toast.classList.add('is-visible');
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2200);
}
