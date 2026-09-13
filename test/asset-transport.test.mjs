import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../asset-transport.js', import.meta.url), 'utf8');
const TOKEN = 'art_' + 'a'.repeat(48);
const UPLOAD_URL = `https://api.test/asset-relay/upload/${TOKEN}`;

function loadTransport(extra = {}) {
  const context = vm.createContext({
    URL,
    console,
    Blob,
    setTimeout,
    location: { href: 'https://claude.ai/chat/abc' },
    ...extra,
  });
  vm.runInContext(SOURCE, context);
  return vm.runInContext('__debatidorAssetTransport', context);
}

function anchor(href, { download, text = '', aria, title } = {}) {
  const attrs = { download, 'aria-label': aria, title };
  return {
    href,
    textContent: text,
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
  };
}

function ticket(overrides = {}) {
  return {
    ticketId: 'tkt_0123456789abcdef01234567',
    uploadUrl: UPLOAD_URL,
    fileName: 'render.png',
    path: 'media/render.png',
    expectedBytes: 4,
    mimeType: 'image/png',
    maxBytes: 268435456,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function fakeFetch(handlers) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handlers(String(url), init);
  };
  return { impl, calls };
}

test('pickDownload only accepts an EXACT name match, in candidate order', () => {
  const t = loadTransport();
  const candidates = [
    { href: 'https://claude.ai/api/files/1/download', names: ['Otro archivo.png'] },
    { href: 'https://claude.ai/api/files/2/download?filename=render.png', names: ['Descargar'] },
    { href: 'https://claude.ai/api/files/3/download', download: 'render.png', names: [] },
  ];
  assert.equal(t.pickDownload(candidates, 'render.png')?.href, candidates[1].href);
  assert.equal(t.pickDownload(candidates, '  "Render.PNG" ')?.href, candidates[1].href);
  // Coincidencia parcial o de otro archivo: nunca.
  assert.equal(t.pickDownload(candidates, 'render'), null);
  assert.equal(t.pickDownload(candidates, 'render.png.zip'), null);
  assert.equal(t.pickDownload([], 'render.png'), null);
  assert.equal(t.pickDownload(candidates, ''), null);
});

test('candidate names come from download attr, visible text, URL segment and headers', () => {
  const t = loadTransport();
  const withSegment = { href: 'https://cdn.test/bucket/reporte%20final.pdf?x=1' };
  assert.ok(t.candidateNames(withSegment).includes('reporte final.pdf'));
  const withDisposition = {
    href: `https://cdn.test/o?response-content-disposition=${encodeURIComponent("attachment; filename*=UTF-8''informe.docx")}`,
  };
  assert.ok(t.candidateNames(withDisposition).includes('informe.docx'));
  const relative = { href: '/api/organizations/o/files/f/download?name=clip.mp4' };
  assert.ok(t.candidateNames(relative, 'https://claude.ai/chat/x').includes('clip.mp4'));
  const blob = { href: 'blob:https://claude.ai/uuid', names: ['clip.mp4'] };
  assert.deepEqual(Array.from(t.candidateNames(blob)), ['clip.mp4']);
});

test('anchorsToCandidates dedupes by href and keeps labels the user can see', () => {
  const t = loadTransport();
  const a1 = anchor('https://claude.ai/api/files/1/download', { download: 'render.png', text: 'Descargar', aria: 'Descargar render.png' });
  const a2 = anchor('https://claude.ai/api/files/1/download', { text: 'dup' });
  const a3 = anchor('blob:https://claude.ai/xyz', { text: 'clip.mp4' });
  const out = t.anchorsToCandidates([a1, a2, a3, anchor('')]);
  assert.equal(out.length, 2);
  assert.equal(out[0].download, 'render.png');
  assert.deepEqual(Array.from(out[0].names), ['Descargar render.png', 'Descargar']);
  assert.equal(out[1].href, 'blob:https://claude.ai/xyz');
});

test('run waits for the link, downloads same-origin and PUTs the blob to the relay', async () => {
  const t = loadTransport();
  const blob = new Blob(['abcd'], { type: 'image/png' });
  const { impl, calls } = fakeFetch((url, init) => {
    if (init.method === 'PUT') {
      return { ok: true, status: 200, json: async () => ({ ok: true, status: 'completed', result: { bytes: 4, sha256: 'e'.repeat(64) } }) };
    }
    return { ok: true, status: 200, blob: async () => blob };
  });
  let polls = 0;
  const listDownloads = () => {
    polls += 1;
    // El file card se monta después del ticket: aparece en el tercer sondeo.
    return polls < 3 ? [] : [{ href: 'https://claude.ai/api/files/9/download', download: 'render.png', names: [] }];
  };
  const result = await t.run(ticket(), { listDownloads, fetchImpl: impl, sleep: async () => {}, waitMs: 5_000 });

  assert.equal(result.ok, true);
  assert.equal(result.bytes, 4);
  assert.equal(result.sha256, 'e'.repeat(64));
  assert.equal(typeof result.ms, 'number');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://claude.ai/api/files/9/download');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[1].url, UPLOAD_URL);
  assert.equal(calls[1].init.method, 'PUT');
  assert.equal(calls[1].init.body, blob);
  assert.equal(calls[1].init.headers['content-type'], 'image/png');
  assert.equal(calls[1].init.credentials, 'omit');
});

test('run reports download_not_found without touching the network and honours expiry', async () => {
  const t = loadTransport();
  const { impl, calls } = fakeFetch(() => ({ ok: true, status: 200 }));
  let now = 1_000;
  const clock = () => now;
  const sleep = async () => {
    now += 300;
  };
  const missing = await t.run(ticket(), { listDownloads: () => [{ href: 'https://x/other.png', names: ['other.png'] }], fetchImpl: impl, sleep, now: clock, waitMs: 900 });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'download_not_found');
  assert.equal(calls.length, 0);

  const expired = await t.run(ticket({ expiresAt: new Date(0).toISOString() }), { listDownloads: () => [], fetchImpl: impl, sleep, now: () => Date.now() });
  assert.equal(expired.error, 'ticket_expired');
  assert.equal(calls.length, 0);

  const unsupported = await t.run(ticket(), { fetchImpl: impl });
  assert.equal(unsupported.error, 'host_unsupported');
});

test('run never uploads a blob whose size disagrees with the manifest, and surfaces relay and CORS errors', async () => {
  const t = loadTransport();
  const link = [{ href: 'https://claude.ai/api/files/9/download', download: 'render.png', names: [] }];

  const mismatch = fakeFetch(() => ({ ok: true, status: 200, blob: async () => new Blob(['abcde']) }));
  const sized = await t.run(ticket({ expectedBytes: 4 }), { listDownloads: () => link, fetchImpl: mismatch.impl, sleep: async () => {} });
  assert.equal(sized.ok, false);
  assert.equal(sized.error, 'size_mismatch:5:4');
  assert.equal(mismatch.calls.filter((c) => c.init.method === 'PUT').length, 0);

  const consumed = fakeFetch((url, init) =>
    init.method === 'PUT'
      ? { ok: false, status: 409, json: async () => ({ message: 'asset_relay_ticket_active' }) }
      : { ok: true, status: 200, blob: async () => new Blob(['abcd']) },
  );
  const conflict = await t.run(ticket(), { listDownloads: () => link, fetchImpl: consumed.impl, sleep: async () => {} });
  assert.equal(conflict.error, 'relay_http_409:asset_relay_ticket_active');

  const blocked = fakeFetch(() => {
    throw new TypeError('Failed to fetch');
  });
  const cors = await t.run(ticket(), { listDownloads: () => link, fetchImpl: blocked.impl, sleep: async () => {} });
  assert.match(cors.error, /^download_blocked:/);

  const http = fakeFetch(() => ({ ok: false, status: 403 }));
  const forbidden = await t.run(ticket(), { listDownloads: () => link, fetchImpl: http.impl, sleep: async () => {} });
  assert.equal(forbidden.error, 'download_http_403');
});

test('putToRelay (popup fallback) validates before spending the single-use token', async () => {
  const t = loadTransport();
  const { impl, calls } = fakeFetch(() => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
  await assert.rejects(t.putToRelay(ticket({ maxBytes: 3 }), new Blob(['abcd']), { fetchImpl: impl }), /payload_too_large/);
  await assert.rejects(t.putToRelay(ticket({ uploadUrl: '' }), new Blob(['abcd']), { fetchImpl: impl }), /upload_url_missing/);
  await assert.rejects(t.putToRelay(ticket(), new Blob([]), { fetchImpl: impl }), /download_empty/);
  assert.equal(calls.length, 0);
  const ok = await t.putToRelay(ticket({ expectedBytes: undefined }), new Blob(['abcd']), { fetchImpl: impl });
  assert.equal(ok.bytes, 4);
  assert.equal(calls.length, 1);
});
