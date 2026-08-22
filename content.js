(() => {
  const host = globalThis.__debatidorHost;
  if (!host) {
    return;
  }

  const port = chrome.runtime.connect({ name: 'debatidor-tab' });
  let lastStatus = null;
  let lastAnswer = '';
  let sequenceNumber = 0;
  let sawStream = false;
  let turnId = null;
  let connectionId = 'conn_dom_default';
  let debateId = null;

  port.onMessage.addListener((msg) => {
    if (msg?.type === 'config') {
      connectionId = msg.connectionId ?? connectionId;
      debateId = msg.debateId ?? debateId;
      return;
    }
    if (msg?.type === 'dom_prompt') {
      const status = host.detectStatus();
      if (status === 'thinking' || status === 'generating') {
        port.postMessage({
          type: 'wire',
          payload: statusEvent('error'),
        });
        return;
      }
      turnId = msg.turnId ?? turnId;
      lastAnswer = '';
      sequenceNumber = 0;
      sawStream = false;
      const preamble = msg.systemPreamble ? `${msg.systemPreamble}\n\n` : '';
      const result = host.injectPrompt(`${preamble}${msg.promptText ?? ''}`);
      if (!result.ok) {
        port.postMessage({
          type: 'wire',
          payload: statusEvent('error'),
        });
      }
    }
  });

  const observer = new MutationObserver(() => tick());
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  setInterval(tick, 400);
  tick();

  function tick() {
    const status = host.detectStatus();
    if (status === 'thinking' || status === 'generating') {
      sawStream = true;
    }
    if (status !== lastStatus) {
      lastStatus = status;
      port.postMessage({ type: 'wire', payload: statusEvent(status) });
      if (status === 'waiting' && sawStream && lastAnswer) {
        sequenceNumber += 1;
        port.postMessage({
          type: 'wire',
          payload: deltaEvent(lastAnswer, true),
        });
        sawStream = false;
      }
    }
    if (status === 'generating') {
      const current = host.readAnswer();
      if (current && current !== lastAnswer) {
        const suffix =
          current.startsWith(lastAnswer) ? current.slice(lastAnswer.length) : current;
        lastAnswer = current;
        sequenceNumber += 1;
        port.postMessage({
          type: 'wire',
          payload: deltaEvent(suffix, false),
        });
      }
    }
  }

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
