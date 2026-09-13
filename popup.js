// Debatidor popup: a compact control surface for the active browser agent.

// Catálogo canónico de hosts vivos. La vista, el contador y el picker se
// derivan de esta estructura: agregar un provider no implica tocar HTML.
const HOSTS = {
  'chat.qwen.ai': {
    name: 'Qwen',
    url: 'https://chat.qwen.ai/',
    domains: ['chat.qwen.ai'],
    available: true,
  },
  'chatgpt.com': {
    name: 'ChatGPT',
    url: 'https://chatgpt.com/',
    domains: ['chatgpt.com', 'chat.openai.com'],
    available: true,
  },
  'chat.z.ai': {
    name: 'Z.ai (GLM)',
    url: 'https://chat.z.ai/',
    domains: ['chat.z.ai', 'z.ai'],
    available: true,
  },
  'claude.ai': {
    name: 'Claude',
    url: 'https://claude.ai/new',
    domains: ['claude.ai'],
    available: true,
  },
};

const ROADMAP_HOSTS = [
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
let runtimeStatus = null;

void init();

async function init() {
  const manifest = chrome.runtime.getManifest();
  $('app-version').textContent = `Extensión · v${manifest.version}`;

  const stored = await chrome.storage.local.get(DEFAULTS);
  fillSettings(stored);
  renderHostList();
  renderAgentPicker();

  await refresh();
  window.setInterval(() => void refresh(), 1800);
}

function liveHosts() {
  return Object.values(HOSTS).filter((host) => host.available);
}

function hostFor(url) {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return (
      liveHosts().find((host) =>
        (host.domains ?? []).some((domain) => domain.toLowerCase() === hostname),
      ) ?? null
    );
  } catch {
    return null;
  }
}

function showView(viewId) {
  if (isSettingsOpen) return;
  if (viewId !== 'view-empty') setAgentPickerOpen(false);
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
    renderAssetTickets(null);
    return;
  }

  const status = await getRuntimeStatus();
  renderStatus(status);
  renderAssetTickets(status);

  const host = hostFor(tab?.url);
  if (!host) {
    showView('view-empty');
    return;
  }

  showView('view-agent');
  await renderAgentView(host, tab, status);
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
  runtimeStatus = status;
  const pill = $('connection-pill');
  pill.className = 'status-pill';
  $('flow-hub-dot').classList.toggle('is-ready', status?.socket === 'open' && Boolean(status?.hasKey));

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
  $('ws-label').textContent = connected ? 'Hub conectado' : 'Reconectando';
}

function renderHostList() {
  const hostList = $('host-list');
  hostList.replaceChildren();

  const liveCount = liveHosts().length;
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

function setAgentPickerOpen(open) {
  const trigger = $('btn-open-agent');
  const menu = $('agent-picker-menu');
  if (!trigger || !menu) return;
  const next = Boolean(open && liveHosts().length);
  trigger.setAttribute('aria-expanded', String(next));
  trigger.classList.toggle('is-open', next);
  menu.classList.toggle('hidden', !next);
}

/**
 * Un solo CTA visible. Los providers viven dentro de un picker compacto que
 * se deriva de HOSTS; sumar un host no agrega otra fila de botones al hero.
 */
function renderAgentPicker() {
  const trigger = $('btn-open-agent');
  const menu = $('agent-picker-menu');
  if (!trigger || !menu) return;

  menu.replaceChildren();
  const hosts = liveHosts();
  trigger.disabled = hosts.length === 0;

  for (const host of hosts) {
    const option = document.createElement('button');
    option.className = 'agent-picker-option';
    option.type = 'button';
    option.setAttribute('role', 'menuitem');
    option.title = `Abrir ${host.name}`;

    const copy = document.createElement('span');
    copy.className = 'agent-picker-option-copy';
    const name = document.createElement('strong');
    name.textContent = host.name;
    const state = document.createElement('small');
    state.textContent = 'Disponible';
    copy.append(name, state);

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 20 20');
    icon.setAttribute('aria-hidden', 'true');
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrow.setAttribute('d', 'M6 14 14 6m-6 0h6v6');
    icon.appendChild(arrow);

    option.append(copy, icon);
    option.addEventListener('click', () => {
      setAgentPickerOpen(false);
      chrome.tabs.create({ url: host.url });
    });
    menu.appendChild(option);
  }
}

$('btn-open-agent').addEventListener('click', (event) => {
  event.stopPropagation();
  const open = $('btn-open-agent').getAttribute('aria-expanded') === 'true';
  setAgentPickerOpen(!open);
});

$('agent-picker-menu').addEventListener('click', (event) => event.stopPropagation());
document.addEventListener('click', () => setAgentPickerOpen(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setAgentPickerOpen(false);
});

async function renderAgentView(host, tab, status) {
  $('agent-name').textContent = host.name;
  $('agent-url').textContent = readableTabUrl(tab?.url);
  $('room-hint').textContent = status?.debateId
    ? `Sala configurada: ${status.debateId}`
    : 'Sin sala fija. Para usar una Arena, pega su ID en Ajustes.';

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
  const hasPort = runtimeStatus?.tabs?.includes(activeTabId) === true;
  const hasSocket = runtimeStatus?.socket === 'open';
  $('inject-toggle').checked = enabled;
  $('toggle-hint').textContent = !enabled
    ? 'La extensión está en pausa'
    : !hasPort
      ? 'Permiso activo · recarga esta pestaña'
      : !hasSocket
        ? 'Permiso activo · esperando al Hub'
        : 'Permiso activo · esperando turnos';
  $('flow-tab-dot').classList.toggle('is-ready', enabled && hasPort);
  // The toggle grants consent; it is not evidence of a captured or saved reply.
  $('flow-answer-dot').classList.remove('is-ready');
  $('flow-answer-dot').parentElement.title = 'Comprueba la respuesta y su guardado en la Arena';
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
      showToast(enabled ? 'Permiso de inyección activado' : 'Pestaña en pausa');
    },
  );
});

function openSettings({ focusApiKey = false } = {}) {
  isSettingsOpen = true;
  setAgentPickerOpen(false);
  for (const id of VIEW_IDS) $(id).classList.add('hidden');
  $('asset-card').classList.add('hidden');
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
    showToast('Añade tu clave de Debatidor para continuar', true);
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

// ------------------------------------------------------- asset rail
// Fallback manual del Media Rail out-of-band (ADR-0013). El popup pide la
// URL del ticket al service worker y hace el PUT él mismo; el token nunca
// aparece en la UI ni en el chat.

let assetUploading = new Set();

function sendRuntime(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response ?? null);
    });
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function assetStateLabel(ticket) {
  if (ticket.state === 'done') return 'Subido';
  if (ticket.state === 'failed') return ticket.retryable ? `Falló: ${ticket.lastError ?? ''}` : `Ticket consumido: ${ticket.lastError ?? ''}`;
  if (ticket.state === 'dispatched') return 'Buscando el archivo en el chat…';
  return 'Esperando una pestaña vinculada';
}

function renderAssetTickets(status) {
  const card = $('asset-card');
  const list = $('asset-list');
  if (!card || !list) return;
  const tickets = Array.isArray(status?.assetTickets) ? status.assetTickets : [];
  card.classList.toggle('hidden', isSettingsOpen || tickets.length === 0);
  $('asset-count').textContent = String(tickets.length);
  list.replaceChildren();
  for (const ticket of tickets) {
    const row = document.createElement('div');
    row.className = `asset-item is-${ticket.state}`;
    row.setAttribute('role', 'listitem');

    const copy = document.createElement('div');
    copy.className = 'asset-copy';
    const name = document.createElement('strong');
    name.textContent = ticket.fileName;
    const meta = document.createElement('small');
    const parts = [ticket.path];
    if (ticket.expectedBytes) parts.push(formatBytes(ticket.expectedBytes));
    meta.textContent = parts.join(' · ');
    const state = document.createElement('span');
    state.className = 'asset-state';
    state.textContent = assetStateLabel(ticket);
    copy.append(name, meta, state);
    row.appendChild(copy);

    if (ticket.retryable && !assetUploading.has(ticket.ticketId)) {
      const label = document.createElement('label');
      label.className = 'button button--primary asset-upload';
      const text = document.createElement('span');
      text.textContent = ticket.state === 'failed' ? 'Reintentar a mano' : 'Subir a mano';
      const input = document.createElement('input');
      input.type = 'file';
      input.className = 'sr-only';
      input.setAttribute('aria-label', `Elegir archivo para ${ticket.fileName}`);
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (file) void manualUpload(ticket, file);
      });
      label.append(text, input);
      row.appendChild(label);
    } else if (assetUploading.has(ticket.ticketId)) {
      const busy = document.createElement('span');
      busy.className = 'asset-busy';
      busy.textContent = 'Subiendo…';
      row.appendChild(busy);
    }
    list.appendChild(row);
  }
}

async function manualUpload(ticket, file) {
  const transport = globalThis.__debatidorAssetTransport;
  if (!transport) {
    showToast('Transporte no disponible', true);
    return;
  }
  if (ticket.expectedBytes && file.size !== ticket.expectedBytes) {
    showToast(`Tamaño distinto: ${formatBytes(file.size)} vs ${formatBytes(ticket.expectedBytes)} esperados`, true);
    return;
  }
  const answer = await sendRuntime({ type: 'asset-ticket-url', ticketId: ticket.ticketId });
  if (!answer?.ok) {
    showToast(answer?.reason === 'ticket_not_retryable' ? 'Ese ticket ya fue usado: crea uno nuevo' : 'Ticket no disponible', true);
    void refresh();
    return;
  }
  assetUploading.add(ticket.ticketId);
  renderAssetTickets(runtimeStatus);
  try {
    const result = await transport.putToRelay({ ...answer.ticket, uploadUrl: answer.uploadUrl }, file, { fetchImpl: fetch });
    await sendRuntime({ type: 'asset-manual-result', ticketId: ticket.ticketId, ok: true, bytes: result.bytes, sha256: result.sha256 });
    showToast(`${ticket.fileName} subido (${formatBytes(result.bytes)})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sendRuntime({ type: 'asset-manual-result', ticketId: ticket.ticketId, ok: false, error: message });
    showToast(`No se pudo subir: ${message}`, true);
  } finally {
    assetUploading.delete(ticket.ticketId);
    void refresh();
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
