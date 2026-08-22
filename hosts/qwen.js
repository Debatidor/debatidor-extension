/**
 * HostAdapter P0 — Qwen Studio (chat.qwen.ai)
 * SELECTOR_VERSION: 2026-06-qwen-studio
 * Si estos selectores no matchean: status = error. Prohibido Enter a ciegas.
 */
(function attachQwenAdapter(global) {
  const SELECTOR_VERSION = '2026-06-qwen-studio';
  const SELECTORS = {
    composer: 'textarea.message-input-textarea',
    send: '.message-input-right-button-send',
    assistant: '.qwen-chat-message-assistant',
    answer: '.response-message-content.phase-answer',
    thinking: '.response-message-content.phase-thinking, .response-message-content.phase-reason',
    copy: '.copy-response-button',
    stop: '[aria-label*="Stop" i], [aria-label*="stop generating" i]',
  };

  function composer() {
    return document.querySelector(SELECTORS.composer);
  }

  function lastAnswer() {
    const nodes = document.querySelectorAll(SELECTORS.answer);
    return nodes[nodes.length - 1] ?? null;
  }

  function setNativeValue(el, value) {
    const proto = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    proto?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  global.__debatidorHost = {
    hostId: 'qwen',
    selectorVersion: SELECTOR_VERSION,
    matches(url) {
      return /chat\.qwen\.ai/i.test(url);
    },
    detectStatus() {
      if (!composer()) {
        return 'error';
      }
      if (document.querySelector(SELECTORS.thinking)) {
        return 'thinking';
      }
      if (document.querySelector(SELECTORS.stop)) {
        return 'generating';
      }
      const answer = lastAnswer();
      if (answer && !answer.closest(SELECTORS.assistant)?.querySelector(SELECTORS.copy)) {
        const text = (answer.textContent ?? '').trim();
        if (text.length > 0) {
          return 'generating';
        }
      }
      return 'waiting';
    },
    readAnswer() {
      return (lastAnswer()?.innerText ?? '').trim();
    },
    injectPrompt(text) {
      const box = composer();
      const send = document.querySelector(SELECTORS.send);
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
