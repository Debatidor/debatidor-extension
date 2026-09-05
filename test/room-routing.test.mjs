import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../content.js', import.meta.url), 'utf8');

function harness() {
  let now = 1000, status = 'waiting', answer = '', key = 'old';
  let listener;
  const output = [], injected = [], timers = new Map();
  let nextTimer = 0;
  const schedule = (fn, delay) => { timers.set(++nextTimer, { fn, at: now + delay }); return nextTimer; };
  let tick;
  const port = { postMessage: (msg) => output.push(msg.payload), onMessage: { addListener: (fn) => { listener = fn; } }, onDisconnect: { addListener() {} } };
  const context = {
    __debatidorHost: {
      hostId: 'qwen', connectionId: 'conn_dom_qwen', detectStatus: () => status,
      readAnswer: () => answer, getAnswerKey: () => key,
      injectPrompt: (text) => { injected.push(text); return { ok: true }; },
    },
    chrome: { runtime: { connect: () => port } },
    document: { documentElement: {}, querySelectorAll: () => [] },
    MutationObserver: class { observe() {} },
    console: { debug() {}, warn() {} },
    Date: { now: () => now },
    setTimeout: schedule, clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, delay) => { if (delay === 400) tick = fn; },
    queueMicrotask: (fn) => fn(), addEventListener() {},
  };
  context.window = context;
  vm.runInNewContext(source, context);
  const send = async (msg) => { listener(msg); await Promise.resolve(); };
  return {
    output, injected, send,
    config: (debateId, enabled = true) => send({ type: 'config', debateId, enabled }),
    prompt: (debateId, extra = {}) => send({ type: 'dom_prompt', debateId, connectionId: 'conn_dom_qwen', turnId: 'turn-1', promptText: 'test', ...extra }),
    finish() {
      status = 'waiting'; key = 'new'; answer = 'P7_QUICK_DEBATE_OK'; tick();
      now += 500;
      for (const [id, timer] of timers) { if (timer.at <= now) { timers.delete(id); timer.fn(); } }
    },
  };
}

test('a browser completion keeps the requested room through a config refresh', async () => {
  const h = harness();
  await h.config('room-a');
  await h.prompt('room-a');
  await h.config('room-b');
  h.finish();
  const result = h.output.find((row) => row?.event === 'extension.dom_delta' && row.data.isComplete);
  assert.equal(result.data.debateId, 'room-a');
  assert.equal(result.data.turnId, 'turn-1');
  assert.equal(result.data.contentDelta, 'P7_QUICK_DEBATE_OK');
});

test('unbound tabs adopt the explicit room for the turn', async () => {
  const h = harness(); await h.config(''); await h.prompt('room-a'); h.finish();
  assert.equal(h.output.find((row) => row?.event === 'extension.dom_delta')?.data.debateId, 'room-a');
});

test('foreign room, different host, disabled and unknown consent never inject', async () => {
  const h = harness();
  await h.prompt('room-a');
  await h.config('room-a'); await h.prompt('room-b');
  await h.prompt('room-a', { connectionId: 'conn_dom_claude' });
  await h.config('room-a', false); await h.prompt('room-a');
  assert.equal(h.injected.length, 0);
  assert.equal(h.output.at(-1).data.injectionEnabled, false);
});

test('a second prompt cannot replace a capture already in flight', async () => {
  const h = harness(); await h.config('room-a');
  await h.prompt('room-a'); await h.prompt('room-a', { turnId: 'turn-2' }); h.finish();
  assert.equal(h.injected.length, 1);
  assert.equal(h.output.find((row) => row?.event === 'extension.dom_delta')?.data.turnId, 'turn-1');
});
