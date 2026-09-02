import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');

function loadHost(file) {
  const context = vm.createContext({
    document: {},
    window: {},
    console,
    URL,
  });
  const source = readFileSync(path.join(ROOT, 'hosts', file), 'utf8');
  return vm.runInContext(`${source}\n__debatidorHost`, context);
}

function loadZaiSendHarness() {
  class FakeTextArea {
    constructor() {
      this._value = '';
      this.isConnected = true;
    }

    focus() {}

    dispatchEvent() {
      return true;
    }
  }

  Object.defineProperty(FakeTextArea.prototype, 'value', {
    configurable: true,
    get() {
      return this._value;
    },
    set(value) {
      this._value = String(value);
    },
  });

  class FakeButton {
    constructor(onClick) {
      this.disabled = false;
      this.onClick = onClick;
    }

    getAttribute() {
      return null;
    }

    click() {
      this.onClick?.();
    }
  }

  class FakeEvent {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  }

  let currentBox = new FakeTextArea();
  let detachedBox = null;
  const users = [];

  const send = new FakeButton(() => {
    // Comportamiento observado en Z.ai/Svelte: el click sí envía el mensaje,
    // pero el textarea usado para escribir se desmonta y queda con su value.
    detachedBox = currentBox;
    detachedBox.isConnected = false;
    currentBox = new FakeTextArea();
    users.push({});
  });

  const document = {
    readyState: 'complete',
    querySelector(selector) {
      if (selector.startsWith('textarea')) return currentBox;
      if (selector.includes('send-message-button') || selector.includes('Send Message')) return send;
      if (selector.includes('Stop')) return null;
      if (selector === '.chat-assistant') return null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.chat-user') return users;
      if (selector === '.chat-assistant') return [];
      return [];
    },
  };

  const context = vm.createContext({
    document,
    window: {},
    console,
    URL,
    Date,
    Promise,
    setTimeout,
    clearTimeout,
    HTMLTextAreaElement: FakeTextArea,
    HTMLButtonElement: FakeButton,
    Event: FakeEvent,
    KeyboardEvent: FakeEvent,
  });
  const source = readFileSync(path.join(ROOT, 'hosts', 'zai.js'), 'utf8');
  const host = vm.runInContext(`${source}\n__debatidorHost`, context);

  return {
    host,
    users,
    currentBox: () => currentBox,
    detachedBox: () => detachedBox,
  };
}

test('manifest inyecta Z.ai en dominio raíz y subdominios', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const entry = manifest.content_scripts.find((cs) => cs.js.includes('hosts/zai.js'));
  assert.ok(entry, 'falta content_script de Z.ai');
  assert.ok(entry.matches.includes('https://z.ai/*'));
  assert.ok(entry.matches.includes('https://*.z.ai/*'));
  assert.ok(entry.js.includes('content.js'));
  assert.equal(entry.run_at, 'document_idle');
});

test('host Z.ai expone identidad y contrato completos', () => {
  const host = loadHost('zai.js');
  assert.equal(host.hostId, 'zai');
  assert.equal(host.providerId, 'zai');
  assert.equal(host.connectionId, 'conn_dom_zai');
  assert.ok(host.selectorVersion);
  for (const method of [
    'matches',
    'getAnswerKey',
    'detectStatus',
    'readAnswer',
    'isFreshConversation',
    'injectPrompt',
  ]) {
    assert.equal(typeof host[method], 'function', `falta ${method}`);
  }
});

test('host Z.ai matchea z.ai/chat.z.ai y no invade otros hosts', () => {
  const host = loadHost('zai.js');
  assert.ok(host.matches('https://z.ai/'));
  assert.ok(host.matches('https://chat.z.ai/c/abc'));
  assert.ok(host.matches('https://foo.z.ai/'));
  assert.ok(!host.matches('https://chatgpt.com/'));
  assert.ok(!host.matches('https://chat.qwen.ai/'));
});

test('adapter Z.ai usa selectores semánticos del snapshot y evita ids volátiles', () => {
  const source = readFileSync(path.join(ROOT, 'hosts', 'zai.js'), 'utf8');
  assert.match(source, /textarea#chat-input/);
  assert.match(source, /placeholder=\\?['"]Send a Message/);
  assert.match(source, /button#send-message-button/);
  assert.match(source, /aria-label=\\?['"]Stop/);
  assert.match(source, /\.chat-assistant/);
  assert.match(source, /#response-content-container/);
  assert.match(source, /regenerate-response-button/);
  assert.doesNotMatch(source, /bits-c\d+/);
  assert.doesNotMatch(source, /svelte-[a-z0-9]+/i);
});

test('Z.ai acepta el envío si Svelte reemplaza el composer aunque el textarea viejo conserve texto', async () => {
  const env = loadZaiSendHarness();
  const prompt = '[Resultado de fs.read path=CURRENT_STATE.md]';

  const result = await env.host.injectPrompt(prompt);

  assert.equal(result.ok, true);
  assert.equal(result.via, 'button');
  assert.equal(result.ack, 'user_message');
  assert.equal(env.users.length, 1);
  assert.equal(env.detachedBox()?.value, prompt, 'el textarea viejo conserva el texto del prompt');
  assert.equal(env.currentBox().value, '', 'el composer vivo ya está limpio');
});

test('popup registra Z.ai y mantiene un solo CTA visible para abrir agentes', () => {
  const source = readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  assert.match(source, /'chat\.z\.ai'/);
  assert.match(source, /domains:\s*\['chat\.z\.ai',\s*'z\.ai'\]/);
  assert.match(source, /function liveHosts\(\)/);
  assert.match(source, /function renderAgentPicker\(\)/);
  assert.match(source, /for \(const host of hosts\)/);
  assert.match(source, /menu\.replaceChildren\(\)/);

  const html = readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
  const emptyView = html.split('id="view-empty"')[1]?.split('</main>')[0] ?? '';
  assert.match(emptyView, /id="btn-open-agent"/);
  assert.match(emptyView, /id="agent-picker-menu"/);
  assert.equal((emptyView.match(/class="button button--primary agent-picker-trigger"/g) ?? []).length, 1);
  assert.ok(!/open-host-buttons/.test(emptyView));
  assert.ok(!/btn-open-(qwen|chatgpt|zai)/.test(emptyView));
});

test('picker deriva sus opciones del catálogo sin hardcodear CTAs por provider', () => {
  const source = readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  const picker = source.split('function renderAgentPicker()')[1]?.split("async function renderAgentView")[0] ?? '';
  assert.match(picker, /const hosts = liveHosts\(\)/);
  assert.match(picker, /for \(const host of hosts\)/);
  assert.match(picker, /chrome\.tabs\.create\(\{ url: host\.url \}\)/);
  assert.doesNotMatch(picker, /Qwen|ChatGPT|Z\.ai/);
});

test('Qwen, ChatGPT y Z.ai usan connectionIds distintos', () => {
  const ids = ['qwen.js', 'chatgpt.js', 'zai.js'].map((file) => loadHost(file).connectionId);
  assert.equal(new Set(ids).size, ids.length);
});
