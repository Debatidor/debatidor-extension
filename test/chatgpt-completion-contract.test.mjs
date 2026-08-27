import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');
const source = readFileSync(path.join(ROOT, 'hosts', 'chatgpt.js'), 'utf8');

test('ChatGPT no finaliza solo porque aparezca el footer', () => {
  const detect = source.split('detectStatus()')[1]?.split('readAnswer()')[0] ?? '';
  assert.match(detect, /const stopVisible = Boolean\(first\(STOP\)\)/);
  assert.match(detect, /const streamActive = Boolean\(document\.querySelector\(STREAM_ACTIVE\)\)/);
  assert.match(detect, /if \(stopVisible\)[\s\S]*return 'generating'/);
  assert.match(detect, /if \(footerDone\)[\s\S]*textStableFor < SETTLE_MS[\s\S]*return 'generating'/);
});

test('un bloque de código estable puede cerrar aunque streamActive quede stale', () => {
  assert.match(source, /const CODE_MARKS =/);
  assert.match(source, /function hasRenderedCode/);
  assert.match(source, /if \(codeMounted\) return 'waiting'/);
  assert.match(source, /2026-08-chatgpt-prosemirror-2/);
});
