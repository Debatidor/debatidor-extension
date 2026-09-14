import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../asset-ticket-strategy-background.js', import.meta.url), 'utf8');

function load() {
  const context = vm.createContext({
    sanitizeAssetTicket(data) {
      if (!data?.ticketId) return null;
      return {
        ticketId: data.ticketId,
        path: data.path,
        fileName: data.fileName,
        uploadUrl: data.uploadUrl,
      };
    },
    ticketMessage(ticket) {
      return { type: 'asset_ticket', ticketId: ticket.ticketId, path: ticket.path };
    },
    publicAssetTicket(ticket) {
      return { ticketId: ticket.ticketId, path: ticket.path, state: 'dispatched' };
    },
  });
  vm.runInContext(SOURCE, context);
  return context;
}

test('websocket ticket keeps sourceStrategy separate from destinationPath', () => {
  const context = load();
  const ticket = context.sanitizeAssetTicket({
    ticketId: 'tkt_0123456789abcdef01234567',
    uploadUrl: 'https://api.test/upload/x',
    path: 'legacy.png',
    destinationPath: 'media/gallina.png',
    fileName: 'gallina.png',
    sourceStrategy: 'previous-turn-image',
  });
  assert.ok(ticket);
  assert.equal(ticket.destinationPath, 'media/gallina.png');
  assert.equal(ticket.sourceStrategy, 'previous-turn-image');
  const wire = context.ticketMessage(ticket);
  assert.equal(wire.destinationPath, 'media/gallina.png');
  assert.equal(wire.sourceStrategy, 'previous-turn-image');
  const publicView = context.publicAssetTicket(ticket);
  assert.equal(publicView.destinationPath, 'media/gallina.png');
  assert.equal(publicView.sourceStrategy, 'previous-turn-image');
  assert.equal('uploadUrl' in publicView, false);
});

test('invalid sourceStrategy is rejected before reaching a tab', () => {
  const context = load();
  const ticket = context.sanitizeAssetTicket({
    ticketId: 'tkt_0123456789abcdef01234567',
    uploadUrl: 'https://api.test/upload/x',
    path: 'x.png',
    fileName: 'x.png',
    sourceStrategy: 'latest-whatever',
  });
  assert.equal(ticket, null);
});
