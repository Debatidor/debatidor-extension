/**
 * HostAdapter P0 — Qwen (chat.qwen.ai)
 * SELECTOR_VERSION: 2026-08-qwen-studio
 * If none of these match, status = error. Never press Enter blindly.
 */
(function attachQwenAdapter(global) {
  const SELECTOR_VERSION = '2026-08-qwen-studio';
  const COMPOSER = [
    'textarea.message-input-textarea',
    'textarea[class*="message-input"]',
    'textarea[placeholder]',
    'div[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"].ql-editor',
  ];
  const SEND = [
    '.message-input-right-button-send',
    'button[class*="send"]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="Enviar" i]',
  ];
  const THINKING = [
    '.response-message-content.phase-thinking',
    '.response-message-content.phase-reason',
    '[class*="phase-thinking"]',
    '[class*="thinking-panel"]',
    '[class*="reasoning"]',
  ];
  const STOP = [
    '[aria-label*="Stop" i]',
    '[aria-label*="stop generating" i]',
    '[aria-label*="Detener" i]',
    'button[class*="stop"]',
  ];
  const ANSWER = [
    '.response-message-content.phase-answer',
    '.qwen-chat-message-assistant .markdown-body',
    '.qwen-chat-message-assistant',
    '[class*="assistant"] [class*="markdown"]',
  ];
  const COPY = ['.copy-response-button', 'button[aria-label*="Copy" i]'];
  const ASSISTANT = ['.qwen-chat-message-assistant', '[class*="message-assistant"]'];

  let composerSeenAt = 0;

  function first(selectors) {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node) {
        return node;
      }
    }
    return null;
  }

  function lastMatch(selectors) {
    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      if (nodes.length) {
        return nodes[nodes.length - 1];
      }
    }
    return null;
  }

  function composer() {
    return first(COMPOSER);
  }

  function setNativeValue(el, value) {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const proto = Object.getOwnPropertyDescriptor(
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype,
        'value',
      )?.set;
      proto?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    el.focus();
    el.innerText = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
  }

  global.__debatidorHost = {
    hostId: 'qwen',
    selectorVersion: SELECTOR_VERSION,
    matches(url) {
      return /chat\.qwen\.ai/i.test(url);
    },
    detectStatus() {
      const box = composer();
      if (!box) {
        if (!composerSeenAt && document.readyState !== 'complete') {
          return 'waiting';
        }
        if (!composerSeenAt) {
          composerSeenAt = Date.now();
        }
        return Date.now() - composerSeenAt < 8000 ? 'waiting' : 'error';
      }
      composerSeenAt = Date.now();

      if (first(THINKING)) {
        return 'thinking';
      }
      if (first(STOP)) {
        return 'generating';
      }
      if (box instanceof HTMLTextAreaElement && box.disabled) {
        return 'generating';
      }
      if (box.getAttribute('aria-disabled') === 'true') {
        return 'generating';
      }

      const answer = lastMatch(ANSWER);
      if (answer) {
        const shell = answer.closest(ASSISTANT.join(',')) ?? answer.parentElement;
        const hasCopy = Boolean(
          shell && COPY.some((selector) => shell.querySelector(selector)),
        );
        const text = (answer.innerText ?? '').trim();
        if (text && !hasCopy) {
          return 'generating';
        }
      }
      return 'waiting';
    },
    readAnswer() {
      return (lastMatch(ANSWER)?.innerText ?? '').trim();
    },
    injectPrompt(text) {
      const box = composer();
      const send = first(SEND);
      if (!box || !send) {
        return { ok: false, reason: 'composer_or_send_missing' };
      }
      box.focus();
      setNativeValue(box, text);
      send.click();
      return { ok: true };
    },
  };
})(globalThis);
