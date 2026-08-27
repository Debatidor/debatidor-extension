/**
 * HostAdapter P0 — Qwen (chat.qwen.ai)
 * SELECTOR_VERSION: 2026-08-qwen-studio
 * If none of these match, status = error. Never press Enter blindly.
 */
(function attachQwenAdapter(global) {
  const SELECTOR_VERSION = '2026-08-qwen-chatv2-think5';
  const COMPOSER = [
    'textarea.message-input-textarea',
    'textarea[class*="message-input"]',
    'textarea[placeholder]',
    'div[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"].ql-editor',
  ];
  const SEND = [
    '.chat-prompt-send-button button.send-button',
    '.message-input-right-button-send button.send-button',
    '.message-input-right-button-send button',
    'button[aria-label="Send"]',
    'button[aria-label*="Send" i]',
    'button[class*="send"]',
  ];
  const THINKING = [
    // Tarjeta de thinking ACTIVA (chat-v2): clases SIN la palabra "thinking".
    // El título animado + el botón "Skip" solo existen mientras piensa.
    // OJO: NO usar [class*="thinking-status-card"]:not([class*="completed"])
    // — los HIJOS de la tarjeta completada (icon/content/title) contienen el
    // substring sin tener "completed" ellos mismos, y el :not() evalúa por
    // elemento → detector envenenado, estado atascado en thinking eterno.
    '.qwen-chat-status-card',
    '[class*="status-card-answer-now"]',
    '[class*="status-card-title-animate"]',
    '.response-message-content.phase-thinking',
    '.response-message-content.phase-reason',
  ];
  const STOP = [
    '[aria-label*="Stop" i]',
    '[aria-label*="stop generating" i]',
    '[aria-label*="Detener" i]',
    'button[class*="stop"]',
  ];
  const ANSWER = [
    '.response-message-content.phase-answer',
    '.qwen-chat-message-assistant .custom-qwen-markdown',
    '.qwen-chat-message-assistant .qwen-markdown',
    '.qwen-chat-message-assistant .markdown-body',
    '.qwen-chat-message-assistant',
    '[class*="assistant"] [class*="markdown"]',
  ];
  // Qwen Studio puede insertar una evaluación A/B server-side que exige una
  // preferencia humana antes de continuar. No debemos leer ninguno de los dos
  // candidatos como respuesta autoritativa ni hacer click automáticamente: el
  // botón registra feedback del usuario. Mientras exista, el turno sigue vivo.
  const PREFERENCE_GATE = [
    '.qwen-chat-message-dual-message.qwen-chat-message-awaiting-response',
    '.smrm .smrm-card__prefer-btn',
  ];
  // Completion signal: the action footer (Regenerate et al) only renders
  // once the answer is final. The copy button exists from the start, so it
  // is NOT a completion signal in chat-v2.
  const DONE_MARKS = [
    '[class*="action-control-container-regenerate"]',
    'button[aria-label*="Regenerate" i]',
  ];
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

  function preferenceGateActive() {
    return Boolean(first(PREFERENCE_GATE));
  }

  /**
   * chat-v2 trampa doble: la tarjeta ACTIVA usa clases qwen-chat-status-card*
   * (sin substring "thinking") y la COMPLETADA usa qwen-chat-thinking-*-
   * completed. Detectar activo = presencia de la tarjeta activa o un título
   * de thinking que aún no diga "completed".
   */
  function thinkingActive() {
    if (first(THINKING)) return true;
    const titles = document.querySelectorAll('[class*="status-card-title"]');
    for (const node of titles) {
      // Un título dentro de una tarjeta completada no cuenta como activo.
      if (node.closest('[class*="completed"]')) continue;
      if (!/completed|completado/i.test(node.textContent ?? '')) return true;
    }
    return false;
  }

  /** Último nodo de respuesta que NO viva dentro del panel de thinking. */
  function answerNode() {
    for (const selector of ANSWER) {
      const nodes = document.querySelectorAll(selector);
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        const node = nodes[i];
        if (node.closest('[class*="thinking-tool-status-card"]')) continue;
        return node;
      }
    }
    return null;
  }

  function answerText(node) {
    if (!node) return '';
    if (node.querySelector('[class*="thinking"], [class*="status-card"]')) {
      // Fallback amplio (contenedor entero del assistant): extirpar el UI de
      // thinking (tarjeta activa qwen-chat-status-card* Y completada
      // qwen-thinking-*) para no transmitir "Prepararme para el debate… Skip".
      const clone = node.cloneNode(true);
      for (const el of clone.querySelectorAll(
        '[class*="thinking"], [class*="status-card"], .response-message-footer',
      )) {
        el.remove();
      }
      return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
    }
    return (node.innerText ?? '').trim();
  }

  function isDone(node) {
    const shell = node.closest(ASSISTANT.join(',')) ?? node.parentElement;
    return Boolean(shell && DONE_MARKS.some((selector) => shell.querySelector(selector)));
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
    providerId: 'qwen',
    connectionId: 'conn_dom_qwen',
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

      // Qwen A/B: el composer queda bloqueado hasta que el usuario elija. Lo
      // tratamos como turno aún en progreso para que content.js NO finalice un
      // candidato arbitrario y reanude automáticamente tras la elección.
      if (preferenceGateActive()) {
        return 'generating';
      }

      // 1) Thinking explícito (tarjeta sin "-completed" o título activo).
      if (thinkingActive()) {
        return 'thinking';
      }
      // 2) Botón de stop visible = generando, PERO en chat-v2 aparece desde
      //    el primer token de thinking; solo es concluyente fuera de thinking.
      if (first(STOP)) {
        return 'generating';
      }
      if (box instanceof HTMLTextAreaElement && box.disabled) {
        return 'generating';
      }
      if (box.getAttribute('aria-disabled') === 'true') {
        return 'generating';
      }

      // 3) La barra de acciones final es la señal autoritativa de completion.
      // El DOM adjunto de Qwen 2026-08 mostró que Monaco puede seguir
      // re-renderizando internamente el bloque JSON aun con Regenerate visible;
      // usar cambios de innerText como settle mantenía el estado en generating
      // indefinidamente. El settle de lectura final vive en content.js.
      const node = answerNode();
      const text = answerText(node);
      if (text) {
        if (isDone(node)) return 'waiting';
        return 'generating';
      }
      return 'waiting';
    },
    readAnswer() {
      // Nunca serializar candidatos de una evaluación A/B: solo después de la
      // elección humana existe una respuesta autoritativa que Debatidor puede
      // ejecutar como tool-call.
      if (preferenceGateActive()) return '';
      const node = answerNode();
      return answerText(node);
    },
    /**
     * true si el hilo no tiene respuestas del assistant aún: único momento
     * en que tiene sentido inyectar la preamble de rol (después, el propio
     * hilo ya lleva el contexto y mandarla de nuevo es spam visible).
     */
    isFreshConversation() {
      return !document.querySelector(ASSISTANT.join(','));
    },
    injectPrompt(text) {
      if (preferenceGateActive()) {
        return { ok: false, reason: 'preference_required' };
      }
      const box = composer();
      if (!box) {
        return { ok: false, reason: 'composer_missing' };
      }
      box.focus();
      setNativeValue(box, text);
      const send = first(SEND);
      const disabled =
        send instanceof HTMLButtonElement &&
        (send.disabled || send.getAttribute('aria-disabled') === 'true');
      if (send && !disabled) {
        send.click();
        return { ok: true, via: 'button' };
      }
      // Fallback: Qwen envía con Enter desde el composer enfocado.
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
      return { ok: true, via: 'enter' };
    },
  };
})(globalThis);
