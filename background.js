// Debatidor — MV3 service worker.
// Owns the WebSocket to the Hub and bridges it to per-tab content-script ports.

const DEFAULTS = {
  backendUrl: 'wss://api.debatidor.com/extension',
  // Identidad de REGISTRO del socket (genérica): la identidad por proveedor
  // (conn_dom_qwen, conn_dom_openai, …) la declara cada host adapter y viaja
  // en el payload de dom_status/dom_delta.
  connectionId: 'conn_dom',
  debateId: '',
  apiKey: '',
};

const OUTBOUND = new Set(['extension.dom_status', 'extension.dom_delta']);
const PORT_NAME = 'debatidor-tab';
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const HEARTBEAT_MS = 25000;

let socket = null;
/** @type {Map<number, chrome.runtime.Port>} */
const tabs = new Map();
let socketRetryTimer = 0;
let socketAttempts = 0;
let heartbeatTimer = 0;
let lastSocketActivityAt = 0;

// ------------------------------------------------------------------ ports

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  const tabId = port.sender?.tab?.id;
  if (tabId == null) return;

  tabs.set(tabId, port);
  pushConfig(tabId, port);

  port.onMessage.addListener((msg) => {
    if (msg?.type === 'ping') return; // keep-alive: receiving resets the SW idle timer
    if (msg?.type !== 'wire') return;
    const payload = msg.payload;
    if (!payload || !OUTBOUND.has(payload.event)) return;
    void relay(tabId, payload);
  });

  port.onDisconnect.addListener(() => tabs.delete(tabId));
  void ensureSocket();
});

async function relay(tabId, payload) {
  // Per-tab consent: captured deltas require the popup toggle to be ON.
  if (payload.event === 'extension.dom_delta' && !(await isEnabled(tabId))) return;
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
  lastSocketActivityAt = Date.now();
}

function pushConfig(tabId, port) {
  Promise.all([loadConfig(), isEnabled(tabId)]).then(([config, enabled]) => {
    safePost(port, {
      type: 'config',
      connectionId: config.connectionId,
      debateId: config.debateId,
      enabled,
    });
  });
}

// --------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'save-config') {
    chrome.storage.local.set(msg.config).then(() => {
      reconnect();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg?.type === 'toggle-injection') {
    const tabId = Number(msg.tabId);
    const enabled = Boolean(msg.enabled);
    if (!Number.isFinite(tabId)) {
      sendResponse({ ok: false });
      return false;
    }
    chrome.storage.session.set({ [enabledKey(tabId)]: enabled }).then(async () => {
      const port = tabs.get(tabId);
      if (port) pushConfig(tabId, port);
      sendResponse({ ok: true, enabled });
    });
    return true;
  }

  if (msg?.type === 'status') {
    loadConfig().then((config) => {
      sendResponse({
        socket: socket?.readyState === WebSocket.OPEN ? 'open' : 'closed',
        hasKey: Boolean(config.apiKey),
        backendUrl: config.backendUrl,
        tabs: [...tabs.keys()],
      });
    });
    return true;
  }

  return false;
});

// ---------------------------------------------------------------- storage

const enabledKey = (tabId) => `injection:${tabId}`;

async function isEnabled(tabId) {
  const stored = await chrome.storage.session.get(enabledKey(tabId));
  return Boolean(stored[enabledKey(tabId)]);
}

async function loadConfig() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  // Migración: el default hardcodeado del P0 deja de ser válido.
  if (stored.connectionId === 'conn_dom_qwen_01') {
    stored.connectionId = DEFAULTS.connectionId;
  }
  return { ...DEFAULTS, ...stored };
}

// -------------------------------------------------------------- websocket

async function ensureSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const config = await loadConfig();
  if (!config.apiKey || !config.backendUrl) return;

  const url = new URL(config.backendUrl);
  url.searchParams.set('connectionId', config.connectionId);
  if (config.debateId) url.searchParams.set('debateId', config.debateId);
  // Browsers cannot set x-api-key on a WebSocket handshake; the gateway
  // accepts the key as a query parameter instead.
  url.searchParams.set('apiKey', config.apiKey);

  socket = new WebSocket(url);
  lastSocketActivityAt = Date.now();

  socket.addEventListener('open', () => {
    socketAttempts = 0;
    startHeartbeat();
    for (const [tabId, port] of tabs) pushConfig(tabId, port);
  });

  socket.addEventListener('message', (raw) => {
    lastSocketActivityAt = Date.now();
    let parsed;
    try {
      parsed = JSON.parse(String(raw.data));
    } catch {
      return;
    }
    if (parsed.event === 'extension.dom_prompt') {
      broadcast({
        type: 'dom_prompt',
        turnId: parsed.data?.turnId,
        systemPreamble: parsed.data?.systemPreamble,
        promptText: parsed.data?.promptText,
      });
    }
  });

  socket.addEventListener('close', () => {
    socket = null;
    stopHeartbeat();
    // Exponential backoff so a down backend doesn't get hammered.
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** socketAttempts++);
    clearTimeout(socketRetryTimer);
    socketRetryTimer = setTimeout(() => void ensureSocket(), delay);
  });
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    // Chrome 116+ keeps an MV3 worker alive while its WebSocket sees traffic.
    // This guarantees traffic even when the room is silent; the gateway
    // ignores unknown events.
    if (socket?.readyState === WebSocket.OPEN && Date.now() - lastSocketActivityAt >= HEARTBEAT_MS) {
      try {
        socket.send(JSON.stringify({ event: 'ping' }));
      } catch {
        /* the close handler takes over */
      }
    }
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = 0;
}

function reconnect() {
  clearTimeout(socketRetryTimer);
  stopHeartbeat();
  socket?.close();
  socket = null;
  void ensureSocket();
}

function broadcast(msg) {
  for (const [tabId, port] of tabs) {
    if (!safePost(port, msg)) tabs.delete(tabId);
  }
}

function safePost(port, msg) {
  try {
    port.postMessage(msg);
    return true;
  } catch {
    return false; // receiver gone; onDisconnect cleans up the map
  }
}
