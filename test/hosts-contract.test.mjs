import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

/**
 * Carga un host adapter en una sandbox: los adapters NO tocan document/window
 * al adjuntarse (solo dentro de los métodos), así que podemos verificar
 * identidad e interfaz sin DOM real.
 */
function loadHost(file) {
  const context = vm.createContext({
    document: {},
    window: {},
    console,
  });
  const source = readFileSync(path.join(ROOT, 'hosts', file), 'utf8');
  return vm.runInContext(`${source}\n__debatidorHost`, context);
}

test('manifest inyecta hosts/chatgpt.js + content.js en chatgpt.com', () => {
  const entry = manifest.content_scripts.find((cs) =>
    cs.matches.some((m) => m.includes('chatgpt.com')),
  );
  assert.ok(entry, 'falta el content_scripts de chatgpt.com');
  assert.ok(entry.js.includes('hosts/chatgpt.js'));
  assert.ok(entry.js.includes('content.js'));
  assert.equal(entry.run_at, 'document_idle');
});

test('manifest sigue inyectando el host de Qwen (sin regresiones)', () => {
  const entry = manifest.content_scripts.find((cs) =>
    cs.matches.some((m) => m.includes('chat.qwen.ai')),
  );
  assert.ok(entry);
  assert.ok(entry.js.includes('hosts/qwen.js'));
});

test('host chatgpt: identidad propia y contrato de interfaz completo', () => {
  const host = loadHost('chatgpt.js');
  assert.equal(host.hostId, 'chatgpt');
  assert.equal(host.providerId, 'openai');
  assert.equal(host.connectionId, 'conn_dom_openai');
  assert.ok(host.selectorVersion);
  for (const method of ['matches', 'detectStatus', 'readAnswer', 'isFreshConversation', 'injectPrompt']) {
    assert.equal(typeof host[method], 'function', `falta ${method}`);
  }
});

test('host chatgpt: matches chatgpt.com y NO matchea otros hosts', () => {
  const host = loadHost('chatgpt.js');
  assert.ok(host.matches('https://chatgpt.com/'));
  assert.ok(host.matches('https://chatgpt.com/c/abc123'));
  assert.ok(!host.matches('https://chat.qwen.ai/'));
});

test('host qwen: identidad intacta (conn_dom_qwen) y misma interfaz', () => {
  const host = loadHost('qwen.js');
  assert.equal(host.hostId, 'qwen');
  assert.equal(host.connectionId, 'conn_dom_qwen');
  for (const method of ['matches', 'detectStatus', 'readAnswer', 'isFreshConversation', 'injectPrompt']) {
    assert.equal(typeof host[method], 'function', `falta ${method}`);
  }
});

test('los dos hosts declaran connectionIds DISTINTOS (multi-modelo)', () => {
  const qwen = loadHost('qwen.js');
  const chatgpt = loadHost('chatgpt.js');
  assert.notEqual(qwen.connectionId, chatgpt.connectionId);
});
