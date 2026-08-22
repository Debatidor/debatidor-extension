/**
 * Hosts ChatGPT / Gemini / Claude: misma interfaz, adapters reales en el mismo sprint.
 * Hasta entonces: status error si no hay composer reconocible. Cero Enter a ciegas.
 */
(function attachPendingAdapter(global) {
  const hostId = (() => {
    const host = location.hostname;
    if (host.includes('chatgpt')) return 'chatgpt';
    if (host.includes('gemini')) return 'gemini';
    if (host.includes('claude')) return 'claude';
    return 'unknown';
  })();

  global.__debatidorHost = {
    hostId,
    selectorVersion: 'pending',
    matches() {
      return true;
    },
    detectStatus() {
      return 'error';
    },
    readAnswer() {
      return '';
    },
    injectPrompt() {
      return { ok: false, reason: 'host_adapter_pending' };
    },
  };
})(globalThis);
