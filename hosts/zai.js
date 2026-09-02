/**
 * HostAdapter — Z.ai / GLM (z.ai, chat.z.ai)
 * SELECTOR_VERSION: 2026-09-zai-dom-2
 *
 * Selectores derivados de snapshots reales del DOM de z.ai (2026-09-02):
 * - composer: textarea#chat-input
 * - send: button#send-message-button
 * - generación: control aria-label="Stop"
 * - respuesta: .chat-assistant #response-content-container
 * - completion: .regenerate-response-button / aria-label="Regenerate"
 *
 * No se usan ids `bits-*` ni clases `svelte-*`: son artefactos volátiles.
 */
(function attachZaiAdapter(global) {
  const SELECTOR_VERSION = '2026-09-zai-dom-2';
  const COMPOSER = [
    'textarea#chat-input',
    'textarea[placeholder="How can I help you today?"]',
    'textarea[placeholder="Send a Message"]',
  ];
  const SEND = [
    'button#send-message-button',
    'button[aria-label="Send Message"]',
  ];
  const STOP = [
    '[aria-label="Stop"]',
    'button[aria-label*="Stop" i]',
  ];
  const ASSISTANT = '.chat-assistant';
  const USER = '.chat-user';
  const RESPONSE = '#response-content-container';
  const THINKING = '.thinking-chain-container';
  const DONE_MARKS = [
    'button.regenerate-response-button',
    '[aria-label="Regenerate"]',
  ];

  let composerSeenAt = 0;
  let answerKey = '';
  let answerSnapshot = '';
  let answerChangedAt = 0;
  const DONE_SETTLE_MS = 550;
  const FALLBACK_SETTLE_MS = 3000;
  const SEND_ACK_TIMEOUT_MS = 2200;

  function first(selectors, root = document) {
    for (const selector of selectors) {
      const node = root.querySelector?.(selector);
      if (node) return node;
    }
    return null;
  }

  function composer() {
    return first(COMPOSER);
  }

  function composerText(el) {
    return String(el?.value ?? '').trim();
  }

  function userMessageCount() {
    return document.querySelectorAll(USER).length;
  }

  function assistantNode() {
    const nodes = document.querySelectorAll(ASSISTANT);
    return nodes.length ? nodes[nodes.length - 1] : null;
  }

  function answerNode() {
    const assistant = assistantNode();
    return assistant?.querySelector(RESPONSE) ?? assistant;
  }

  function messageShell() {
    const assistant = assistantNode();
    return assistant?.closest('[id^="message-"]') ?? assistant?.parentElement ?? assistant;
  }

  function answerText(node) {
    if (!node) return '';
    const clone = node.cloneNode(true);
    for (const el of clone.querySelectorAll(
      `${THINKING}, button, [role="button"], .sr-only, svg`,
    )) {
      el.remove();
    }
    const text = (clone.innerText ?? clone.textContent ?? '')
      .replace(/[\u00a0\u2007\u202f]/g, ' ')
      .trim();
    return text;
  }

  function currentAnswerKey() {
    const shell = messageShell();
    return shell?.id ?? '';
  }

  function trackAnswer(text) {
    const key = currentAnswerKey();
    if (key !== answerKey) {
      answerKey = key;
      answerSnapshot = '';
      answerChangedAt = Date.now();
    }
    if (text !== answerSnapshot) {
      answerSnapshot = text;
      answerChangedAt = Date.now();
    }
  }

  function isDone() {
    const shell = messageShell();
    return Boolean(shell && DONE_MARKS.some((selector) => shell.querySelector(selector)));
  }

  function setNativeValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value === value;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Z.ai/Svelte puede desmontar el textarea original justo después del click.
   * Verificar `box.value` sobre esa referencia vieja produce un falso
   * send_unverified aunque el mensaje ya figure en el hilo. La confirmación
   * debe observar el DOM VIVO: nuevo user-message, Stop o composer actual vacío.
   */
  async function waitForSendAck(originalBox, userCountBefore) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < SEND_ACK_TIMEOUT_MS) {
      if (userMessageCount() > userCountBefore) {
        return { ok: true, ack: 'user_message' };
      }
      if (first(STOP)) {
        return { ok: true, ack: 'generation_started' };
      }
      const liveBox = composer();
      if (liveBox instanceof HTMLTextAreaElement && composerText(liveBox) === '') {
        return {
          ok: true,
          ack: liveBox === originalBox ? 'composer_cleared' : 'composer_replaced',
        };
      }
      await sleep(80);
    }
    return { ok: false, ack: 'timeout' };
  }

  function dispatchEnter(box) {
    const key = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    };
    box.dispatchEvent(new KeyboardEvent('keydown', key));
    box.dispatchEvent(new KeyboardEvent('keypress', key));
    box.dispatchEvent(new KeyboardEvent('keyup', key));
  }

  global.__debatidorHost = {
    hostId: 'zai',
    providerId: 'zai',
    connectionId: 'conn_dom_zai',
    selectorVersion: SELECTOR_VERSION,
    matches(url) {
      try {
        const hostname = new URL(url).hostname.toLowerCase();
        return hostname === 'z.ai' || hostname.endsWith('.z.ai');
      } catch {
        return false;
      }
    },
    getAnswerKey() {
      return currentAnswerKey();
    },
    detectStatus() {
      const box = composer();
      if (!box) {
        if (!composerSeenAt && document.readyState !== 'complete') return 'waiting';
        if (!composerSeenAt) composerSeenAt = Date.now();
        return Date.now() - composerSeenAt < 8000 ? 'waiting' : 'error';
      }
      composerSeenAt = Date.now();

      const node = answerNode();
      const text = answerText(node);
      trackAnswer(text);
      const stopVisible = Boolean(first(STOP));
      const textStableFor = Date.now() - answerChangedAt;

      // En el snapshot real el mismo Stop cubre thinking y respuesta. Si aún
      // no hay cuerpo de respuesta, distinguimos thinking; con texto ya es
      // generación normal. content.js considera ambos estados como turno vivo.
      if (stopVisible) return text ? 'generating' : 'thinking';

      if (text) {
        if (isDone() && textStableFor >= DONE_SETTLE_MS) return 'waiting';
        if (textStableFor >= FALLBACK_SETTLE_MS) return 'waiting';
        return 'generating';
      }
      return 'waiting';
    },
    readAnswer() {
      return answerText(answerNode());
    },
    isFreshConversation() {
      return !document.querySelector(ASSISTANT);
    },
    async injectPrompt(text) {
      const box = composer();
      if (!(box instanceof HTMLTextAreaElement)) {
        return { ok: false, reason: 'composer_missing' };
      }
      box.focus();
      if (!setNativeValue(box, text)) {
        return { ok: false, reason: 'insert_failed' };
      }

      const userCountBefore = userMessageCount();
      let send = null;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const candidate = first(SEND);
        const disabled =
          candidate instanceof HTMLButtonElement &&
          (candidate.disabled || candidate.getAttribute('aria-disabled') === 'true');
        if (candidate && !disabled) {
          send = candidate;
          break;
        }
        await sleep(100);
      }

      if (send) {
        send.click();
        const ack = await waitForSendAck(box, userCountBefore);
        if (ack.ok) return { ok: true, via: 'button', ack: ack.ack };
      }

      // Fallback: reconsultar el composer VIVO. Nunca teclear Enter sobre el
      // textarea viejo si Svelte ya lo desmontó/reemplazó.
      const liveBox = composer();
      if (!(liveBox instanceof HTMLTextAreaElement)) {
        return { ok: false, reason: 'send_unverified' };
      }
      if (composerText(liveBox) !== '') {
        dispatchEnter(liveBox);
        const ack = await waitForSendAck(liveBox, userCountBefore);
        if (ack.ok) return { ok: true, via: 'enter', ack: ack.ack };
      }

      return { ok: false, reason: 'send_unverified' };
    },
  };
})(globalThis);
