import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');
const content = readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const chatgpt = readFileSync(path.join(ROOT, 'hosts', 'chatgpt.js'), 'utf8');

test('ChatGPT expone identidad estable del último turno assistant', () => {
  assert.match(chatgpt, /getAnswerKey\(\)/);
  assert.match(chatgpt, /data-message-id/);
});

test('content captura respuestas instantáneas aunque no observe generating', () => {
  assert.match(content, /armedAnswerKey/);
  assert.match(content, /sawOwnedAnswer/);
  assert.match(content, /host\.getAnswerKey\?\.\(\)/);
  assert.match(content, /sawStream \|\| sawOwnedAnswer/);
  assert.doesNotMatch(content, /statusChanged && captureArmed && hostStatus === 'waiting' && sawStream/);
});
