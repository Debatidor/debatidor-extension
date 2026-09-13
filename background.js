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

const OUTBOUND = new Set(['extension.dom_status', 'extension.dom_delta', 'extension.asset_result']);
const PORT_NAME = 'debatidor-tab';
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const HEARTBEAT_MS = 25000;
// Matches the Hub's freshness window. Cached status never generates a heartbeat.
const PRESENCE_FRESH_MS = 30000;
// Media Rail out-of-band (ADR-0013): tickets de subida recibidos por el socket.
const ASSET_TICKET_RE = /^tkt_[a-f0-9]{24}$/;
const ASSET_SETTLED_RETENTION_MS = 5 * 60 * 1000;
const ASSET_DEFAULT_TTL_MS = 15 * 60 * 1000;

let socket = null;
/** @type {Map<number, chrome.runtime.Port>} */
const tabs = new Map();
// Only fresh, consented status actually sent over this socket is recorded.
const enabledPresence = new Map();
/**
 * Tickets de subida pendientes, por ticketId. Solo en memoria del SW: un
 * ticket es de un solo uso y con TTL corto, no tiene sentido persistirlo.
 * state: pending (sin pestaña con consentimiento) | dispatched | done | failed.
 * @type {Map<string, Record<string, unknown>>}
 */
const assetTickets = new Map();
let socketRetryTimer = 0;
let socketAttempts = 0;
let heartbeatTimer = 0;
let lastSocketActivityAt = 0;

// ------------------------------------------------------------------ ports

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  const tabId = port.sender?.tab?.id;
  if (tabId == null) return;

  // BFCache y algunos restores pueden crear un Port nuevo antes de que llegue
  // el onDisconnect del anterior. Nunca dejar que ese callback viejo borre el
  // Port recién conectado de la misma pestaña.
  const previous = tabs.get(tabId);
  if (previous && previous !== port) {
    try {
      previous.disconnect();
    } catch {
      /* ya estaba cerrado */
    }
  }
  tabs.set(tabId, port);
  enabledPresence.delete(tabId);
  pushConfig(tabId, port);
  // Una pestaña que llega tarde (reload, BFCache) recibe los tickets que
  // todavía nadie pudo atender.
  void redeliverPendingAssetTickets(tabId, port);

  port.onMessage.addListener((msg) => {
    if (tabs.get(tabId) !== port) return;
    if (msg?.type === 'ping') return; // keep-alive: receiving resets the SW idle timer
    if (msg?.type !== 'wire') return;
    const payload = msg.payload;
    if (!payload || !OUTBOUND.has(payload.event)) return;
    void relay(tabId, payload, port);
  });

  port.onDisconnect.addListener(() => {
    // Chrome expone aquí runtime.lastError cuando el Port se cierra porque la
    // página entra al back/forward cache. Leerlo evita "Unchecked ...".
    void chrome.runtime.lastError;
    if (tabs.get(tabId) === port) {
      tabs.delete(tabId);
      enabledPresence.delete(tabId);
    }
  });
  void ensureSocket();
});

async function relay(tabId, payload, sourcePort) {
  const enabled = await isEnabled(tabId);
  if (tabs.get(tabId) !== sourcePort) return;
  // Per-tab consent: captured deltas require the popup toggle to be ON.
  if (payload.event === 'extension.dom_delta' && !enabled) return;
  if (payload.event === 'extension.asset_result') {
    // Solo una pestaña con consentimiento pudo recibir el ticket; su resultado
    // actualiza el estado local antes de reportarlo al Hub.
    if (!enabled) return;
    const data = payload.data;
    if (!data || typeof data.ticketId !== 'string') return;
    settleAssetTicket(data.ticketId, data);
  }
  if (socket?.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  let presence;
  if (payload.event === 'extension.dom_status') {
    const data = payload.data;
    if (!data || typeof data.connectionId !== 'string') return;
    const injectionEnabled = enabled && data.injectionEnabled === true;
    payload = { ...payload, data: { ...data, injectionEnabled } };
    const key = JSON.stringify([data.connectionId, data.debateId ?? null]);
    enabledPresence.delete(tabId);
    for (const [otherTabId, previous] of enabledPresence) {
      if (!tabs.has(otherTabId) || now - previous.observedAt >= PRESENCE_FRESH_MS) {
        enabledPresence.delete(otherTabId);
        continue;
      }
      // An unlinked tab must not pause the linked tab of the same provider/room.
      // Suppress this report; do not replay the other tab's cached state.
      if (!injectionEnabled && previous.key === key) return;
    }
    if (injectionEnabled) presence = { key, observedAt: now };
  }
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    return;
  }
  if (presence) enabledPresence.set(tabId, presence);
  lastSocketActivityAt = now;
}

function pushConfig(tabId, port) {
  Promise.all([loadConfig(), isEnabled(tabId)]).then(([config, enabled]) => {
    safePost(port, {
      type: 'config',
      // `connectionId` aquí identifica el socket MV3, no el host concreto.
      // content.js preserva la identidad declarada por su HostAdapter.
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
      // Revocation immediately stops this tab from suppressing sibling reports.
      // A fresh content-script status will report the pause; never fabricate one.
      enabledPresence.delete(tabId);
      const port = tabs.get(tabId);
      if (port) pushConfig(tabId, port);
      // Consentimiento recién concedido: entregar lo que quedó esperando.
      if (enabled && port) await redeliverPendingAssetTickets(tabId, port);
      sendResponse({ ok: true, enabled });
    });
    return true;
  }

  if (msg?.type === 'status') {
    loadConfig().then((config) => {
      pruneAssetTickets();
      sendResponse({
        socket: socket?.readyState === WebSocket.OPEN ? 'open' : 'closed',
        hasKey: Boolean(config.apiKey),
        backendUrl: config.backendUrl,
        debateId: config.debateId,
        tabs: [...tabs.keys()],
        assetTickets: listAssetTickets(),
      });
    });
    return true;
  }

  // Popup (fallback manual): pide la URL del ticket para hacer el PUT él mismo.
  // La URL nunca sale del proceso de la extensión.
  if (msg?.type === 'asset-ticket-url') {
    pruneAssetTickets();
    const ticket = assetTickets.get(String(msg.ticketId ?? ''));
    if (!ticket || !isTicketRetryable(ticket)) {
      sendResponse({ ok: false, reason: ticket ? 'ticket_not_retryable' : 'ticket_not_found' });
      return false;
    }
    sendResponse({ ok: true, uploadUrl: ticket.uploadUrl, ticket: publicAssetTicket(ticket) });
    return false;
  }

  if (msg?.type === 'asset-manual-result') {
    const ticketId = String(msg.ticketId ?? '');
    const ticket = assetTickets.get(ticketId);
    if (!ticket) {
      sendResponse({ ok: false, reason: 'ticket_not_found' });
      return false;
    }
    const data = {
      ticketId,
      connectionId: 'popup',
      debateId: ticket.debateId ?? null,
      ok: Boolean(msg.ok),
      bytes: Number.isSafeInteger(msg.bytes) ? msg.bytes : undefined,
      sha256: typeof msg.sha256 === 'string' ? msg.sha256 : undefined,
      error: msg.ok ? null : String(msg.error ?? 'manual_upload_failed').slice(0, 160),
      via: 'manual',
      hostId: 'popup',
    };
    settleAssetTicket(ticketId, data);
    const sent = sendWire({ event: 'extension.asset_result', data });
    sendResponse({ ok: true, reported: sent });
    return false;
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

// ------------------------------------------------------- asset tickets

/**
 * Sanea el evento del Hub antes de guardarlo o reenviarlo. Devuelve null si
 * falta lo mínimo (ticketId, uploadUrl http(s), fileName) o si ya expiró.
 */
function sanitizeAssetTicket(data) {
  if (!data || typeof data !== 'object') return null;
  const ticketId = String(data.ticketId ?? '').trim();
  const fileName = String(data.fileName ?? '').trim();
  if (!ASSET_TICKET_RE.test(ticketId) || !fileName) return null;
  let url;
  try {
    url = new URL(String(data.uploadUrl ?? ''));
  } catch {
    return null;
  }
  const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost)) return null;
  const parsedExpiry = Date.parse(String(data.expiresAt ?? ''));
  const expiresAtMs = Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now() + ASSET_DEFAULT_TTL_MS;
  if (expiresAtMs <= Date.now()) return null;
  const optionalString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const positiveInt = (value) => (Number.isSafeInteger(value) && value > 0 ? value : undefined);
  return {
    ticketId,
    uploadUrl: url.toString(),
    fileName,
    path: optionalString(data.path) ?? fileName,
    expectedBytes: positiveInt(data.expectedBytes),
    expectedSha256: optionalString(data.expectedSha256),
    mimeType: optionalString(data.mimeType),
    maxBytes: positiveInt(data.maxBytes),
    expiresAt: new Date(expiresAtMs).toISOString(),
    connectionId: optionalString(data.connectionId),
    debateId: optionalString(data.debateId),
    source: optionalString(data.source),
  };
}

function ticketMessage(ticket) {
  return {
    type: 'asset_ticket',
    ticketId: ticket.ticketId,
    uploadUrl: ticket.uploadUrl,
    fileName: ticket.fileName,
    path: ticket.path,
    expectedBytes: ticket.expectedBytes,
    expectedSha256: ticket.expectedSha256,
    mimeType: ticket.mimeType,
    maxBytes: ticket.maxBytes,
    expiresAt: ticket.expiresAt,
    connectionId: ticket.connectionId,
    debateId: ticket.debateId,
    source: ticket.source,
  };
}

/** Vista para el popup: sin uploadUrl. */
function publicAssetTicket(ticket) {
  return {
    ticketId: ticket.ticketId,
    fileName: ticket.fileName,
    path: ticket.path,
    expectedBytes: ticket.expectedBytes,
    mimeType: ticket.mimeType,
    maxBytes: ticket.maxBytes,
    expiresAt: ticket.expiresAt,
    connectionId: ticket.connectionId,
    debateId: ticket.debateId,
    state: ticket.state,
    lastError: ticket.lastError ?? null,
    retryable: isTicketRetryable(ticket),
    receivedAt: ticket.receivedAt,
  };
}

function isExpiredTicket(ticket, now = Date.now()) {
  const at = Date.parse(String(ticket?.expiresAt ?? ''));
  return Number.isFinite(at) && at <= now;
}

/**
 * Un ticket sigue siendo utilizable a mano mientras nadie haya reclamado el
 * token: pendiente, despachado sin resultado, o fallido ANTES del PUT
 * (host_unsupported, download_not_found, size_mismatch…). Un relay_http_* ya
 * consumió el token: hace falta un ticket nuevo.
 */
function isTicketRetryable(ticket) {
  if (!ticket || isExpiredTicket(ticket)) return false;
  if (ticket.state === 'pending' || ticket.state === 'dispatched') return true;
  if (ticket.state === 'failed') {
    const error = String(ticket.lastError ?? '');
    return !error.startsWith('relay_http_') && !error.startsWith('relay_unreachable');
  }
  return false;
}

function pruneAssetTickets() {
  const now = Date.now();
  for (const [ticketId, ticket] of assetTickets) {
    if (isExpiredTicket(ticket, now)) {
      assetTickets.delete(ticketId);
      continue;
    }
    if (ticket.settledAt && now - ticket.settledAt >= ASSET_SETTLED_RETENTION_MS) {
      assetTickets.delete(ticketId);
    }
  }
}

function listAssetTickets() {
  return [...assetTickets.values()]
    .sort((a, b) => (b.receivedAt ?? 0) - (a.receivedAt ?? 0))
    .map(publicAssetTicket);
}

function settleAssetTicket(ticketId, result) {
  const ticket = assetTickets.get(ticketId);
  if (!ticket) return;
  ticket.settledAt = Date.now();
  if (result?.ok) {
    ticket.state = 'done';
    ticket.lastError = null;
    ticket.bytes = result.bytes;
    ticket.sha256 = result.sha256;
  } else {
    ticket.state = 'failed';
    ticket.lastError = String(result?.error ?? 'unknown').slice(0, 160);
  }
}

/** Entrega a todas las pestañas con consentimiento; cuenta entregas reales. */
async function dispatchAssetTicket(ticket, sourceSocket) {
  let delivered = 0;
  for (const [tabId, port] of tabs) {
    if (!(await isEnabled(tabId))) continue;
    if (sourceSocket && socket !== sourceSocket) return delivered;
    if (tabs.get(tabId) !== port) continue;
    if (safePost(port, ticketMessage(ticket))) delivered += 1;
    else if (tabs.get(tabId) === port) {
      tabs.delete(tabId);
      enabledPresence.delete(tabId);
    }
  }
  if (delivered > 0 && ticket.state === 'pending') ticket.state = 'dispatched';
  return delivered;
}

async function redeliverPendingAssetTickets(tabId, port) {
  pruneAssetTickets();
  const pending = [...assetTickets.values()].filter((ticket) => ticket.state === 'pending');
  if (!pending.length) return;
  if (!(await isEnabled(tabId))) return;
  if (tabs.get(tabId) !== port) return;
  for (const ticket of pending) {
    if (safePost(port, ticketMessage(ticket))) ticket.state = 'dispatched';
  }
}

function sendWire(payload) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    lastSocketActivityAt = Date.now();
    return true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------- websocket

async function ensureSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const config = await loadConfig();
  if (!config.apiKey || !config.backendUrl) return;
  // Another port can finish loading configuration while this await is pending.
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  const url = new URL(config.backendUrl);
  url.searchParams.set('connectionId', config.connectionId);
  if (config.debateId) url.searchParams.set('debateId', config.debateId);
  // Browsers cannot set x-api-key on a WebSocket handshake; the gateway
  // accepts the key as a query parameter instead.
  url.searchParams.set('apiKey', config.apiKey);

  const currentSocket = new WebSocket(url);
  socket = currentSocket;
  lastSocketActivityAt = Date.now();

  currentSocket.addEventListener('open', () => {
    if (socket !== currentSocket) return;
    enabledPresence.clear();
    socketAttempts = 0;
    startHeartbeat();
    // Reenviar config fuerza a cada content script a reafirmar su estado
    // actual. Así un websocket nuevo nunca hereda un `generating` huérfano.
    for (const [tabId, port] of tabs) pushConfig(tabId, port);
  });

  currentSocket.addEventListener('message', (raw) => {
    if (socket !== currentSocket) return;
    lastSocketActivityAt = Date.now();
    let parsed;
    try {
      parsed = JSON.parse(String(raw.data));
    } catch {
      return;
    }
    if (parsed.event === 'extension.dom_prompt') {
      // CRÍTICO multi-host: conservar connectionId para que content.js pueda
      // ignorar prompts destinados a otra pestaña (Qwen vs ChatGPT, etc.).
      void broadcast({
        type: 'dom_prompt',
        connectionId: parsed.data?.connectionId,
        debateId: parsed.data?.debateId,
        turnId: parsed.data?.turnId,
        systemPreamble: parsed.data?.systemPreamble,
        promptText: parsed.data?.promptText,
      }, currentSocket);
      return;
    }
    if (parsed.event === 'extension.asset_ticket') {
      const ticket = sanitizeAssetTicket(parsed.data);
      if (!ticket) return;
      pruneAssetTickets();
      const stored = { ...ticket, state: 'pending', receivedAt: Date.now(), lastError: null };
      assetTickets.set(ticket.ticketId, stored);
      void dispatchAssetTicket(stored, currentSocket);
    }
  });

  currentSocket.addEventListener('close', () => {
    if (socket !== currentSocket) return;
    socket = null;
    enabledPresence.clear();
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
  const previousSocket = socket;
  socket = null;
  enabledPresence.clear();
  previousSocket?.close();
  void ensureSocket();
}

async function broadcast(msg, sourceSocket) {
  for (const [tabId, port] of tabs) {
    if (msg.type === 'dom_prompt' && !(await isEnabled(tabId))) continue;
    if (socket !== sourceSocket) return;
    if (tabs.get(tabId) !== port) continue;
    if (!safePost(port, msg) && tabs.get(tabId) === port) {
      tabs.delete(tabId);
      enabledPresence.delete(tabId);
    }
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
