import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');
const content = readFileSync(path.join(ROOT, 'content.js'), 'utf8');

test('content captura respuestas instantáneas aunque no observe generating', () => {
  assert.match(content, /armedAnswerKey/);
  assert.match(content, /sawOwnedAnswer/);
  assert.match(content, /function currentAnswerKey/);
  assert.match(content, /sawStream \|\| sawOwnedAnswer/);
  assert.doesNotMatch(content, /statusChanged && captureArmed && hostStatus === 'waiting' && sawStream/);
});

test('ChatGPT usa el data-message-id del último assistant como identidad de turno', () => {
  assert.match(content, /host\.hostId === 'chatgpt'/);
  assert.match(content, /\[data-message-author-role="assistant"\]/);
  assert.match(content, /getAttribute\('data-message-id'\)/);
});
