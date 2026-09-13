// Debatidor — transporte out-of-band del Media Rail (ADR-0013).
//
// Módulo puro compartido por content.js (captura automática desde el DOM del
// chat) y popup.js (subida manual). No toca el DOM por sí mismo: recibe una
// función `listDownloads()` que devuelve candidatos `{ href, download, names }`
// y decide con matching EXACTO por nombre de archivo. Sin coincidencia no se
// sube nada: la extensión nunca actúa sobre "cualquier blob que vea".
//
// Los bytes viajan: fetch same-origin (o blob:) -> PUT al uploadUrl del relay.
// El SHA-256 lo calcula el backend; aquí solo se valida tamaño y expiración.

(function attachAssetTransport(global) {
  const POLL_MS = 300;
  const DEFAULT_WAIT_MS = 20_000;
  const MAX_ERROR_CHARS = 160;

  /** Normaliza un nombre para comparar: NFC, sin comillas, espacios colapsados, minúsculas. */
  function normalizeName(value) {
    return String(value ?? '')
      .normalize('NFC')
      .trim()
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  function contentDispositionName(value) {
    if (!value) return '';
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(String(value));
    if (!match) return '';
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  /** Nombres que una URL puede revelar: último segmento del path y parámetros habituales. */
  function namesFromHref(href, baseHref) {
    if (!href || /^blob:/i.test(href)) return [];
    let url;
    try {
      url = new URL(href, baseHref || global.location?.href || 'https://invalid.local/');
    } catch {
      return [];
    }
    let segment = url.pathname.split('/').filter(Boolean).pop() ?? '';
    try {
      segment = decodeURIComponent(segment);
    } catch {
      /* segmento no decodificable: se compara tal cual */
    }
    const query = url.searchParams;
    return [
      segment,
      query.get('filename'),
      query.get('file_name'),
      query.get('name'),
      query.get('download'),
      contentDispositionName(query.get('response-content-disposition')),
    ];
  }

  /** Todos los nombres normalizados que un candidato puede reclamar. */
  function candidateNames(candidate, baseHref) {
    if (!candidate) return [];
    return [candidate.download, ...(candidate.names ?? []), ...namesFromHref(candidate.href, baseHref)]
      .map(normalizeName)
      .filter(Boolean);
  }

  /**
   * Elige el candidato cuyo nombre coincide EXACTAMENTE con fileName.
   * Los candidatos llegan en orden de preferencia (último turno primero).
   */
  function pickDownload(candidates, fileName, baseHref) {
    const wanted = normalizeName(fileName);
    if (!wanted) return null;
    for (const candidate of candidates ?? []) {
      if (!candidate?.href) continue;
      if (candidateNames(candidate, baseHref).includes(wanted)) return candidate;
    }
    return null;
  }

  /** Convierte anclas DOM en candidatos serializables (los hosts lo usan en listDownloads). */
  function anchorsToCandidates(anchors) {
    const out = [];
    const seen = new Set();
    for (const anchor of anchors ?? []) {
      const href = String(anchor?.href ?? anchor?.getAttribute?.('href') ?? '').trim();
      if (!href || seen.has(href)) continue;
      seen.add(href);
      const download = anchor.getAttribute?.('download');
      out.push({
        href,
        download: typeof download === 'string' ? download : undefined,
        names: [
          anchor.getAttribute?.('aria-label'),
          anchor.getAttribute?.('title'),
          anchor.getAttribute?.('data-file-name'),
          String(anchor.textContent ?? '').trim(),
        ].filter(Boolean),
      });
    }
    return out;
  }

  function expiresAtMs(ticket) {
    const parsed = Date.parse(String(ticket?.expiresAt ?? ''));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function isExpired(ticket, now = Date.now()) {
    const at = expiresAtMs(ticket);
    return at !== null && at <= now;
  }

  function errorText(error) {
    const message = error instanceof Error ? error.message : String(error ?? 'unknown');
    return message.slice(0, MAX_ERROR_CHARS);
  }

  /** Espera a que aparezca el enlace (el file card puede montarse después del ticket). */
  async function waitForDownload(listDownloads, fileName, { waitMs, sleep, now, baseHref }) {
    const deadline = now() + Math.max(0, waitMs);
    for (;;) {
      let candidates = [];
      try {
        candidates = listDownloads() ?? [];
      } catch {
        candidates = [];
      }
      const found = pickDownload(candidates, fileName, baseHref);
      if (found) return found;
      if (now() >= deadline) return null;
      await sleep(POLL_MS);
    }
  }

  /** Valida el blob contra el manifiesto del ticket antes de gastar el token. */
  function assertBlobFits(ticket, blob) {
    if (!blob || !blob.size) throw new Error('download_empty');
    if (ticket.expectedBytes && blob.size !== ticket.expectedBytes) {
      throw new Error(`size_mismatch:${blob.size}:${ticket.expectedBytes}`);
    }
    if (ticket.maxBytes && blob.size > ticket.maxBytes) throw new Error('payload_too_large');
  }

  /** PUT crudo al relay. Devuelve el resultado del backend (bytes, sha256, status). */
  async function putToRelay(ticket, blob, { fetchImpl }) {
    if (!ticket?.uploadUrl) throw new Error('upload_url_missing');
    if (isExpired(ticket)) throw new Error('ticket_expired');
    assertBlobFits(ticket, blob);
    let response;
    try {
      response = await fetchImpl(ticket.uploadUrl, {
        method: 'PUT',
        body: blob,
        headers: { 'content-type': ticket.mimeType || blob.type || 'application/octet-stream' },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      });
    } catch (error) {
      throw new Error(`relay_unreachable:${errorText(error)}`);
    }
    let body = {};
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    if (!response.ok || body?.ok === false) {
      const code = body?.message ?? body?.error ?? '';
      throw new Error(`relay_http_${response.status}${code ? `:${String(code).slice(0, 80)}` : ''}`);
    }
    return {
      bytes: Number(body?.result?.bytes ?? blob.size),
      sha256: body?.result?.sha256 ?? undefined,
      status: body?.status ?? 'completed',
    };
  }

  /** Descarga el enlace del host con la sesión del usuario y lo sube al relay. */
  async function transfer(ticket, href, { fetchImpl }) {
    let source;
    try {
      source = await fetchImpl(href, { credentials: 'same-origin', cache: 'no-store' });
    } catch (error) {
      // TypeError de fetch = CORS/CSP del host bloqueó la lectura del body.
      throw new Error(`download_blocked:${errorText(error)}`);
    }
    if (!source.ok) throw new Error(`download_http_${source.status}`);
    const blob = await source.blob();
    return putToRelay(ticket, blob, { fetchImpl });
  }

  /**
   * Flujo completo para un ticket recibido por el content script.
   * Nunca lanza: devuelve { ok, bytes?, sha256?, error?, ms }.
   */
  async function run(ticket, options = {}) {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const fetchImpl = options.fetchImpl ?? (typeof global.fetch === 'function' ? global.fetch.bind(global) : null);
    const listDownloads = options.listDownloads;
    const started = now();
    const finish = (result) => ({ ...result, ms: Math.max(0, now() - started) });

    if (typeof listDownloads !== 'function') return finish({ ok: false, error: 'host_unsupported' });
    if (!fetchImpl) return finish({ ok: false, error: 'fetch_unavailable' });
    if (!ticket?.fileName) return finish({ ok: false, error: 'file_name_missing' });
    if (isExpired(ticket, started)) return finish({ ok: false, error: 'ticket_expired' });

    const expiry = expiresAtMs(ticket);
    const waitMs = Math.min(options.waitMs ?? DEFAULT_WAIT_MS, expiry === null ? Infinity : Math.max(0, expiry - started));
    const link = await waitForDownload(listDownloads, ticket.fileName, {
      waitMs,
      sleep,
      now,
      baseHref: options.baseHref,
    });
    if (!link) return finish({ ok: false, error: 'download_not_found' });

    try {
      const result = await transfer(ticket, link.href, { fetchImpl });
      return finish({ ok: true, ...result, href: link.href });
    } catch (error) {
      return finish({ ok: false, error: errorText(error), href: link.href });
    }
  }

  global.__debatidorAssetTransport = {
    normalizeName,
    candidateNames,
    pickDownload,
    anchorsToCandidates,
    isExpired,
    putToRelay,
    transfer,
    run,
  };
})(globalThis);
