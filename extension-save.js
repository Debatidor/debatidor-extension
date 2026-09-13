// Debatidor — guardado de imágenes generado por intención del usuario.
//
// Flujo:
//   último prompt manual -> intención explícita -> imagen nueva de ChatGPT
//   -> fetch same-origin + SHA local -> service worker crea ticket autenticado
//   -> PUT binario al Media Rail -> agente.
//
// Ningún paso requiere una tool MCP ni expone la URL del relay al modelo.
(function attachExtensionOriginatedAssetSave(global) {
  const host = global.__debatidorHost;
  const transport = global.__debatidorAssetTransport;
  const intentTools = global.__debatidorAssetSaveIntent;
  if (
    !host ||
    host.hostId !== 'chatgpt' ||
    !transport ||
    !intentTools ||
    typeof host.listGeneratedAssets !== 'function'
  ) {
    return;
  }

  const USER = '[data-message-author-role="user"]';
  const SCAN_MS = 700;
  const RETRY_MS = 3500;
  const MAX_ATTEMPTS = 3;
  const MAX_STAGE_BYTES = 256 * 1024 * 1024;

  let activeTurnKey = '';
  let activeIntent = null;
  let baseline = new Set();
  let ordered = new Map();
  let nextIndex = 0;
  let scanBusy = false;
  const completed = new Set();
  const attempts = new Map();
  const retryAt = new Map();

  function textOf(node) {
    if (!node) return '';
    const clone = node.cloneNode(true);
    for (const el of clone.querySelectorAll?.('button, .sr-only') ?? []) el.remove();
    return String(clone.innerText ?? clone.textContent ?? '').trim();
  }

  function latestUserTurn() {
    const nodes = Array.from(document.querySelectorAll(USER));
    const node = nodes[nodes.length - 1];
    if (!node) return null;
    const shell =
      node.closest?.('[data-message-id], section[data-turn="user"], [data-testid^="conversation-turn"]') ??
      node;
    const text = textOf(node);
    const key =
      node.getAttribute?.('data-message-id') ||
      shell.getAttribute?.('data-message-id') ||
      shell.getAttribute?.('data-turn-id') ||
      `user_${simpleHash(text)}`;
    return text ? { key, text } : null;
  }

  function simpleHash(value) {
    let hash = 0x811c9dc5;
    const text = String(value ?? '');
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  function generatedAssets() {
    try {
      return (host.listGeneratedAssets() ?? []).filter(
        (candidate) => candidate?.href && candidate.kind === 'generated-image',
      );
    } catch {
      return [];
    }
  }

  function assignIndex(href) {
    if (!ordered.has(href)) ordered.set(href, nextIndex++);
    return ordered.get(href);
  }

  async function sha256Blob(blob) {
    if (typeof transport.sha256Blob === 'function') return transport.sha256Blob(blob);
    if (!global.crypto?.subtle) return '';
    const digest = await global.crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            resolve({ ok: false, reason: `asset_save_extension:${runtimeError.message}` });
            return;
          }
          resolve(response ?? { ok: false, reason: 'asset_save_no_response' });
        });
      } catch (error) {
        resolve({ ok: false, reason: `asset_save_extension:${String(error?.message ?? error)}` });
      }
    });
  }

  async function loadBlob(candidate) {
    let response;
    try {
      response = await fetch(candidate.href, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch (error) {
      throw new Error(`source_unreachable:${String(error?.message ?? error).slice(0, 100)}`);
    }
    if (!response.ok) throw new Error(`source_http_${response.status}`);
    const blob = await response.blob();
    if (!blob?.size) throw new Error('source_empty');
    if (blob.size > MAX_STAGE_BYTES) throw new Error('source_too_large');
    const mimeType = String(blob.type || response.headers?.get?.('content-type') || 'image/png')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    if (!mimeType.startsWith('image/')) throw new Error('source_not_image');
    return { blob, mimeType };
  }

  async function saveCandidate(candidate, index, turnKey, intent) {
    const href = String(candidate.href);
    const provisionalPath = intentTools.destinationFor(intent, index, 'image/png');
    const initialRequestId = intentTools.requestId(turnKey, href, provisionalPath);
    if (completed.has(initialRequestId)) return;

    const tries = attempts.get(initialRequestId) ?? 0;
    if (tries >= MAX_ATTEMPTS || Date.now() < (retryAt.get(initialRequestId) ?? 0)) return;
    attempts.set(initialRequestId, tries + 1);

    try {
      const { blob, mimeType } = await loadBlob(candidate);
      const path = intentTools.destinationFor(intent, index, mimeType);
      const requestId = intentTools.requestId(turnKey, href, path);
      if (completed.has(requestId)) return;
      const expectedSha256 = await sha256Blob(blob);
      if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('sha256_unavailable');

      const created = await sendMessage({
        type: 'asset-save-create-ticket',
        data: {
          clientRequestId: requestId,
          path,
          agentId: intent.agentId,
          connectionId: host.connectionId || 'conn_dom_openai',
          expectedBytes: blob.size,
          expectedSha256,
          mimeType,
        },
      });
      if (!created?.ok || !created.ticket) {
        throw new Error(String(created?.reason ?? 'ticket_create_failed'));
      }

      const result = await transport.putToRelay(
        {
          ...created.ticket,
          fileName: path.split('/').pop() || path,
          expectedBytes: blob.size,
          expectedSha256,
          mimeType,
        },
        blob,
        { fetchImpl: global.fetch.bind(global) },
      );
      completed.add(requestId);
      completed.add(initialRequestId);
      attempts.delete(initialRequestId);
      retryAt.delete(initialRequestId);
      console.info(
        `[debatidor] imagen guardada fuera de MCP: ${path} (${result.bytes ?? blob.size} bytes)`,
      );
    } catch (error) {
      retryAt.set(initialRequestId, Date.now() + RETRY_MS);
      console.warn(
        `[debatidor] guardado automático falló (${tries + 1}/${MAX_ATTEMPTS}): ${String(error?.message ?? error)}`,
      );
    }
  }

  async function scan() {
    if (scanBusy || document.visibilityState === 'hidden') return;
    scanBusy = true;
    try {
      const turn = latestUserTurn();
      if (!turn) return;
      if (turn.key !== activeTurnKey) {
        activeTurnKey = turn.key;
        activeIntent = intentTools.parse(turn.text);
        baseline = new Set(generatedAssets().map((candidate) => String(candidate.href)));
        ordered = new Map();
        nextIndex = 0;
      }
      if (!activeIntent?.requested) return;

      const fresh = generatedAssets().filter(
        (candidate) => !baseline.has(String(candidate.href)),
      );
      for (const candidate of fresh) {
        const index = assignIndex(String(candidate.href));
        if (activeIntent.count && index >= activeIntent.count) continue;
        await saveCandidate(candidate, index, turn.key, activeIntent);
      }
    } finally {
      scanBusy = false;
    }
  }

  const timer = global.setInterval(() => void scan(), SCAN_MS);
  global.addEventListener?.('pagehide', () => global.clearInterval(timer), { once: true });
  void scan();
})(globalThis);
