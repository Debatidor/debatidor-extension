const DEFAULTS = {
  backendUrl: 'ws://localhost:3001/extension',
  connectionId: 'conn_dom_qwen_01',
  debateId: '',
  apiKey: '',
};

const OUTBOUND = new Set(['extension.dom_status', 'extension.dom_delta']);

let socket = null;
let tabs = new Map();
let reconnectTimer = 0;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'debatidor-tab') {
    return;
  }
  const tabId = port.sender?.tab?.id;
  if (tabId == null) {
    return;
  }
  tabs.set(tabId, port);
  loadConfig().then((config) => {
    port.postMessage({
      type: 'config',
      connectionId: config.connectionId,
      debateId: config.debateId,
    });
  });
  port.onMessage.addListener((msg) => {
    if (msg?.type !== 'wire' || socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    const event = msg.payload?.event;
    if (!OUTBOUND.has(event)) {
      return;
    }
    socket.send(JSON.stringify(msg.payload));
  });
  port.onDisconnect.addListener(() => tabs.delete(tabId));
  void ensureSocket();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'save-config') {
    chrome.storage.local.set(msg.config).then(() => {
      reconnect();
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg?.type === 'status') {
    loadConfig().then((config) => {
      sendResponse({
        socket: socket?.readyState === WebSocket.OPEN ? 'open' : 'closed',
        hasKey: Boolean(config.apiKey),
        tabs: [...tabs.keys()],
      });
    });
    return true;
  }
  return false;
});

async function loadConfig() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

async function ensureSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const config = await loadConfig();
  if (!config.apiKey) {
    return;
  }
  const url = new URL(config.backendUrl);
  url.searchParams.set('connectionId', config.connectionId);
  if (config.debateId) {
    url.searchParams.set('debateId', config.debateId);
  }
  // Chrome WebSocket() cannot set x-api-key. The backend accepts apiKey in the handshake query.
  url.searchParams.set('apiKey', config.apiKey);
  socket = new WebSocket(url);
  socket.addEventListener('open', () => {
    broadcast({ type: 'config', connectionId: config.connectionId, debateId: config.debateId });
  });
  socket.addEventListener('message', (raw) => {
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
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      void ensureSocket();
    }, 2000);
  });
}

function reconnect() {
  clearTimeout(reconnectTimer);
  socket?.close();
  socket = null;
  void ensureSocket();
}

function broadcast(msg) {
  for (const port of tabs.values()) {
    try {
      port.postMessage(msg);
    } catch {
      /* tab gone */
    }
  }
}
