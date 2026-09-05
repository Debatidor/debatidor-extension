import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  let now = 1000, onConnect, onMessage;
  const sockets = [], sent = [], consent = {};
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 0; handlers = {};
    constructor() { sockets.push(this); }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    send(payload) { sent.push(JSON.parse(payload)); }
    close() { this.readyState = 3; this.handlers.close?.(); }
  }
  const context = vm.createContext({
    URL, WebSocket: Socket, console, Date: { now: () => now },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    chrome: {
      runtime: {
        onConnect: { addListener(fn) { onConnect = fn; } },
        onMessage: { addListener(fn) { onMessage = fn; } },
      },
      storage: {
        local: { get: async () => ({ apiKey: 'fixture', backendUrl: 'wss://test.invalid/extension', debateId: 'room-a' }) },
        session: {
          get: async (key) => ({ [key]: consent[key] }),
          set: async (value) => { Object.assign(consent, value); },
        },
      },
    },
  });
  vm.runInContext(source, context);
  return {
    sent,
    async tab(id, enabled) {
      consent[`injection:${id}`] = enabled;
      const incoming = [], handlers = {};
      const port = {
        name: 'debatidor-tab', sender: { tab: { id } }, incoming,
        postMessage: (message) => incoming.push(message),
        onMessage: { addListener(fn) { handlers.message = fn; } },
        onDisconnect: { addListener(fn) { handlers.disconnect = fn; } },
        disconnect() { handlers.disconnect(); },
        async report(enabledStatus, connectionId = 'conn_dom_qwen', debateId = 'room-a') {
          handlers.message({ type: 'wire', payload: {
            event: 'extension.dom_status', data: { connectionId, debateId, status: 'waiting', injectionEnabled: enabledStatus },
          } });
          await settle();
        },
        async delta() {
          handlers.message({ type: 'wire', payload: { event: 'extension.dom_delta', data: { contentDelta: 'fixture' } } });
          await settle();
        },
      };
      onConnect(port);
      await settle();
      return port;
    },
    async open() {
      const socket = sockets.at(-1);
      socket.readyState = Socket.OPEN;
      socket.handlers.open();
      await settle();
    },
    async toggle(tabId, enabled) {
      await new Promise((resolve) => onMessage({ type: 'toggle-injection', tabId, enabled }, {}, resolve));
      await settle();
    },
    async prompt() {
      sockets.at(-1).handlers.message({ data: JSON.stringify({
        event: 'extension.dom_prompt', data: { connectionId: 'conn_dom_qwen', debateId: 'room-a', promptText: 'fixture' },
      }) });
      await settle();
    },
    async reconnect() {
      vm.runInContext('reconnect()', context);
      await settle();
      await this.open();
    },
    advance(milliseconds) { now += milliseconds; },
  };
}

test('a disabled sibling cannot pause fresh enabled presence or refresh it from cache', async () => {
  const h = harness();
  const owner = await h.tab(1, true), sibling = await h.tab(2, false);
  await h.open();
  await owner.report(true);
  await sibling.report(false);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].data.injectionEnabled, true);

  h.advance(20_000);
  await sibling.report(false);
  assert.equal(h.sent.length, 1, 'suppression must not publish a cached heartbeat');
  h.advance(10_000);
  await sibling.report(false);
  assert.equal(h.sent.length, 2, 'the original enabled signal expires after 30 seconds');
  assert.equal(h.sent[1].data.injectionEnabled, false);
});

test('revoking the owner allows fresh paused reports and never manufactures a status', async () => {
  const h = harness();
  const owner = await h.tab(1, true), sibling = await h.tab(2, false);
  await h.open();
  await owner.report(true);
  await h.toggle(1, false);
  assert.equal(h.sent.length, 1);
  await sibling.report(false);
  assert.equal(h.sent.length, 2);
  await owner.report(true);
  assert.equal(h.sent.at(-1).data.injectionEnabled, false, 'stale content-script consent cannot override a revoked toggle');
});

test('a disconnected owner stops suppressing siblings without sending cached state', async () => {
  const h = harness();
  const owner = await h.tab(1, true), sibling = await h.tab(2, false);
  await h.open();
  await owner.report(true);
  owner.disconnect();
  assert.equal(h.sent.length, 1);
  await sibling.report(false);
  assert.equal(h.sent.length, 2);
  await owner.report(true);
  assert.equal(h.sent.length, 2, 'an old port cannot revive its presence');
});

test('different rooms and providers do not suppress each other', async () => {
  const h = harness();
  const owner = await h.tab(1, true), sibling = await h.tab(2, false);
  await h.open();
  await owner.report(true);
  await sibling.report(false, 'conn_dom_qwen', 'room-b');
  await sibling.report(false, 'conn_dom_openai', 'room-a');
  assert.equal(h.sent.length, 3);
  assert.equal(h.sent[1].data.debateId, 'room-b');
  assert.equal(h.sent[2].data.connectionId, 'conn_dom_openai');
});

test('a late old-port disconnect cannot remove the replacement tab or its fresh presence', async () => {
  const h = harness();
  const previous = await h.tab(1, true), sibling = await h.tab(2, false);
  await h.open();
  await previous.report(true);
  const replacement = await h.tab(1, true);
  await replacement.report(true);
  previous.disconnect();
  await previous.report(false);
  await sibling.report(false);
  assert.equal(h.sent.length, 2);
  await replacement.delta();
  assert.equal(h.sent.at(-1).event, 'extension.dom_delta');
});

test('disabled tabs receive no prompt and emit no captured delta', async () => {
  const h = harness();
  const owner = await h.tab(1, true), sibling = await h.tab(2, false);
  await h.open();
  await h.prompt();
  assert.equal(owner.incoming.filter((message) => message.type === 'dom_prompt').length, 1);
  assert.equal(sibling.incoming.filter((message) => message.type === 'dom_prompt').length, 0);
  await sibling.delta();
  assert.equal(h.sent.length, 0);
});

test('a replacement socket requires fresh enabled presence before suppressing a sibling', async () => {
  const h = harness();
  const owner = await h.tab(1, true), sibling = await h.tab(2, false);
  await h.open();
  await owner.report(true);
  await h.reconnect();
  assert.equal(h.sent.length, 1);
  await sibling.report(false);
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent.at(-1).data.injectionEnabled, false);
});
