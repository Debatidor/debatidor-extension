/**
 * Completion guard — ChatGPT.
 *
 * El adapter base ya espera footer/stop/stream, pero existe una carrera entre
 * `detectStatus()` y `readAnswer()`: CodeMirror puede seguir montando spans en
 * esos pocos milisegundos. En producción eso convirtió
 *   JSON{"tool":"fs.list","path":""}
 * en
 *   JSON{"tool":"fs.list","path":""
 * justo antes de emitir isComplete=true.
 *
 * Este guard añade dos propiedades:
 * 1) el snapshot final debe permanecer idéntico durante un settle adicional;
 * 2) si parece un tool-call, el objeto JSON debe estar balanceado y parsear.
 *
 * Además, cuando `detectStatus()` devuelve waiting, `readAnswer()` devuelve
 * EXACTAMENTE el snapshot que fue validado por esa decisión. Así el check y
 * la lectura son atómicos desde el punto de vista de content.js.
 */
(function attachChatGPTCompletionGuard(global) {
  const host = global.__debatidorHost;
  if (!host || host.hostId !== 'chatgpt') return;

  const GUARD_VERSION = 'completion-stability-1';
  const EXTRA_SETTLE_MS = 800;
  const baseDetectStatus = host.detectStatus.bind(host);
  const baseReadAnswer = host.readAnswer.bind(host);

  let candidateKey = '';
  let candidateText = '';
  let candidateChangedAt = 0;
  let validatedKey = '';
  let validatedText = '';

  function answerKey() {
    const nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
    const node = nodes.length ? nodes[nodes.length - 1] : null;
    return node?.getAttribute('data-message-id') ?? '';
  }

  function observeCandidate(key, text) {
    if (key !== candidateKey) {
      candidateKey = key;
      candidateText = '';
      candidateChangedAt = Date.now();
      validatedKey = '';
      validatedText = '';
    }
    if (text !== candidateText) {
      candidateText = text;
      candidateChangedAt = Date.now();
      validatedKey = '';
      validatedText = '';
    }
  }

  function toolObjectStart(text) {
    const match = /\{\s*"tool"\s*:/m.exec(text);
    return match?.index ?? -1;
  }

  /**
   * Encuentra el primer objeto JSON de tool y comprueba cierre real.
   * Es consciente de strings y escapes: llaves dentro de un command de
   * PowerShell (`Where-Object { ... }`) NO alteran la profundidad JSON.
   */
  function hasCompleteToolObject(text) {
    const start = toolObjectStart(text);
    if (start < 0) return false;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') depth += 1;
      if (ch !== '}') continue;

      depth -= 1;
      if (depth < 0) return false;
      if (depth !== 0) continue;

      const raw = text.slice(start, i + 1);
      try {
        const parsed = JSON.parse(raw);
        return Boolean(parsed && typeof parsed.tool === 'string');
      } catch {
        return false;
      }
    }

    return false;
  }

  function looksLikeToolAnswer(text) {
    return toolObjectStart(text) >= 0 || /(?:^|\n)\s*JSON\s*\{\s*"tool"/m.test(text);
  }

  host.getAnswerKey = answerKey;
  host.completionGuardVersion = GUARD_VERSION;
  host.selectorVersion = `${host.selectorVersion}+${GUARD_VERSION}`;

  host.detectStatus = function guardedDetectStatus() {
    const status = baseDetectStatus();
    const key = answerKey();
    const text = baseReadAnswer();
    observeCandidate(key, text);

    if (status !== 'waiting') return status;
    if (!text) return status;

    // Un footer estable no basta: el contenido leído debe ser estable también.
    if (Date.now() - candidateChangedAt < EXTRA_SETTLE_MS) return 'generating';

    // Nunca declarar final un tool que visualmente todavía perdió `}`/quotes.
    if (looksLikeToolAnswer(text) && !hasCompleteToolObject(text)) {
      return 'generating';
    }

    validatedKey = key;
    validatedText = text;
    return 'waiting';
  };

  host.readAnswer = function guardedReadAnswer() {
    const key = answerKey();
    if (validatedText && validatedKey === key) return validatedText;
    return baseReadAnswer();
  };
})(globalThis);
