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
  // Reafirmar el estado aunque no haya transición evita que el backend se
  // quede con un `generating` viejo si Chrome cerró el Port por BFCache.
  const STATUS_HEARTBEAT_MS = 10000;

  let port = null;
  let connectTimer = 0;
  let retryAttempts = 0;
  let pageFrozen = false;

  let lastStatus = null;
  let lastStatusSentAt = 0;
  let lastAnswer = '';
  let completedEmitted = false;
  let sequenceNumber = 0;
  let sawStream = false;
  let settleTimer = 0;
  let lastProgressAt = 0;
  let turnId = null;
  // Solo capturamos contenido generado como consecuencia de un dom_prompt
  // que esta pestaña aceptó. Una conversación manual del usuario puede estar
  // generando en paralelo, pero jamás debe convertirse en turn.delta del bus.
  let captureArmed = false;
  // Identidad del último answer existente JUSTO antes de inyectar el prompt.
  // ChatGPT puede producir un tool-call tan rápido que entre dos ticks de 400ms
  // nunca observemos thinking/generating. En ese caso el cambio de message-id
  // es la prueba de que apareció un turno nuevo propiedad de esta captura.
  let armedAnswerKey = '';
  let sawOwnedAnswer = false;
  // Identidad derivada del host (conn_dom_qwen, conn_dom_openai, …): nunca
  // hardcodeada ni reemplazada por el connectionId genérico del socket MV3.
  // El prompt dirigido a otro host se ignora.
  const hostConnectionId = host.connectionId ?? 'conn_dom';
  let connectionId = hostConnectionId;
  let debateId = null;
  let configuredDebateId = '';
  /** @type {'unknown' | 'enabled' | 'disabled'} */
  let injectionEnabled = 'unknown';

  connectPort();

  function connectPort() {
    clearTimeout(connectTimer);
    connectTimer = 0;
    if (pageFrozen) return;

    let nextPort;
    try {
      nextPort = chrome.runtime.connect({ name: PORT_NAME });
    } catch {
      scheduleReconnect();
      return;
    }

    port = nextPort;
    retryAttempts = 0;
    nextPort.onMessage.addListener((msg) => {
      void onWire(msg);
    });
    nextPort.onDisconnect.addListener(() => {
      // Leer lastError evita el ruido "Unchecked runtime.lastError" que Chrome
      // produce al mover una página con Port abierto al back/forward cache.
      void chrome.runtime.lastError;
      if (port === nextPort) port = null;
      if (!pageFrozen) scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (pageFrozen || connectTimer) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** retryAttempts++);
    connectTimer = setTimeout(connectPort, delay);
  }

  // Chrome cierra los extension Ports cuando una página entra al BFCache.
  // El contexto JS puede sobrevivir, por lo que al volver no podemos confiar
  // en timers/onDisconnect previos: reconectamos y forzamos re-publicación del
  // estado actual aunque localmente `lastStatus` siga diciendo waiting.
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) return;
    pageFrozen = true;
    clearTimeout(connectTimer);
    connectTimer = 0;
    const current = port;
    port = null;
    try {
      current?.disconnect();
    } catch {
      /* Chrome puede haberlo cerrado primero */
    }
  });

  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    pageFrozen = false;
    retryAttempts = 0;
    lastStatus = null;
    lastStatusSentAt = 0;
    connectPort();
  });

  // Keep-alive barato: cada mensaje recibido resetea el idle timer del SW.
  setInterval(() => {
    if (port && !pageFrozen) send({ type: 'ping' }, { quiet: true });
  }, 20000);

  function currentAnswerKey() {
    if (typeof host.getAnswerKey === 'function') {
      return String(host.getAnswerKey() ?? '');
    }
    // Compatibilidad inmediata con el DOM actual de ChatGPT sin obligar a que
    // todos los HostAdapter expongan todavía getAnswerKey(). Qwen conserva el
    // camino clásico sawStream hasta que adopte la misma primitiva.
    if (host.hostId === 'chatgpt') {
      const nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
      const node = nodes.length ? nodes[nodes.length - 1] : null;
      return node?.getAttribute('data-message-id') ?? '';
    }
    return '';
  }

  function resetCaptureIdentity() {
    armedAnswerKey = '';
    sawOwnedAnswer = false;
  }

  async function onWire(msg) {
    if (msg?.type === 'config') {
      // background.js registra UN socket genérico `conn_dom` para todas las
      // pestañas. Ese id es transporte, NO identidad del participante. Solo
      // aceptar una identidad específica si coincide con la declarada por el
      // HostAdapter; así Qwen y ChatGPT pueden convivir en el mismo browser.
      if (
        typeof msg.connectionId === 'string' &&
        msg.connectionId.startsWith('conn_dom_') &&
        msg.connectionId === hostConnectionId
      ) {
        connectionId = msg.connectionId;
      } else {
        connectionId = hostConnectionId;
      }
      configuredDebateId = String(msg.debateId ?? '').trim();
      // Una reconexión MV3 no cambia la identidad del turno ya en vuelo.
      if (!captureArmed) debateId = configuredDebateId || null;
      injectionEnabled = Boolean(msg.enabled) ? 'enabled' : 'disabled';
      if (injectionEnabled === 'disabled') {
        captureArmed = false;
        turnId = null;
        resetCaptureIdentity();
      }
      // Un Port nuevo (SW revivido, reload o BFCache restore) debe reafirmar
      // el estado incluso si no hubo transición DOM desde el Port anterior.
      lastStatus = null;
      lastStatusSentAt = 0;
      queueMicrotask(tick);
      return;
    }
    if (msg?.type !== 'dom_prompt') return;
    if (injectionEnabled !== 'enabled') return;
    // Prompt dirigido a otro host (multi-modelo): esta pestaña no interviene.
    if (msg.connectionId && msg.connectionId !== connectionId) return;
    if (msg.debateId && configuredDebateId && msg.debateId !== configuredDebateId) return;
    if (captureArmed) return;
    const status = host.detectStatus();
    if (status === 'thinking' || status === 'generating') {
      // El host está ocupado por una conversación ajena o un turno anterior:
      // no armar captura ni mezclar ese contenido con Debatidor.
      publishStatus(status, true);
      return;
    }
    debateId = msg.debateId || configuredDebateId || null;
    turnId = msg.turnId ?? null;
    lastAnswer = '';
    sequenceNumber = 0;
    sawStream = false;
    completedEmitted = false;
    lastProgressAt = 0;
    armedAnswerKey = currentAnswerKey();
    sawOwnedAnswer = false;
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = 0;
    }
    // Armamos ANTES del click/Enter: MutationObserver corre asíncronamente y
    // así no perdemos el primer cambio de DOM tras una inyección exitosa.
    captureArmed = true;
    // La preamble de rol solo entra en un hilo fresco; en un hilo en curso
    // el contexto ya está y repetirla ensucia el chat visible.
    const preamble =
      msg.systemPreamble && host.isFreshConversation?.()
        ? `${msg.systemPreamble}\n\n`
        : '';
    const result = await Promise.resolve(
      host.injectPrompt(`${preamble}${msg.promptText ?? ''}`),
    );
    if (!result?.ok) {
      captureArmed = false;
      turnId = null;
      resetCaptureIdentity();
      publishStatus('error', true);
    }
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

  function publishStatus(status, force = false) {
    const now = Date.now();
    if (!force && status === lastStatus && now - lastStatusSentAt < STATUS_HEARTBEAT_MS) {
      return false;
    }
    // IMPORTANTE: no avanzar lastStatus si el Port estaba muerto. De lo
    // contrario la transición se "consume" localmente y nunca se reintenta,
    // dejando al backend pegado en el estado anterior para siempre.
    if (!emit(statusEvent(status))) return false;
    lastStatus = status;
    lastStatusSentAt = now;
    return true;
  }

  function tick() {
    if (pageFrozen) return;
    if (injectionEnabled !== 'enabled') {
      publishStatus('waiting');
      return;
    }
    const hostStatus = host.detectStatus();
    const answerKey = currentAnswerKey();
    if (captureArmed && answerKey && answerKey !== armedAnswerKey) {
      sawOwnedAnswer = true;
    }
    // Fuera de un turno propiedad de Debatidor, el estado público de la
    // conexión permanece disponible. Esto evita que una respuesta manual en
    // ChatGPT/Qwen aparezca en el CLI como una intervención de conn_dom_*.
    const status = captureArmed
      ? hostStatus
      : hostStatus === 'error'
        ? 'error'
        : 'waiting';

    if (captureArmed && (hostStatus === 'thinking' || hostStatus === 'generating')) {
      sawStream = true;
    }

    publishStatus(status);

    const observedOwnedTurn = sawStream || sawOwnedAnswer;
    if (captureArmed && hostStatus === 'waiting' && observedOwnedTurn && !completedEmitted) {
      // ChatGPT puede completar tool-calls muy pequeños entre dos ticks de
      // 400ms: waiting(old) → respuesta completa → waiting(new), sin que jamás
      // observemos thinking/generating ni un cambio de status. Por eso el
      // gate usa también la identidad del nuevo assistant turn.
      //
      // ⚠️ UNA SOLA VEZ por turno: el DOM nuevo oscila waiting↔generating y
      // sin esta guarda el backend recibe DOS turn.completed → cada tool se
      // despacha dos veces → se queman los hops del guardrail (prod bug).
      //
      // ⚠️ SETTLE de lectura: el visor de código sigue montando su DOM
      // después de que el footer aparece — leer de inmediato puede capturar
      // un JSON cortado. Se relee tras un pequeño asentamiento y solo si
      // sigue en waiting.
      //
      // ⚠️ Si el settle falla porque el estado volvió a 'generating' (el DOM
      // oscila waiting↔generating a mitad de turno), NO se baja sawStream
      // aquí: hacerlo dejaba el turno sin completar para siempre cuando el
      // segundo paso a waiting ya no veía stream.
      if (!settleTimer) {
        settleTimer = window.setTimeout(() => {
          settleTimer = 0;
          if (injectionEnabled === 'disabled' || !captureArmed || pageFrozen) return;
          if (completedEmitted) return;
          if (host.detectStatus() !== 'waiting') return; // volvió a generar
          const settledKey = currentAnswerKey();
          if (!sawStream && armedAnswerKey && settledKey === armedAnswerKey) return;
          const finalText = host.readAnswer() || lastAnswer;
          if (!finalText) return;
          if (finalText !== lastAnswer) sequenceNumber += 1;
          lastAnswer = finalText;
          completedEmitted = true;
          sawStream = false;
          lastProgressAt = 0;
          emit(deltaEvent(finalText, true));
          captureArmed = false;
          turnId = null;
          resetCaptureIdentity();
          // El completion cambia el estado público efectivo a waiting aunque
          // el HostAdapter oscile durante un render posterior.
          publishStatus('waiting', true);
          console.debug(`[debatidor] turno completo emitido (${finalText.length} chars)`);
        }, 450);
      }
    }
    if (captureArmed && hostStatus === 'generating') {
      const current = host.readAnswer();
      if (current && current !== lastAnswer) {
        // Snapshot completo, SIEMPRE (isComplete=false solo indica que sigue
        // vivo). Concatenar sufijos con snapshots de ChatGPT producía basura
        // tipo "PensandoEntendido…Entendido…" en la consola y en la arena:
        // el DOM reordena/re-renderiza y el "sufijo" repetía todo.
        lastAnswer = current;
        lastProgressAt = Date.now();
        sequenceNumber += 1;
        emit(deltaEvent(current, false));
      }
    }

    // Última red de seguridad. Algunos hosts dejan pegada una señal de
    // `generating` aunque la respuesta visible ya quedó inmóvil. Si hubo
    // progreso textual y lleva 45s congelado, tratamos el snapshot actual
    // como final autoritativo para no dejar el CLI esperando eternamente.
    if (
      captureArmed &&
      sawStream &&
      !completedEmitted &&
      lastProgressAt &&
      Date.now() - lastProgressAt > 45_000
    ) {
      const finalText = host.readAnswer() || lastAnswer;
      if (finalText) {
        if (finalText !== lastAnswer) sequenceNumber += 1;
        lastAnswer = finalText;
        completedEmitted = true;
        sawStream = false;
        lastProgressAt = 0;
        emit(deltaEvent(finalText, true));
        captureArmed = false;
        turnId = null;
        resetCaptureIdentity();
        publishStatus('waiting', true);
        console.warn('[debatidor] ⚠️ completion FORZADO por watchdog (texto congelado 45s)');
      }
    }
  }

  // -------------------------------------------------------------- output

  function emit(payload) {
    if (!ALLOWED.has(payload.event)) return false;
    return send({ type: 'wire', payload });
  }

  /**
   * Envía por el puerto; si está muerto lo reconecta y reintenta una vez.
   * @returns {boolean} true si el mensaje salió.
   */
  function send(msg, { quiet = false } = {}) {
    if (pageFrozen) return false;
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
        injectionEnabled: injectionEnabled === 'enabled',
        hostBusy: ['thinking', 'generating'].includes(host.detectStatus()),
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
