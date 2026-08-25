/**
 * HostAdapter — ChatGPT (chatgpt.com)
 * SELECTOR_VERSION: 2026-08-chatgpt-prosemirror-1
 *
 * Trampas del DOM actual (verificadas con snapshots reales del CEO, 2026-08-25):
 *
 * 1. COMPOSER ProseMirror: el input real es `div#prompt-textarea.ProseMirror`
 *    (contenteditable). Hay un <textarea name="prompt-textarea"> PERO vive con
 *    `display:none` (fallback SSR): escribirle NO produce nada visible.
 * 2. BOTÓN ENVIAR CONDICIONAL: con el composer VACÍO, el botón de la esquina
 *    es de VOZ ("Iniciar voz"). El botón ENVIAR
 *    (#composer-submit-button[data-testid="send-button"]) SOLO existe cuando
 *    hay texto en el composer. Jamás asumir que el botón visible es "send".
 * 3. STREAMING: durante la generación el slot muestra el botón de STOP y el
 *    scroll-root toma data-stream-active="true" (lo delatan las clases
 *    utilitarias group-data-stream-active/*). Señales concluyentes de
 *    "generando" incluso en la fase thinking de gpt-5 (turno assistant creado
 *    pero aún sin markdown).
 * 4. DONE: el footer de acciones del assistant
 *    (aria-label="Acciones de respuesta" con [data-testid="copy-turn-action-button"])
 *    solo se renderiza al terminar la respuesta — misma lección de Qwen:
 *    el footer ES la señal de cierre, no el botón copiar suelto.
 * 5. PROHIBIDO anclarse a ids radix (_r_3s_) o clases hash (uFxlGa_*,
 *    wcDTda_*, e33vkq_*): son volátiles entre deploys.
 */
(function attachChatGPTAdapter(global) {
  const SELECTOR_VERSION = '2026-08-chatgpt-prosemirror-1';

  const COMPOSER = [
    'div#prompt-textarea.ProseMirror[contenteditable="true"]',
    '#prompt-textarea.ProseMirror',
    'form[data-type="unified-composer"] [contenteditable="true"][role="textbox"]',
  ];
  const SEND = [
    '#composer-submit-button[data-testid="send-button"]',
    'form[data-type="unified-composer"] button[data-testid="send-button"]',
    'button#composer-submit-button',
  ];
  const STOP = [
    '[data-testid="stop-button"]',
    'button[aria-label*="detener" i]',
    'button[aria-label*="stop" i]',
    'button[aria-label*="Dejar de generar" i]',
  ];
  const STREAM_ACTIVE = '[data-stream-active="true"]';
  const ASSISTANT = '[data-message-author-role="assistant"]';
  const ANSWER_BODY = '.markdown, .markdown-new-styling';
  const DONE_MARKS = [
    '[data-testid="copy-turn-action-button"]',
    '[aria-label*="Acciones de respuesta" i]',
    'button[aria-label*="Copiar respuesta" i]',
  ];

  let composerSeenAt = 0;
  let answerKey = '';
  let answerSnapshot = '';
  let answerChangedAt = 0;
  let footerSeenAt = 0;
  const SETTLE_MS = 900;

  function trackAnswer(text, node) {
    // Cambio de turno (otro message-id): resetear el snapshot para no
    // comparar peras con manzanas ni producir sufijos basura.
    const key = node?.getAttribute('data-message-id') ?? '';
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

  function first(selectors) {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node) return node;
    }
    return null;
  }

  function composer() {
    return first(COMPOSER);
  }

  function composerText(el) {
    return (el?.innerText ?? '').trim();
  }

  /** Último turno del assistant (la respuesta en curso o recién terminada). */
  function answerNode() {
    const nodes = document.querySelectorAll(ASSISTANT);
    return nodes.length ? nodes[nodes.length - 1] : null;
  }

  function answerText(node) {
    if (!node) return '';
    const body = node.querySelector(ANSWER_BODY) ?? node;
    return (body.innerText ?? '').trim();
  }

  /**
   * El footer de acciones del turno SOLO existe con la respuesta completa.
   * ⚠️ SCOPING: hay que buscarlo en la SECCIÓN del turno
   * (section[data-turn="assistant"]), NO en el div del mensaje:
   * en el DOM real el footer es HERMANO de [data-message-author-role],
   * no descendiente — scoping al mensaje = footer invisible = turno
   * eternamente 'generating' (bug de producción 2026-08-25).
   */
  function isDone(node) {
    const shell =
      node.closest('section[data-turn="assistant"], [data-testid^="conversation-turn"]') ??
      node.parentElement ??
      node;
    return Boolean(shell && DONE_MARKS.some((sel) => shell.querySelector(sel)));
  }

  /** Inserta texto en el ProseMirror respetando su editor (execCommand). */
  function insertText(el, text) {
    el.focus();
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, text);
    } catch {
      ok = false;
    }
    if (!ok || composerText(el) === '') {
      // Fallback: escritura directa + evento de input (ProseMirror suele
      // levantar el valor del DOM en el submit).
      el.textContent = text;
      el.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
      );
    }
    return text === '' || composerText(el).length > 0;
  }

  global.__debatidorHost = {
    hostId: 'chatgpt',
    providerId: 'openai',
    connectionId: 'conn_dom_openai',
    selectorVersion: SELECTOR_VERSION,
    matches(url) {
      return /chatgpt\.com|chat\.openai\.com/i.test(url);
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

      const node = answerNode();
      const text = answerText(node);
      trackAnswer(text, node);
      const footerDone = node ? isDone(node) : false;
      if (!footerDone) {
        footerSeenAt = 0;
      } else if (!footerSeenAt) {
        footerSeenAt = Date.now();
      }

      // 1) SEÑAL PRIMARIA: footer del turno + settle por TIEMPO DEL FOOTER
      //    (no por estabilidad del texto: el innerText oscila por el
      //    re-render del visor de código). El footer GANA sobre cualquier
      //    flag de stream pegado (data-stream-active queda true tras acabar).
      if (footerDone && Date.now() - footerSeenAt >= SETTLE_MS) {
        return 'waiting';
      }
      if (footerDone) return 'generating'; // settle breve tras el footer

      // 2) Flags de generación (incluyen la fase thinking de gpt-5).
      const hardBusy =
        Boolean(document.querySelector(STREAM_ACTIVE)) || Boolean(first(STOP));
      if (hardBusy) return 'generating';

      // 3) Sin footer aún: con texto → generando; sin texto → thinking.
      if (node && !text) return 'thinking';
      if (text) return 'generating';
      return 'waiting';
    },
    readAnswer() {
      return answerText(answerNode());
    },
    /**
     * true si el hilo no tiene respuestas del assistant aún: único momento
     * en que tiene sentido inyectar la preamble/contrato de herramientas
     * (después, el propio hilo ya lleva el contexto y repetirlo es spam).
     */
    isFreshConversation() {
      return !document.querySelector(ASSISTANT);
    },
    async injectPrompt(text) {
      const box = composer();
      if (!box) {
        return { ok: false, reason: 'composer_missing' };
      }
      box.focus();
      if (!insertText(box, text)) {
        return { ok: false, reason: 'insert_failed' };
      }
      // ⚠️ El botón ENVIAR solo existe cuando React ya procesó el texto
      // (un tick después de insertar). Consultarlo inmediatamente = no existe
      // → caeríamos al Enter sintético, que ChatGPT ignora (no es trusted).
      // Espera activa breve por el botón; luego click + VERIFICACIÓN de que
      // el composer quedó vacío (el mensaje realmente se fue). Si no se fue,
      // reintento con Enter real sintetizado vía keydown/keyup.
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let send = null;
      for (let attempt = 0; attempt < 10 && !send; attempt += 1) {
        send = first(SEND);
        const disabled =
          send instanceof HTMLButtonElement &&
          (send.disabled || send.getAttribute('aria-disabled') === 'true');
        if (!send || disabled) {
          send = null;
          await sleep(120);
        }
      }
      if (send) {
        send.click();
        await sleep(250);
      }
      if (composerText(box) !== '') {
        // El click no bastó (o nunca hubo botón): Enter desde el composer.
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
        await sleep(350);
      }
      if (composerText(box) !== '') {
        return { ok: false, reason: 'send_unverified' };
      }
      return { ok: true, via: send ? 'button' : 'enter' };
    },
  };
})(globalThis);
