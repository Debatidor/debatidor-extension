/**
 * HostAdapter — Claude (claude.ai)
 * SELECTOR_VERSION: 2026-09-claude-dom-1
 *
 * Selectores derivados de snapshots reales del DOM de claude.ai (2026-09-02):
 * - composer: [data-testid="chat-input"] contenteditable / ProseMirror
 * - send: [data-testid="chat-input-send"]
 * - transcript: [data-testid="transcript-row"] con data-perf-row
 * - streaming: data-perf-row-streaming / data-is-streaming
 * - respuesta: [data-cds="Prose"] dentro de la última fila assistant
 * - completion: action-bar-retry + fila no-streaming; fallback de estabilidad
 *
 * No se usan ids `_r_*`, `base-ui-*` ni hashes/clases utilitarias del build.
 */
(function attachClaudeAdapter(global) {
  const SELECTOR_VERSION = '2026-09-claude-dom-1';
  const COMPOSER = [
    '[data-testid="chat-input"][contenteditable="true"]',
    '[data-cds="Editor"][role="textbox"][contenteditable="true"]',
  ];
  const SEND = [
    'button[data-testid="chat-input-send"]',
    'button[aria-label*="Enviar mensaje" i]',
    'button[aria-label*="Send message" i]',
  ];
  const ASSISTANT_ROW = '[data-testid="transcript-row"][data-perf-row="assistant"]';
  const HUMAN_ROW = '[data-testid="transcript-row"][data-perf-row="human"]';
  const PROSE = '[data-cds="Prose"]';
  const DONE_MARKS = [
    '[data-testid="action-bar-retry"]',
    '[data-testid="action-bar-copy"]',
  ];

  let composerSeenAt = 0;
  let answerKey = '';
  let answerSnapshot = '';
  let answerChangedAt = 0;
  const DONE_SETTLE_MS = 700;
  const FALLBACK_SETTLE_MS = 5000;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    return String(el?.innerText ?? el?.textContent ?? '').trim();
  }

  function rows(selector) {
    return Array.from(document.querySelectorAll(selector));
  }

  function assistantRow() {
    const nodes = rows(ASSISTANT_ROW);
    return nodes.length ? nodes[nodes.length - 1] : null;
  }

  function currentAnswerKey() {
    const nodes = rows(ASSISTANT_ROW);
    const row = nodes.length ? nodes[nodes.length - 1] : null;
    if (!row) return '';
    const index = row.getAttribute?.('data-index') ?? row.getAttribute?.('data-rs-index') ?? '';
    const article = row.querySelector?.('[role="article"]');
    const pos = article?.getAttribute?.('aria-posinset') ?? '';
    return `${nodes.length}:${index}:${pos}`;
  }

  function answerText(row) {
    if (!row) return '';
    const body = row.querySelector?.(PROSE) ?? row;
    const clone = body.cloneNode(true);
    for (const el of clone.querySelectorAll?.('button, [role="toolbar"], .sr-only, svg') ?? []) {
      el.remove();
    }
    return String(clone.innerText ?? clone.textContent ?? '')
      .replace(/[\u00a0\u2007\u202f]/g, ' ')
      .trim();
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

  function isStreaming(row) {
    if (!row) return false;
    return (
      row.getAttribute?.('data-perf-row-streaming') === 'true' ||
      Boolean(row.querySelector?.('[data-is-streaming="true"]'))
    );
  }

  function isDone(row) {
    if (!row || isStreaming(row)) return false;
    if (DONE_MARKS.some((selector) => row.querySelector?.(selector))) return true;
    return row.getAttribute?.('data-last-message') === 'true';
  }

  function insertText(el, text) {
    el.focus?.();
    const selection = window.getSelection?.();
    if (selection && document.createRange) {
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    let ok = false;
    try {
      ok = Boolean(document.execCommand?.('insertText', false, text));
    } catch {
      ok = false;
    }

    if (!ok || composerText(el) === '') {
      el.textContent = text;
      try {
        el.dispatchEvent(
          new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
        );
      } catch {
        el.dispatchEvent?.(new Event('input', { bubbles: true }));
      }
    }
    return composerText(el).length > 0;
  }

  function sendAck(beforeHumanCount, beforeAnswerKey) {
    if (rows(HUMAN_ROW).length > beforeHumanCount) return 'user_message';
    const nextKey = currentAnswerKey();
    if (nextKey && nextKey !== beforeAnswerKey) return 'assistant_turn';
    const live = composer();
    if (live && composerText(live) === '') return 'composer_empty';
    return '';
  }

  global.__debatidorHost = {
    hostId: 'claude',
    providerId: 'anthropic',
    connectionId: 'conn_dom_claude',
    selectorVersion: SELECTOR_VERSION,
    matches(url) {
      try {
        return new URL(url).hostname.toLowerCase() === 'claude.ai';
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

      const row = assistantRow();
      const text = answerText(row);
      trackAnswer(text);
      const stableFor = Date.now() - answerChangedAt;

      if (isStreaming(row)) return text ? 'generating' : 'thinking';
      if (text) {
        if (isDone(row) && stableFor >= DONE_SETTLE_MS) return 'waiting';
        if (stableFor >= FALLBACK_SETTLE_MS) return 'waiting';
        return 'generating';
      }
      return 'waiting';
    },
    readAnswer() {
      return answerText(assistantRow());
    },
    isFreshConversation() {
      return rows(ASSISTANT_ROW).length === 0;
    },
    async injectPrompt(text) {
      const box = composer();
      if (!box) return { ok: false, reason: 'composer_missing' };

      const beforeHumanCount = rows(HUMAN_ROW).length;
      const beforeAnswerKey = currentAnswerKey();
      if (!insertText(box, text)) return { ok: false, reason: 'insert_failed' };

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

      if (send) send.click();

      let ack = '';
      for (let attempt = 0; attempt < 12 && !ack; attempt += 1) {
        await sleep(100);
        ack = sendAck(beforeHumanCount, beforeAnswerKey);
      }

      if (!ack) {
        const live = composer();
        if (live) {
          live.focus?.();
          const key = {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
          };
          live.dispatchEvent(new KeyboardEvent('keydown', key));
          live.dispatchEvent(new KeyboardEvent('keypress', key));
          live.dispatchEvent(new KeyboardEvent('keyup', key));
        }
        for (let attempt = 0; attempt < 5 && !ack; attempt += 1) {
          await sleep(120);
          ack = sendAck(beforeHumanCount, beforeAnswerKey);
        }
      }

      if (!ack) return { ok: false, reason: 'send_unverified' };
      return { ok: true, via: send ? 'button' : 'enter', ack };
    },
  };
})(globalThis);
