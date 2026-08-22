const DEFAULTS = {
  backendUrl: 'ws://localhost:3001/extension',
  connectionId: 'conn_dom_qwen_01',
  debateId: '',
};

let socket = null;
let tabs = new Map();

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
    if (msg?.type === 'wire' && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg.payload));
    }
  });
  port.onDisconnect.addListener(() => tabs.delete(tabId));
  ensureSocket();
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
    sendResponse({
      socket: socket?.readyState === WebSocket.OPEN ? 'open' : 'closed',
      tabs: [...tabs.keys()],
    });
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
  const url = new URL(config.backendUrl);
  url.searchParams.set('connectionId', config.connectionId);
  if (config.debateId) {
    url.searchParams.set('debateId', config.debateId);
  }
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
    setTimeout(ensureSocket, 1500);
  });
}

function reconnect() {
  socket?.close();
  socket = null;
  ensureSocket();
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

ensureSocket();
