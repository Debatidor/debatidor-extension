import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');

function loadHost() {
  const context = vm.createContext({ document: {}, window: {}, console, URL });
  const source = readFileSync(path.join(ROOT, 'hosts', 'claude.js'), 'utf8');
  return vm.runInContext(`${source}\n__debatidorHost`, context);
}

test('manifest inyecta Claude en claude.ai', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const entry = manifest.content_scripts.find((cs) => cs.js.includes('hosts/claude.js'));
  assert.ok(entry, 'falta content_script de Claude');
  assert.ok(entry.matches.includes('https://claude.ai/*'));
  assert.ok(entry.js.includes('content.js'));
  assert.equal(entry.run_at, 'document_idle');
});

test('host Claude expone identidad y contrato completos', () => {
  const host = loadHost();
  assert.equal(host.hostId, 'claude');
  assert.equal(host.providerId, 'anthropic');
  assert.equal(host.connectionId, 'conn_dom_claude');
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
  assert.ok(host.matches('https://claude.ai/new'));
  assert.ok(host.matches('https://claude.ai/chat/abc'));
  assert.ok(!host.matches('https://chatgpt.com/'));
});

test('adapter Claude usa anclas semánticas del snapshot y evita ids volátiles', () => {
  const source = readFileSync(path.join(ROOT, 'hosts', 'claude.js'), 'utf8');
  assert.match(source, /data-testid=\\?['"]chat-input/);
  assert.match(source, /data-testid=\\?['"]chat-input-send/);
  assert.match(source, /data-testid=\\?['"]transcript-row/);
  assert.match(source, /data-perf-row/);
  assert.match(source, /data-perf-row-streaming/);
  assert.match(source, /data-is-streaming/);
  assert.match(source, /data-cds=\\?['"]Prose/);
  assert.match(source, /action-bar-retry/);
  assert.doesNotMatch(source, /base-ui-_r_/);
  assert.doesNotMatch(source, /id=["'`]?_r_/);
});

test('popup promueve Claude a host vivo sin agregar CTA hardcodeado', () => {
  const source = readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  assert.match(source, /'claude\.ai'\s*:\s*\{/);
  assert.match(source, /domains:\s*\['claude\.ai'\]/);
  assert.match(source, /url:\s*'https:\/\/claude\.ai\/new'/);

  const picker = source.split('function renderAgentPicker()')[1]?.split('async function renderAgentView')[0] ?? '';
  assert.doesNotMatch(picker, /Claude/);

  const roadmap = source.split('const ROADMAP_HOSTS =')[1]?.split('const DEFAULTS')[0] ?? '';
  assert.doesNotMatch(roadmap, /Claude/);
  assert.match(roadmap, /Gemini/);
});
