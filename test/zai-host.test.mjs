import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');

function loadHost(file) {
  const context = vm.createContext({
    document: {},
    window: {},
    console,
    URL,
  });
  const source = readFileSync(path.join(ROOT, 'hosts', file), 'utf8');
  return vm.runInContext(`${source}\n__debatidorHost`, context);
}

test('manifest inyecta Z.ai en dominio raíz y subdominios', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const entry = manifest.content_scripts.find((cs) => cs.js.includes('hosts/zai.js'));
  assert.ok(entry, 'falta content_script de Z.ai');
  assert.ok(entry.matches.includes('https://z.ai/*'));
  assert.ok(entry.matches.includes('https://*.z.ai/*'));
  assert.ok(entry.js.includes('content.js'));
  assert.equal(entry.run_at, 'document_idle');
});

test('host Z.ai expone identidad y contrato completos', () => {
  const host = loadHost('zai.js');
  assert.equal(host.hostId, 'zai');
  assert.equal(host.providerId, 'zai');
  assert.equal(host.connectionId, 'conn_dom_zai');
  assert.ok(host.selectorVersion);
  for (const method of [
    'matches',
    'getAnswerKey',
    'detectStatus',
    'readAnswer',
    'isFreshConversation',
    'injectPrompt',
  ]) {
    assert.equal(typeof host[method], 'function', `falta ${method}`);
  }
});

test('host Z.ai matchea z.ai/chat.z.ai y no invade otros hosts', () => {
  const host = loadHost('zai.js');
  assert.ok(host.matches('https://z.ai/'));
  assert.ok(host.matches('https://chat.z.ai/c/abc'));
  assert.ok(host.matches('https://foo.z.ai/'));
  assert.ok(!host.matches('https://chatgpt.com/'));
  assert.ok(!host.matches('https://chat.qwen.ai/'));
});

test('adapter Z.ai usa selectores semánticos del snapshot y evita ids volátiles', () => {
  const source = readFileSync(path.join(ROOT, 'hosts', 'zai.js'), 'utf8');
  assert.match(source, /textarea#chat-input/);
  assert.match(source, /button#send-message-button/);
  assert.match(source, /aria-label=\\?['"]Stop/);
  assert.match(source, /\.chat-assistant/);
  assert.match(source, /#response-content-container/);
  assert.match(source, /regenerate-response-button/);
  assert.doesNotMatch(source, /bits-c\d+/);
  assert.doesNotMatch(source, /svelte-[a-z0-9]+/i);
});

test('popup registra Z.ai como host vivo y genera acciones desde el catálogo', () => {
  const source = readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  assert.match(source, /'chat\.z\.ai'/);
  assert.match(source, /domains:\s*\['chat\.z\.ai',\s*'z\.ai'\]/);
  assert.match(source, /function liveHosts\(\)/);
  assert.match(source, /for \(const host of liveHosts\(\)\)/);
  assert.match(source, /wrap\.replaceChildren\(\)/);

  const html = readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
  const emptyView = html.split('id="view-empty"')[1]?.split('</main>')[0] ?? '';
  assert.match(emptyView, /id="open-host-buttons"/);
  assert.ok(!/btn-open-(qwen|chatgpt|zai)/.test(emptyView));
});

test('Qwen, ChatGPT y Z.ai usan connectionIds distintos', () => {
  const ids = ['qwen.js', 'chatgpt.js', 'zai.js'].map((file) => loadHost(file).connectionId);
  assert.equal(new Set(ids).size, ids.length);
});
