// Debatidor — creación de tickets iniciada por la propia extensión.
//
// El modelo no participa en esta llamada. Un content script con consentimiento
// explícito resuelve la fuente real en el DOM, prepara el blob y pide aquí un
// ticket autenticado. sourceStrategy describe la fuente; destinationPath solo
// describe dónde terminarán los bytes dentro del agente.
(function attachExtensionAssetSaveBackground(global) {
  const SHA_RE = /^[a-f0-9]{64}$/;
  const MIME_RE = /^[a-z0-9!#$&^_.+\-]+\/(?:[a-z0-9!#$&^_.+\-]+|\*)$/;
  const MAX_BYTES = 512 * 1024 * 1024;
  const SOURCE_STRATEGIES = new Set(['previous-turn-image', 'wait-for-new-image']);

  function safePath(value) {
    const path = String(value ?? '').trim().replace(/\\/g, '/');
    if (!path || path.length > 1000 || path.includes('\0')) return '';
    if (path.startsWith('/') || /^[A-Za-z]:\//.test(path)) return '';
    if (path.split('/').some((part) => part === '..')) return '';
    return path;
  }

  function optionalId(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const id = String(value).trim();
    if (!id || id.length > 200 || /[\s"'<>]/.test(id)) return undefined;
    return id;
  }

  function normalizeMime(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const mime = String(value).split(';', 1)[0].trim().toLowerCase();
    return mime && mime.length <= 200 && MIME_RE.test(mime) ? mime : undefined;
  }

  function validateRequest(data) {
    const destinationPath = safePath(data?.destinationPath ?? data?.path);
    if (!destinationPath) throw new Error('asset_save_destination_path_invalid');
    if (data?.path && data?.destinationPath) {
      const legacyPath = safePath(data.path);
      if (!legacyPath || legacyPath !== destinationPath) throw new Error('asset_save_destination_path_conflict');
    }
    const sourceStrategy = String(data?.sourceStrategy ?? '').trim();
    if (!SOURCE_STRATEGIES.has(sourceStrategy)) throw new Error('asset_save_source_strategy_invalid');
    const expectedBytes = Number(data?.expectedBytes);
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > MAX_BYTES) {
      throw new Error('asset_save_bytes_invalid');
    }
    const expectedSha256 = String(data?.expectedSha256 ?? '').trim().toLowerCase();
    if (!SHA_RE.test(expectedSha256)) throw new Error('asset_save_sha256_invalid');
    const mimeType = normalizeMime(data?.mimeType);
    if (data?.mimeType && !mimeType) throw new Error('asset_save_mime_invalid');
    const agentId = optionalId(data?.agentId);
    if (data?.agentId && !agentId) throw new Error('asset_save_agent_invalid');
    const connectionId = optionalId(data?.connectionId);
    if (data?.connectionId && !connectionId) throw new Error('asset_save_connection_invalid');
    return {
      destinationPath,
      sourceStrategy,
      expectedBytes,
      expectedSha256,
      mimeType,
      agentId,
      connectionId,
    };
  }

  function ticketsEndpoint(backendUrl) {
    const url = new URL(String(backendUrl ?? ''));
    if (url.protocol === 'wss:') url.protocol = 'https:';
    else if (url.protocol === 'ws:') url.protocol = 'http:';
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('asset_save_backend_invalid');
    }
    url.pathname = '/asset-relay/tickets';
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  function sanitizeTicket(body, input) {
    const ticketId = String(body?.ticketId ?? '').trim();
    const uploadUrl = String(body?.uploadUrl ?? '').trim();
    if (!/^tkt_[a-f0-9]{24}$/.test(ticketId)) throw new Error('asset_save_ticket_invalid');
    let url;
    try {
      url = new URL(uploadUrl);
    } catch {
      throw new Error('asset_save_upload_url_invalid');
    }
    const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost)) {
      throw new Error('asset_save_upload_url_invalid');
    }
    return {
      ticketId,
      uploadUrl: url.toString(),
      path: String(body?.path ?? input.destinationPath),
      destinationPath: String(body?.destinationPath ?? input.destinationPath),
      sourceStrategy: String(body?.sourceStrategy ?? input.sourceStrategy),
      expectedBytes: Number.isSafeInteger(body?.expectedBytes) ? body.expectedBytes : undefined,
      expectedSha256:
        typeof body?.expectedSha256 === 'string' ? body.expectedSha256 : undefined,
      mimeType: typeof body?.mimeType === 'string' ? body.mimeType : undefined,
      maxBytes: Number.isSafeInteger(body?.maxBytes) ? body.maxBytes : undefined,
      expiresAt: typeof body?.expiresAt === 'string' ? body.expiresAt : undefined,
    };
  }

  async function createTicket(message, sender) {
    const tabId = sender?.tab?.id;
    if (!Number.isInteger(tabId)) return { ok: false, reason: 'asset_save_sender_tab_missing' };

    const enabledKey = `injection:${tabId}`;
    const consent = await chrome.storage.session.get(enabledKey);
    if (!consent[enabledKey]) return { ok: false, reason: 'asset_save_consent_required' };

    let input;
    try {
      input = validateRequest(message?.data ?? {});
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) };
    }
    const config = await chrome.storage.local.get({
      apiKey: '',
      backendUrl: 'wss://api.debatidor.com/extension',
    });
    const apiKey = String(config.apiKey ?? '').trim();
    if (!apiKey) return { ok: false, reason: 'asset_save_api_key_missing' };

    const endpoint = ticketsEndpoint(config.backendUrl);
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
        },
        credentials: 'omit',
        cache: 'no-store',
        body: JSON.stringify({
          direction: 'upload',
          uploader: 'any',
          // path remains a rollout alias understood by older backends.
          path: input.destinationPath,
          destinationPath: input.destinationPath,
          sourceStrategy: input.sourceStrategy,
          agentId: input.agentId,
          expectedBytes: input.expectedBytes,
          expectedSha256: input.expectedSha256,
          mimeType: input.mimeType,
          connectionId: input.connectionId,
          ttlSeconds: 300,
        }),
      });
    } catch (error) {
      return {
        ok: false,
        reason: `asset_save_ticket_unreachable:${String(error?.message ?? error).slice(0, 120)}`,
      };
    }

    let body = {};
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    if (!response.ok) {
      const code = body?.message ?? body?.error ?? `http_${response.status}`;
      return { ok: false, reason: `asset_save_ticket_http_${response.status}:${String(code).slice(0, 120)}` };
    }

    try {
      return { ok: true, ticket: sanitizeTicket(body, input) };
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) };
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'asset-save-create-ticket') return false;
    void createTicket(message, sender)
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          reason: `asset_save_internal:${String(error?.message ?? error).slice(0, 120)}`,
        }),
      );
    return true;
  });

  global.__debatidorCreateAssetSaveTicket = createTicket;
})(globalThis);
