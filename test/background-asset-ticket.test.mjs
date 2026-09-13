import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const TICKET_ID = 'tkt_0123456789abcdef01234567';
const UPLOAD_URL = `https://api.test/asset-relay/upload/art_${'a'.repeat(48)}`;

function ticketEvent(overrides = {}) {
  return {
    event: 'extension.asset_ticket',
    data: {
      ticketId: TICKET_ID,
      direction: 'upload',
      uploadUrl: UPLOAD_URL,
      methods: ['PUT', 'POST'],
      path: 'media/render.png',
      fileName: 'render.png',
      expectedBytes: 4096,
      mimeType: 'image/png',
      maxBytes: 268435456,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      connectionId: 'conn_dom_claude',
      source: 'mcp',
      ...overrides,
    },
  };
}

function makePort() {
  const port = { received: [], postMessage: (msg) => port.received.push(msg) };
  return port;
}

async function boot({ enabledTabs = [] } = {}) {
  const sockets = [];
  let messageListener = null;
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    handlers = {};
    sent = [];
    constructor() {
      sockets.push(this);
    }
    addEventListener(name, fn) {
      this.handlers[name] = fn;
    }
    close() {
      this.readyState = 3;
    }
    send(raw) {
      this.sent.push(JSON.parse(raw));
    }
  }
  const session = Object.fromEntries(enabledTabs.map((tabId) => [`injection:${tabId}`, true]));
  const context = vm.createContext({
    URL,
    WebSocket: Socket,
    console,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    chrome: {
      runtime: {
        onConnect: { addListener() {} },
        onMessage: {
          addListener(fn) {
            messageListener = fn;
          },
        },
      },
      storage: {
        local: { get: async () => ({ apiKey: 'fixture', backendUrl: 'wss://test.invalid/extension', debateId: '' }) },
        session: {
          get: async (key) => ({ [key]: Boolean(session[key]) }),
          set: async (patch) => Object.assign(session, patch),
        },
      },
    },
  });
  vm.runInContext(SOURCE, context);
  await vm.runInContext('ensureSocket()', context);
  const socket = sockets[0];
  socket.readyState = 1;
  socket.handlers.open();
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const message = (msg) =>
    new Promise((resolve) => {
      const keepAlive = messageListener(msg, {}, resolve);
      if (keepAlive === false) return;
    });
  return { context, socket, settle, message, session };
}

test('asset_ticket is stored, forwarded only to consented tabs, and exposed to the popup without its URL', async () => {
  const { context, socket, settle, message } = await boot({ enabledTabs: [7] });
  const consented = makePort();
  const paused = makePort();
  vm.runInContext('tabs.set(7, consentedPort); tabs.set(8, pausedPort)', Object.assign(context, { consentedPort: consented, pausedPort: paused }));

  socket.handlers.message({ data: JSON.stringify(ticketEvent()) });
  await settle();

  assert.equal(consented.received.length, 1);
  assert.equal(consented.received[0].type, 'asset_ticket');
  assert.equal(consented.received[0].ticketId, TICKET_ID);
  assert.equal(consented.received[0].uploadUrl, UPLOAD_URL);
  assert.equal(consented.received[0].fileName, 'render.png');
  assert.equal(consented.received[0].connectionId, 'conn_dom_claude');
  assert.equal(paused.received.length, 0);

  const status = await message({ type: 'status' });
  assert.equal(status.assetTickets.length, 1);
  assert.equal(status.assetTickets[0].state, 'dispatched');
  assert.equal(status.assetTickets[0].retryable, true);
  assert.equal('uploadUrl' in status.assetTickets[0], false);
  assert.equal(JSON.stringify(status).includes('art_'), false);
});

test('malformed, insecure or expired tickets are dropped before touching any tab', async () => {
  const { context, socket, settle, message } = await boot({ enabledTabs: [7] });
  const port = makePort();
  vm.runInContext('tabs.set(7, p)', Object.assign(context, { p: port }));

  socket.handlers.message({ data: JSON.stringify(ticketEvent({ uploadUrl: 'http://api.test/asset-relay/upload/x' })) });
  socket.handlers.message({ data: JSON.stringify(ticketEvent({ ticketId: 'tkt_short' })) });
  socket.handlers.message({ data: JSON.stringify(ticketEvent({ fileName: '   ' })) });
  socket.handlers.message({ data: JSON.stringify(ticketEvent({ expiresAt: new Date(Date.now() - 1000).toISOString() })) });
  socket.handlers.message({ data: JSON.stringify(ticketEvent({ uploadUrl: 'javascript:alert(1)' })) });
  await settle();
  assert.equal(port.received.length, 0);
  assert.equal((await message({ type: 'status' })).assetTickets.length, 0);

  // Localhost por http sí vale (entorno de desarrollo).
  socket.handlers.message({ data: JSON.stringify(ticketEvent({ uploadUrl: 'http://localhost:3001/asset-relay/upload/art_' + 'b'.repeat(48) })) });
  await settle();
  assert.equal(port.received.length, 1);
});

test('pending tickets are redelivered when a tab connects or gains consent, and asset_result settles them', async () => {
  const { context, socket, settle, message, session } = await boot({ enabledTabs: [] });
  socket.handlers.message({ data: JSON.stringify(ticketEvent()) });
  await settle();
  let status = await message({ type: 'status' });
  assert.equal(status.assetTickets[0].state, 'pending');

  // Una pestaña sin consentimiento no recibe nada al conectar.
  const late = makePort();
  vm.runInContext('tabs.set(9, latePort)', Object.assign(context, { latePort: late }));
  await vm.runInContext('redeliverPendingAssetTickets(9, latePort)', context);
  assert.equal(late.received.length, 0);

  // Al activar el toggle, el SW reentrega lo pendiente a esa pestaña.
  const toggled = await message({ type: 'toggle-injection', tabId: 9, enabled: true });
  assert.equal(toggled.ok, true);
  assert.equal(session['injection:9'], true);
  assert.equal(late.received.filter((m) => m.type === 'asset_ticket').length, 1);
  status = await message({ type: 'status' });
  assert.equal(status.assetTickets[0].state, 'dispatched');

  // El content script reporta el resultado: sale al Hub y el ticket queda cerrado.
  await vm.runInContext(
    `relay(9, { event: 'extension.asset_result', data: { ticketId: '${TICKET_ID}', connectionId: 'conn_dom_claude', ok: true, bytes: 4096, via: 'dom' } }, latePort)`,
    context,
  );
  const reported = socket.sent.find((m) => m.event === 'extension.asset_result');
  assert.ok(reported, 'asset_result reenviado al Hub');
  assert.equal(reported.data.ok, true);
  status = await message({ type: 'status' });
  assert.equal(status.assetTickets[0].state, 'done');
  assert.equal(status.assetTickets[0].retryable, false);
  const url = await message({ type: 'asset-ticket-url', ticketId: TICKET_ID });
  assert.equal(url.ok, false);
  assert.equal(url.reason, 'ticket_not_retryable');
});

test('a failure before the PUT keeps the ticket retryable by hand; a relay error does not', async () => {
  const { context, socket, settle, message } = await boot({ enabledTabs: [7] });
  const port = makePort();
  vm.runInContext('tabs.set(7, p)', Object.assign(context, { p: port }));
  socket.handlers.message({ data: JSON.stringify(ticketEvent()) });
  await settle();

  await vm.runInContext(
    `relay(7, { event: 'extension.asset_result', data: { ticketId: '${TICKET_ID}', ok: false, error: 'download_not_found', via: 'dom' } }, p)`,
    context,
  );
  let status = await message({ type: 'status' });
  assert.equal(status.assetTickets[0].state, 'failed');
  assert.equal(status.assetTickets[0].retryable, true);
  const url = await message({ type: 'asset-ticket-url', ticketId: TICKET_ID });
  assert.equal(url.ok, true);
  assert.equal(url.uploadUrl, UPLOAD_URL);
  assert.equal(url.ticket.fileName, 'render.png');

  // Subida manual desde el popup: se reporta como via=manual y cierra el ticket.
  const manual = await message({ type: 'asset-manual-result', ticketId: TICKET_ID, ok: true, bytes: 4096, sha256: 'e'.repeat(64) });
  assert.equal(manual.ok, true);
  assert.equal(manual.reported, true);
  const reported = socket.sent.filter((m) => m.event === 'extension.asset_result').pop();
  assert.equal(reported.data.via, 'manual');
  assert.equal(reported.data.connectionId, 'popup');
  status = await message({ type: 'status' });
  assert.equal(status.assetTickets[0].state, 'done');

  // Un relay_http_* significa token consumido: ya no se ofrece reintento.
  socket.handlers.message({ data: JSON.stringify(ticketEvent({ ticketId: 'tkt_ffffffffffffffffffffffff' })) });
  await settle();
  await vm.runInContext(
    "relay(7, { event: 'extension.asset_result', data: { ticketId: 'tkt_ffffffffffffffffffffffff', ok: false, error: 'relay_http_409:asset_relay_ticket_active', via: 'dom' } }, p)",
    context,
  );
  status = await message({ type: 'status' });
  const consumed = status.assetTickets.find((t) => t.ticketId === 'tkt_ffffffffffffffffffffffff');
  assert.equal(consumed.retryable, false);
});

test('asset_result from a tab without consent is ignored and never reaches the Hub', async () => {
  const { context, socket, settle } = await boot({ enabledTabs: [7] });
  const consented = makePort();
  const paused = makePort();
  vm.runInContext('tabs.set(7, a); tabs.set(8, b)', Object.assign(context, { a: consented, b: paused }));
  socket.handlers.message({ data: JSON.stringify(ticketEvent()) });
  await settle();
  await vm.runInContext(
    `relay(8, { event: 'extension.asset_result', data: { ticketId: '${TICKET_ID}', ok: true, via: 'dom' } }, b)`,
    context,
  );
  assert.equal(socket.sent.filter((m) => m.event === 'extension.asset_result').length, 0);
});
