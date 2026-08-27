import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');
const guardSource = readFileSync(path.join(ROOT, 'hosts', 'chatgpt-stability.js'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function buildGuard(initialText = '') {
  let now = 1_000;
  let text = initialText;
  let key = 'assistant-1';
  const host = {
    hostId: 'chatgpt',
    selectorVersion: 'base',
    detectStatus: () => 'waiting',
    readAnswer: () => text,
  };
  const context = {
    __debatidorHost: host,
    document: {
      querySelectorAll: () => [
        {
          getAttribute: (name) => (name === 'data-message-id' ? key : null),
        },
      ],
    },
    Date: { now: () => now },
  };
  context.globalThis = context;
  vm.runInNewContext(guardSource, context);
  return {
    host,
    advance(ms) {
      now += ms;
    },
    setText(value) {
      text = value;
    },
    setKey(value) {
      key = value;
    },
  };
}

test('0.4.1 carga el guard antes de content.js', () => {
  assert.equal(manifest.version, '0.4.1');
  assert.equal(pkg.version, '0.4.1');
  const chatgpt = manifest.content_scripts.find((item) => item.matches.includes('https://chatgpt.com/*'));
  assert.deepEqual(chatgpt.js, ['hosts/chatgpt.js', 'hosts/chatgpt-stability.js', 'content.js']);
});

test('no finaliza un tool JSON truncado aunque el adapter base diga waiting', () => {
  const env = buildGuard('JSON{"tool":"fs.list","path":""');
  assert.equal(env.host.detectStatus(), 'generating');
  env.advance(2_000);
  assert.equal(env.host.detectStatus(), 'generating');
});

test('acepta JSON balanceado con llaves dentro de strings y congela el snapshot validado', () => {
  const complete = 'JSON{"tool":"shell.run","command":"powershell -Command \\\"Where-Object { $_ }\\\""}';
  const env = buildGuard(complete);

  assert.equal(env.host.detectStatus(), 'generating');
  env.advance(1_000);
  assert.equal(env.host.detectStatus(), 'waiting');
  assert.equal(env.host.readAnswer(), complete);

  // Simula una mutación de CodeMirror entre detectStatus() y readAnswer().
  env.setText(`${complete} BASURA_TARDIA`);
  assert.equal(env.host.readAnswer(), complete);
});

test('un message-id nuevo reinicia la estabilidad del candidato', () => {
  const env = buildGuard('respuesta estable');
  assert.equal(env.host.detectStatus(), 'generating');
  env.advance(1_000);
  assert.equal(env.host.detectStatus(), 'waiting');

  env.setKey('assistant-2');
  env.setText('otra respuesta');
  assert.equal(env.host.detectStatus(), 'generating');
});
