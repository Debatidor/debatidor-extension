import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../asset-save-background.js', import.meta.url), 'utf8');
const TICKET_ID = 'tkt_0123456789abcdef01234567';
const UPLOAD_URL = `https://api.debatidor.com/asset-relay/upload/art_${'a'.repeat(48)}`;

function harness({ enabled = true } = {}) {
  let listener;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const request = JSON.parse(String(init?.body ?? '{}'));
    return {
      ok: true,
      status: 201,
      json: async () => ({
        ticketId: TICKET_ID,
        direction: 'upload',
        uploader: 'any',
        status: 'pending',
        path: request.path,
        destinationPath: request.destinationPath,
        sourceStrategy: request.sourceStrategy,
        expectedBytes: 1234,
        expectedSha256: 'b'.repeat(64),
        mimeType: 'image/png',
        maxBytes: 268435456,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        uploadUrl: UPLOAD_URL,
      }),
    };
  };
  const context = vm.createContext({
    URL,
    console,
    fetch: fetchImpl,
    chrome: {
      runtime: {
        onMessage: {
          addListener(fn) {
            listener = fn;
          },
        },
      },
      storage: {
        session: {
          get: async (key) => ({ [key]: enabled }),
        },
        local: {
          get: async () => ({
            apiKey: 'deb_live_fixture',
            backendUrl: 'wss://api.debatidor.com/extension?old=1',
          }),
        },
      },
    },
  });
  vm.runInContext(SOURCE, context);

  const message = (data, sender = { tab: { id: 7 } }) =>
    new Promise((resolve) => {
      const keepAlive = listener({ type: 'asset-save-create-ticket', data }, sender, resolve);
      if (keepAlive !== true) resolve({ ok: false, reason: 'listener_not_async' });
    });
  return { calls, message };
}

function validData(overrides = {}) {
  return {
    destinationPath: 'imagen_original.png',
    path: 'imagen_original.png',
    sourceStrategy: 'previous-turn-image',
    agentId: 'vps-workspace',
    connectionId: 'conn_dom_openai',
    expectedBytes: 1234,
    expectedSha256: 'b'.repeat(64),
    mimeType: 'image/png',
    ...overrides,
  };
}

test('tab consentida crea un ticket HTTP autenticado sin pasar por MCP', async () => {
  const h = harness();
  const result = await h.message(validData());
  assert.equal(result.ok, true);
  assert.equal(result.ticket.ticketId, TICKET_ID);
  assert.equal(result.ticket.uploadUrl, UPLOAD_URL);
  assert.equal(result.ticket.destinationPath, 'imagen_original.png');
  assert.equal(result.ticket.sourceStrategy, 'previous-turn-image');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, 'https://api.debatidor.com/asset-relay/tickets');
  assert.equal(h.calls[0].init.method, 'POST');
  assert.equal(h.calls[0].init.headers['x-api-key'], 'deb_live_fixture');
  const body = JSON.parse(h.calls[0].init.body);
  assert.equal(body.uploader, 'any');
  assert.equal(body.direction, 'upload');
  assert.equal(body.path, 'imagen_original.png');
  assert.equal(body.destinationPath, 'imagen_original.png');
  assert.equal(body.sourceStrategy, 'previous-turn-image');
  assert.equal(body.agentId, 'vps-workspace');
  assert.equal(body.expectedBytes, 1234);
  assert.equal(body.expectedSha256, 'b'.repeat(64));
  assert.equal(JSON.stringify(result).includes('deb_live_fixture'), false);
});

test('sin consentimiento no toca la red ni devuelve secretos', async () => {
  const h = harness({ enabled: false });
  const result = await h.message(validData());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'asset_save_consent_required');
  assert.equal(h.calls.length, 0);
});

test('rechaza destino, estrategia o integridad inválidos antes de crear ticket', async () => {
  const h = harness();
  const unsafe = await h.message(validData({ destinationPath: '../escape.png', path: '../escape.png' }));
  assert.equal(unsafe.ok, false);
  assert.match(unsafe.reason, /asset_save_destination_path_invalid/);
  const badStrategy = await h.message(validData({ sourceStrategy: 'whatever' }));
  assert.equal(badStrategy.ok, false);
  assert.match(badStrategy.reason, /asset_save_source_strategy_invalid/);
  const badSha = await h.message(validData({ expectedSha256: 'nope' }));
  assert.equal(badSha.ok, false);
  assert.match(badSha.reason, /asset_save_sha256_invalid/);
  assert.equal(h.calls.length, 0);
});
