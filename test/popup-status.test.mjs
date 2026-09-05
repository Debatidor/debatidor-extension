import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');

async function harness({ enabled = true, socket = 'open', tabs = [7], debateId = 'deb_room' } = {}) {
  const elements = new Map();
  function element() {
    const classes = new Set();
    return {
      textContent: '', value: '', dataset: {}, listeners: {}, parentElement: {},
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
        toggle(name, force) {
          const include = force ?? !classes.has(name);
          if (include) classes.add(name);
          else classes.delete(name);
          return include;
        },
      },
      append() {}, appendChild() {}, replaceChildren() {}, setAttribute() {},
      addEventListener(name, handler) { this.listeners[name] = handler; },
    };
  }
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const status = { socket, tabs, debateId, hasKey: true };
  const context = {
    URL,
    document: {
      getElementById: get,
      createElement: element,
      createElementNS: element,
      addEventListener() {},
    },
    chrome: {
      runtime: {
        getManifest: () => ({ version: '0.4.7' }),
        sendMessage(message, callback) {
          if (message.type === 'status') callback(status);
        },
      },
      tabs: { query: async () => [{ id: 7, url: 'https://chat.qwen.ai/' }] },
      storage: {
        local: { get: async () => ({ apiKey: 'fixture', debateId, connectionId: 'conn_dom' }) },
        session: { get: async () => ({ 'injection:7': enabled }) },
      },
    },
    setInterval() {}, setTimeout() {}, clearTimeout() {},
  };
  context.window = context;
  vm.runInNewContext(source, context);
  await new Promise((resolve) => setImmediate(resolve));
  return { get, status, refresh: () => vm.runInNewContext('refresh()', context) };
}

test('consent and a live socket do not claim that an answer has been captured or saved', async () => {
  const h = await harness();
  assert.equal(h.get('ws-label').textContent, 'Hub conectado');
  assert.equal(h.get('flow-hub-dot').classList.contains('is-ready'), true);
  assert.equal(h.get('flow-tab-dot').classList.contains('is-ready'), true);
  assert.equal(h.get('flow-answer-dot').classList.contains('is-ready'), false);
  assert.equal(h.get('toggle-hint').textContent, 'Permiso activo · esperando turnos');
  assert.equal(h.get('room-hint').textContent, 'Sala configurada: deb_room');

  h.status.socket = 'closed';
  await h.refresh();
  assert.equal(h.get('flow-hub-dot').classList.contains('is-ready'), false);
  assert.equal(h.get('toggle-hint').textContent, 'Permiso activo · esperando al Hub');
});

test('an enabled toggle with a missing content-script port asks to reload the tab', async () => {
  const h = await harness({ tabs: [] });
  assert.equal(h.get('inject-toggle').checked, true);
  assert.equal(h.get('flow-tab-dot').classList.contains('is-ready'), false);
  assert.equal(h.get('flow-answer-dot').classList.contains('is-ready'), false);
  assert.equal(h.get('toggle-hint').textContent, 'Permiso activo · recarga esta pestaña');
});

test('paused and unbound tabs remain available without claiming an Arena connection', async () => {
  const h = await harness({ enabled: false, debateId: '' });
  assert.equal(h.get('inject-toggle').checked, false);
  assert.equal(h.get('flow-tab-dot').classList.contains('is-ready'), false);
  assert.equal(h.get('flow-answer-dot').classList.contains('is-ready'), false);
  assert.equal(h.get('toggle-hint').textContent, 'La extensión está en pausa');
  assert.equal(h.get('room-hint').textContent, 'Sin sala fija. Para usar una Arena, pega su ID en Ajustes.');
  assert.equal(h.get('debateId').value, '');
  assert.equal(h.get('connectionId').value, 'conn_dom');
});
