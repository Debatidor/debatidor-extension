import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const BASE = readFileSync(new URL('../asset-transport.js', import.meta.url), 'utf8');
const FALLBACK = readFileSync(new URL('../asset-integrity-fallback.js', import.meta.url), 'utf8');
const CHATGPT_ASSETS = readFileSync(new URL('../hosts/chatgpt-assets.js', import.meta.url), 'utf8');
const TOKEN = 'art_' + 'a'.repeat(48);
const UPLOAD_URL = `https://api.test/asset-relay/upload/${TOKEN}`;

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function loadTransport() {
  const context = vm.createContext({
    URL,
    console,
    Blob,
    Uint8Array,
    setTimeout,
    crypto: webcrypto,
    location: { href: 'https://chatgpt.com/c/test' },
  });
  vm.runInContext(BASE, context);
  vm.runInContext(FALLBACK, context);
  return vm.runInContext('__debatidorAssetTransport', context);
}

test('generated image can be selected by SHA even when its DOM name differs from destination path', async () => {
  const transport = loadTransport();
  const sourceBlob = new Blob(['original-image-bytes'], { type: 'image/png' });
  const expectedSha256 = sha(Buffer.from('original-image-bytes'));
  const sourceUrl = 'https://chatgpt.com/backend-api/estuary/content?id=file_test&sig=signed';
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (init.method === 'PUT') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          status: 'completed',
          result: { bytes: sourceBlob.size, sha256: expectedSha256 },
        }),
      };
    }
    return { ok: true, status: 200, blob: async () => sourceBlob };
  };
  const result = await transport.run(
    {
      ticketId: 'tkt_0123456789abcdef01234567',
      uploadUrl: UPLOAD_URL,
      fileName: 'imagen_original.png',
      path: 'imagen_original.png',
      expectedBytes: sourceBlob.size,
      expectedSha256,
      mimeType: 'image/png',
      maxBytes: 268435456,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    {
      listDownloads: () => [
        {
          href: sourceUrl,
          kind: 'generated-image',
          names: ['Imagen generada: Gallina rojiza en retrato de estudio'],
        },
      ],
      fetchImpl,
      waitMs: 0,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.matchedBy, 'sha256');
  assert.equal(result.href, sourceUrl);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, sourceUrl);
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[1].url, UPLOAD_URL);
  assert.equal(calls[1].init.method, 'PUT');
  assert.equal(calls[1].init.body, sourceBlob);
});

test('integrity mismatch never spends the relay token', async () => {
  const transport = loadTransport();
  const sourceBlob = new Blob(['wrong-image'], { type: 'image/png' });
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (init.method === 'PUT') throw new Error('PUT must not happen');
    return { ok: true, status: 200, blob: async () => sourceBlob };
  };
  const result = await transport.run(
    {
      ticketId: 'tkt_0123456789abcdef01234567',
      uploadUrl: UPLOAD_URL,
      fileName: 'imagen_original.png',
      path: 'imagen_original.png',
      expectedBytes: sourceBlob.size,
      expectedSha256: sha(Buffer.from('different-image')),
      mimeType: 'image/png',
      maxBytes: 268435456,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    {
      listDownloads: () => [
        { href: 'https://chatgpt.com/backend-api/estuary/content?id=x', kind: 'generated-image', names: [] },
      ],
      fetchImpl,
      waitMs: 0,
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'download_not_found');
  assert.equal(calls.filter((call) => call.init.method === 'PUT').length, 0);
});

test('ChatGPT host adapter adds unique Estuary image candidates beside normal downloads', () => {
  const image = {
    currentSrc: 'https://chatgpt.com/backend-api/estuary/content?id=file_1&sig=x',
    src: '',
    width: 1254,
    height: 1254,
    naturalWidth: 1254,
    naturalHeight: 1254,
    getAttribute(name) {
      if (name === 'alt') return 'Imagen generada: pollo';
      if (name === 'src') return this.currentSrc;
      return null;
    },
    closest() {
      return {};
    },
  };
  const shell = { querySelectorAll: () => [image, image] };
  const answer = { closest: () => shell };
  const context = vm.createContext({
    console,
    document: { querySelectorAll: () => [answer] },
    __debatidorHost: {
      hostId: 'chatgpt',
      listDownloads: () => [
        { href: 'blob:https://chatgpt.com/file', download: 'report.pdf', names: [] },
      ],
    },
  });
  vm.runInContext(CHATGPT_ASSETS, context);
  const candidates = vm.runInContext('__debatidorHost.listDownloads()', context);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].download, 'report.pdf');
  assert.equal(candidates[1].kind, 'generated-image');
  assert.equal(candidates[1].href, image.currentSrc);
  assert.deepEqual(Array.from(candidates[1].names), ['Imagen generada: pollo']);
});
