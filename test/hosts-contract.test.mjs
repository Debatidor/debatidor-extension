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

test('background conserva connectionId en dom_prompt para routing por pestaña', () => {
  const source = readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  assert.match(
    source,
    /type:\s*['"]dom_prompt['"][\s\S]*connectionId:\s*parsed\.data\?\.connectionId/,
  );
});

test('content preserva la identidad del HostAdapter frente al socket genérico conn_dom', () => {
  const source = readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  assert.match(source, /const hostConnectionId = host\.connectionId \?\? ['"]conn_dom['"]/);
  assert.match(source, /msg\.connectionId\.startsWith\(['"]conn_dom_['"]\)/);
  assert.match(source, /connectionId = hostConnectionId/);
});

test('content solo captura deltas de turnos inyectados por Debatidor', () => {
  const source = readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  assert.match(source, /let captureArmed = false/);
  assert.match(source, /captureArmed = true;[\s\S]*host\.injectPrompt/);
  assert.match(source, /if \(captureArmed && hostStatus === ['"]generating['"]\)/);
  assert.match(source, /captureArmed = false;[\s\S]*turnId = null/);
});

test('content normaliza actividad manual del host a waiting fuera de un turno propio', () => {
  const source = readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  assert.match(
    source,
    /const status = captureArmed[\s\S]*hostStatus === ['"]error['"][\s\S]*['"]waiting['"]/,
  );
});

test('content tiene watchdog de completion congelado', () => {
  const source = readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  assert.match(source, /lastProgressAt/);
  assert.match(source, /Date\.now\(\) - lastProgressAt > 45_000/);
  assert.match(source, /completion FORZADO por watchdog/);
});

test('content re-sincroniza estado después de BFCache y no consume estados que no pudo enviar', () => {
  const source = readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  assert.match(source, /window\.addEventListener\(['"]pagehide['"]/);
  assert.match(source, /window\.addEventListener\(['"]pageshow['"]/);
  assert.match(source, /if \(!event\.persisted\) return/);
  assert.match(source, /lastStatus = null;[\s\S]*lastStatusSentAt = 0;[\s\S]*connectPort\(\)/);
  assert.match(source, /if \(!emit\(statusEvent\(status\)\)\) return false/);
  assert.match(source, /const STATUS_HEARTBEAT_MS = 10000/);
});

test('Ports por pestaña son generacionales: un disconnect viejo no borra el Port nuevo', () => {
  const source = readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  assert.match(source, /const previous = tabs\.get\(tabId\)/);
  assert.match(source, /if \(tabs\.get\(tabId\) === port\)\s*\{\s*tabs\.delete\(tabId\)/);
  assert.match(source, /void chrome\.runtime\.lastError/);
});

test('qwen: footer Regenerate es completion autoritativo; el settle vive en content.js', () => {
  const source = readFileSync(path.join(ROOT, 'hosts', 'qwen.js'), 'utf8');
  assert.match(source, /if \(isDone\(node\)\) return ['"]waiting['"]/);
  assert.doesNotMatch(source, /SETTLE_MS|answerChangedAt|trackAnswer/);
});

test('qwen: normaliza NBSP/figure/narrow spaces introducidos por Monaco antes del bridge', () => {
  const source = readFileSync(path.join(ROOT, 'hosts', 'qwen.js'), 'utf8');
  assert.match(source, /function normalizeRenderedText\(text\)/);
  assert.match(source, /\\u00a0\\u2007\\u202f/);
  assert.match(source, /return normalizeRenderedText\(node\.innerText \?\? ['"]['"]\)\.trim\(\)/);
});

test('qwen: una evaluación A/B bloquea el turno sin serializar ni auto-seleccionar candidatos', () => {
  const source = readFileSync(path.join(ROOT, 'hosts', 'qwen.js'), 'utf8');
  assert.match(source, /qwen-chat-message-dual-message\.qwen-chat-message-awaiting-response/);
  assert.match(source, /smrm \.smrm-card__prefer-btn/);
  assert.match(source, /if \(preferenceGateActive\(\)\) \{\s*return ['"]generating['"]/);
  assert.match(source, /if \(preferenceGateActive\(\)\) return ['"]['"]/);
  assert.doesNotMatch(source, /prefer-btn['"]?\)\.click|smrm-card__prefer-btn[^\n]*click/);
});

test('popup: HOSTS registra ChatGPT como disponible (nada de "Próximamente")', () => {
  const source = readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  const hostsBlock = source.split('const HOSTS =')[1]?.split('};')[0] ?? '';
  assert.ok(hostsBlock.includes("'chatgpt.com'"), 'chatgpt.com falta en HOSTS');
  assert.ok(!/available:\s*false/.test(hostsBlock), 'un host vivo marcado unavailable');
  const roadmapBlock = source.split('const ROADMAP_HOSTS =')[1]?.split('];')[0] ?? '';
  assert.ok(!roadmapBlock.includes('ChatGPT'), 'ChatGPT sigue en roadmap');
});

test('popup.html: la vista vacía usa un único picker, sin CTAs legacy por host', () => {
  const html = readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
  const emptyView = html.split('id="view-empty"')[1]?.split('</main>')[0] ?? '';
  assert.ok(!emptyView.includes('btn-open-qwen'), 'botón viejo Abrir Qwen sigue en el HTML');
  assert.ok(!emptyView.includes('open-host-buttons'), 'contenedor legacy de botones por host sigue en el HTML');
  assert.match(emptyView, /id="btn-open-agent"/);
  assert.match(emptyView, /id="agent-picker-menu"/);
});
