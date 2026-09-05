import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

test('background preserves the room and a stale close cannot replace the current socket', async () => {
  const sockets = [], forwarded = [];
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 0; handlers = {};
    constructor() { sockets.push(this); }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    close() { this.readyState = 3; }
    send() {}
  }
  const context = vm.createContext({
    URL, WebSocket: Socket, console,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    chrome: {
      runtime: { onConnect: { addListener() {} }, onMessage: { addListener() {} } },
      storage: {
        local: { get: async () => ({ apiKey: 'fixture', backendUrl: 'wss://test.invalid/extension', debateId: 'room-a' }) },
        session: { get: async () => ({ 'injection:7': true }) },
      },
    },
    fixturePort: { postMessage: (msg) => forwarded.push(msg) },
  });
  vm.runInContext(readFileSync(new URL('../background.js', import.meta.url), 'utf8'), context);
  await vm.runInContext('Promise.all([ensureSocket(), ensureSocket()])', context);
  assert.equal(sockets.length, 1);
  vm.runInContext('tabs.set(7, fixturePort); reconnect()', context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets.length, 2);
  sockets[0].handlers.close();
  assert.equal(vm.runInContext('socket', context), sockets[1]);
  const event = { data: JSON.stringify({ event: 'extension.dom_prompt', data: { debateId: 'room-a', connectionId: 'conn_dom_qwen', turnId: 't', promptText: 'test' } }) };
  sockets[0].handlers.message(event);
  assert.equal(forwarded.length, 0);
  sockets[1].handlers.message(event);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(forwarded[0].debateId, 'room-a');
  assert.equal(forwarded[0].connectionId, 'conn_dom_qwen');
});
