// Debatidor content script — observa generación en la página y se la pasa
// al service worker por un Port con reconexión automática.
//
// El SW de MV3 muere tras ~30s de inactividad; cuando eso pasa, el Port
// queda huérfano y port.postMessage lanza "Attempting to use a
// disconnected port object". Toda escritura pasa por send(), que detecta
// el puerto muerto, lo reabre y reintenta.

(() => {
  const host = globalThis.__debatidorHost;
  if (!host) return;

  const ALLOWED = new Set(['extension.dom_status', 'extension.dom_delta']);
  const PORT_NAME = 'debatidor-tab';
  const RETRY_MIN_MS = 500;
  const RETRY_MAX_MS = 8000;

  let port = null;
  let connectTimer = 0;
  let retryAttempts = 0;

  let lastStatus = null;
  let lastAnswer = '';
  let sequenceNumber = 0;
  let sawStream = false;
  let turnId = null;
  // Identidad derivada del host (conn_dom_qwen, conn_dom_openai, …): nunca
  // hardcodeada. El prompt dirigido a otro host se ignora.
  let connectionId = host.connectionId ?? 'conn_dom';
  let debateId = null;
  /** @type {'unknown' | 'enabled' | 'disabled'} */
  let injectionEnabled = 'unknown';

  connectPort();

  function connectPort() {
    clearTimeout(connectTimer);
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
    } catch {
      scheduleReconnect();
      return;
    }
    retryAttempts = 0;
    port.onMessage.addListener((msg) => {
      void onWire(msg);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      // SW suspendido o recargado: volver a levantar el puerto. Si el propio
      // contexto de extensión desapareció (reload/upgrade), el reintento
      // falla y queda backoff-eando hasta que la pestaña se recargue.
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (connectTimer) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** retryAttempts++);
    connectTimer = setTimeout(connectPort, delay);
  }

  // Keep-alive barato: cada mensaje recibido resetea el idle timer del SW.
  setInterval(() => {
    if (port) send({ type: 'ping' }, { quiet: true });
  }, 20000);

  async function onWire(msg) {
    if (msg?.type === 'config') {
      connectionId = msg.connectionId ?? connectionId;
      debateId = msg.debateId ?? debateId;
      injectionEnabled = Boolean(msg.enabled) ? 'enabled' : 'disabled';
      return;
    }
    if (msg?.type !== 'dom_prompt') return;
    if (injectionEnabled === 'disabled') return;
    // Prompt dirigido a otro host (multi-modelo): esta pestaña no interviene.
    if (msg.connectionId && msg.connectionId !== connectionId) return;
    const status = host.detectStatus();
    if (status === 'thinking' || status === 'generating') return;
    turnId = msg.turnId ?? turnId;
    lastAnswer = '';
    sequenceNumber = 0;
    sawStream = false;
    // La preamble de rol solo entra en un hilo fresco; en un hilo en curso
    // el contexto ya está y repetirla ensucia el chat visible.
    const preamble =
      msg.systemPreamble && host.isFreshConversation?.()
        ? `${msg.systemPreamble}\n\n`
        : '';
    const result = await Promise.resolve(
      host.injectPrompt(`${preamble}${msg.promptText ?? ''}`),
    );
    if (!result?.ok) emit(statusEvent('error'));
  }

  // ------------------------------------------------------------ observer

  const observer = new MutationObserver(() => tick());
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  setInterval(tick, 400);
  tick();

  function tick() {
    if (injectionEnabled === 'disabled') return;
    const status = host.detectStatus();
    if (status === 'thinking' || status === 'generating') sawStream = true;
    if (status !== lastStatus) {
      lastStatus = status;
      emit(statusEvent(status));
      if (status === 'waiting' && sawStream) {
        // chat-v2 a veces renderiza la respuesta de golpe (thinking → waiting
        // sin una fase 'generating' observable con texto). Leer la respuesta
        // final directo del host en vez de depender de los deltas intermedios.
        const finalText = host.readAnswer() || lastAnswer;
        if (finalText) {
          if (finalText !== lastAnswer) sequenceNumber += 1;
          lastAnswer = finalText;
          emit(deltaEvent(finalText, true));
          console.debug(`[debatidor] turno completo emitido (${finalText.length} chars)`);
        }
        sawStream = false;
      }
    }
    if (status === 'generating') {
      const current = host.readAnswer();
      if (current && current !== lastAnswer) {
        const suffix = current.startsWith(lastAnswer) ? current.slice(lastAnswer.length) : current;
        lastAnswer = current;
        sequenceNumber += 1;
        emit(deltaEvent(suffix, false));
      }
    }
  }

  // -------------------------------------------------------------- output

  function emit(payload) {
    if (!ALLOWED.has(payload.event)) return;
    send({ type: 'wire', payload });
  }

  /**
   * Envía por el puerto; si está muerto lo reconecta y reintenta una vez.
   * @returns {boolean} true si el mensaje salió.
   */
  function send(msg, { quiet = false } = {}) {
    if (port) {
      try {
        port.postMessage(msg);
        return true;
      } catch (err) {
        if (!quiet && String(err).includes('disconnected')) {
          console.warn('[debatidor] puerto muerto, reconectando…');
        }
        port = null;
        clearTimeout(connectTimer); // cancelar backoff pendiente
        connectTimer = 0;
        connectPort(); // reconexión inmediata
      }
    }
    // Reintento único si el puerto nuevo ya está vivo.
    if (port) {
      try {
        port.postMessage(msg);
        return true;
      } catch {
        /* caerá en el próximo tick */
      }
    }
    return false;
  }

  // --------------------------------------------------------------- events

  function statusEvent(status) {
    return {
      event: 'extension.dom_status',
      data: {
        connectionId,
        debateId,
        turnId,
        status,
        hostId: host.hostId,
        selectorVersion: host.selectorVersion,
      },
    };
  }

  function deltaEvent(contentDelta, isComplete) {
    return {
      event: 'extension.dom_delta',
      data: {
        connectionId,
        debateId,
        turnId,
        contentDelta,
        isComplete,
        sequenceNumber,
      },
    };
  }
})();
