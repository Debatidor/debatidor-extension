import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');
const TRANSPORT = readFileSync(path.join(ROOT, 'asset-transport.js'), 'utf8');

function fakeAnchor(href, { download, text = '' } = {}) {
  const attrs = { download };
  return { href, textContent: text, getAttribute: (name) => (name in attrs ? attrs[name] : null) };
}

/** Fila/turno assistant falso: entrega anclas solo para selectores de descarga. */
function fakeRow(anchors) {
  const row = {
    querySelectorAll: (selector) => (/^a\[|a\[href\]$/.test(selector) ? anchors : []),
    querySelector: () => null,
    getAttribute: () => null,
    closest: () => row,
    parentElement: null,
  };
  return row;
}

function loadHost(file, rows, { withTransport = true, selector }) {
  const context = vm.createContext({
    document: {
      readyState: 'complete',
      querySelectorAll: (sel) => (sel === selector ? rows : []),
      querySelector: () => null,
    },
    window: {},
    console,
    URL,
    location: { href: 'https://host.test/chat/1' },
  });
  if (withTransport) vm.runInContext(TRANSPORT, context);
  const source = readFileSync(path.join(ROOT, 'hosts', file), 'utf8');
  return vm.runInContext(`${source}\n__debatidorHost`, context);
}

const CLAUDE_ROW = '[data-testid="transcript-row"][data-perf-row="assistant"]';
const CHATGPT_NODE = '[data-message-author-role="assistant"]';

for (const [file, selector, hostId] of [
  ['claude.js', CLAUDE_ROW, 'claude'],
  ['chatgpt.js', CHATGPT_NODE, 'chatgpt'],
]) {
  test(`${hostId}: listDownloads enumera candidatos del último turno primero y deja la elección al transporte`, () => {
    const older = fakeRow([fakeAnchor('https://host.test/files/1/download', { download: 'viejo.png' })]);
    const latest = fakeRow([
      fakeAnchor('https://host.test/files/2/download', { download: 'render.png', text: 'Descargar' }),
      fakeAnchor('blob:https://host.test/uuid', { text: 'clip.mp4' }),
    ]);
    const host = loadHost(file, [older, latest], { selector });

    assert.equal(host.hostId, hostId);
    assert.equal(typeof host.listDownloads, 'function');
    assert.ok(host.downloadSelectorVersion, 'downloadSelectorVersion presente');
    assert.notEqual(host.downloadSelectorVersion, host.selectorVersion);

    const candidates = host.listDownloads();
    assert.deepEqual(
      Array.from(candidates, (c) => c.href),
      ['https://host.test/files/2/download', 'blob:https://host.test/uuid', 'https://host.test/files/1/download'],
    );
    assert.equal(candidates[0].download, 'render.png');
    assert.ok(candidates[0].names.includes('Descargar'));

    // El host no decide: sin turnos no hay candidatos, y nunca lanza.
    assert.equal(loadHost(file, [], { selector }).listDownloads().length, 0);
  });

  test(`${hostId}: listDownloads sobrevive sin asset-transport cargado`, () => {
    const row = fakeRow([fakeAnchor('https://host.test/files/3/download', { download: 'x.bin' })]);
    const host = loadHost(file, [row], { selector, withTransport: false });
    const candidates = host.listDownloads();
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].download, 'x.bin');
  });
}

test('hosts sin listDownloads (Qwen, Z.ai) siguen cumpliendo el contrato base: content.js reporta host_unsupported', () => {
  for (const file of ['qwen.js', 'zai.js']) {
    const source = readFileSync(path.join(ROOT, 'hosts', file), 'utf8');
    assert.doesNotMatch(source, /listDownloads/);
  }
  const content = readFileSync(path.join(ROOT, 'content.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(content, /typeof host\.listDownloads !== 'function'/);
  assert.match(content, /host_unsupported/);
  assert.match(content, /'extension\.asset_result'/);
  // Mismo routing que dom_prompt: consentimiento, host y sala.
  assert.match(content, /msg\.connectionId && msg\.connectionId !== connectionId\) return;\n[\s\S]*?msg\.debateId && configuredDebateId/);
});

test('manifest 0.5.0 carga asset-transport.js antes de cada host y el popup incluye el fallback manual', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.version, '0.5.0');
  assert.equal(pkg.version, '0.5.0');
  for (const entry of manifest.content_scripts) {
    assert.equal(entry.js[0], 'asset-transport.js', `${entry.matches[0]} carga el transporte primero`);
    assert.equal(entry.js[entry.js.length - 1], 'content.js');
  }
  // Sin permisos nuevos: el PUT va a rutas token con CORS abierto (ADR-0013 §4).
  assert.deepEqual(manifest.permissions, ['storage', 'tabs']);
  assert.equal('host_permissions' in manifest, false);

  const popup = readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
  assert.match(popup, /id="asset-card"/);
  assert.match(popup, /id="asset-list"/);
  assert.ok(popup.indexOf('asset-transport.js') < popup.indexOf('popup.js'));
  const popupJs = readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  assert.match(popupJs, /type: 'asset-ticket-url'/);
  assert.match(popupJs, /type: 'asset-manual-result'/);
  assert.match(popupJs, /input\.type = 'file'/);
  assert.match(popupJs, /putToRelay/);
});
