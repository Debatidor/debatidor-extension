import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../asset-save-intent.js', import.meta.url), 'utf8');

function load() {
  const context = vm.createContext({ console });
  vm.runInContext(SOURCE, context);
  return vm.runInContext('__debatidorAssetSaveIntent', context);
}

test('generar y guardar en el mismo prompt espera una imagen nueva', () => {
  const api = load();
  const intent = api.parse(
    'Genera una imagen original de un pollo y guárdala como imagen_original.png en la raíz del agente vps-workspace.',
  );
  assert.ok(intent?.requested);
  assert.equal(intent.sourceStrategy, 'wait-for-new-image');
  assert.equal(intent.agentId, 'vps-workspace');
  assert.deepEqual(Array.from(intent.paths), ['imagen_original.png']);
  assert.equal(intent.rootRequested, true);
  assert.equal(api.destinationFor(intent, 0, 'image/png'), 'imagen_original.png');
});

test('el prompt real "ya esta imagen" apunta al assistant turn anterior', () => {
  const api = load();
  const intent = api.parse(
    'ya esta imagen (no necesitas crear otra quiero esta) quiero que la pongas en la raiz del proyecto usando debatidor',
  );
  assert.ok(intent?.requested);
  assert.equal(intent.sourceStrategy, 'previous-turn-image');
  assert.equal(intent.rootRequested, true);
  assert.equal(api.destinationFor(intent, 0, 'image/png'), 'imagen_1.png');
});

test('guardar esta imagen con nombre explícito conserva el destino sin usarlo como fuente', () => {
  const api = load();
  const intent = api.parse('Guarda esta imagen como gallina.png en la raíz');
  assert.ok(intent?.requested);
  assert.equal(intent.sourceStrategy, 'previous-turn-image');
  assert.deepEqual(Array.from(intent.paths), ['gallina.png']);
  assert.equal(api.destinationFor(intent, 0, 'image/png'), 'gallina.png');
});

test('tres imágenes sin nombres reciben destinos deterministas en la raíz', () => {
  const api = load();
  const intent = api.parse('Crea 3 imágenes de gatos y guárdalas en la raíz');
  assert.ok(intent?.requested);
  assert.equal(intent.sourceStrategy, 'wait-for-new-image');
  assert.equal(intent.count, 3);
  assert.equal(api.destinationFor(intent, 0, 'image/png'), 'imagen_1.png');
  assert.equal(api.destinationFor(intent, 1, 'image/webp'), 'imagen_2.webp');
  assert.equal(api.destinationFor(intent, 2, 'image/jpeg'), 'imagen_3.jpg');
});

test('un nombre único se conserva para la primera imagen y se sufija para las siguientes', () => {
  const api = load();
  const intent = api.parse('Genera imágenes y guarda resultado.png');
  assert.ok(intent);
  assert.equal(intent.sourceStrategy, 'wait-for-new-image');
  assert.equal(api.destinationFor(intent, 0, 'image/png'), 'resultado.png');
  assert.equal(api.destinationFor(intent, 1, 'image/png'), 'resultado_2.png');
});

test('no activa guardado por una generación normal ni por una negación explícita', () => {
  const api = load();
  assert.equal(api.parse('Genera una imagen de un pollo'), null);
  assert.equal(api.parse('Genera una imagen, pero no quiero guardarla'), null);
  assert.equal(api.parse("Create an image but don't save it"), null);
});

test('requestId es opaco, estable y cambia con ruta o asset', () => {
  const api = load();
  const first = api.requestId('turn-1', 'https://chatgpt.com/file/a', 'uno.png');
  assert.match(first, /^asr_[a-f0-9]{16}$/);
  assert.equal(first, api.requestId('turn-1', 'https://chatgpt.com/file/a', 'uno.png'));
  assert.notEqual(first, api.requestId('turn-1', 'https://chatgpt.com/file/b', 'uno.png'));
  assert.notEqual(first, api.requestId('turn-1', 'https://chatgpt.com/file/a', 'dos.png'));
});
