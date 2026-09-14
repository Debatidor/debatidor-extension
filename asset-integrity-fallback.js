/**
 * Integrity fallback for browser-generated media (ADR-0013).
 *
 * Legacy tickets without sourceStrategy may still identify a generated asset by
 * expected bytes/SHA when the DOM filename differs from the destination. New
 * strategy tickets deliberately bypass this fallback: their source identity is
 * the DOM relation (previous turn vs next generated image), never destination.
 */
(function attachAssetIntegrityFallback(global) {
  const transport = global.__debatidorAssetTransport;
  if (!transport || typeof transport.run !== 'function') return;

  const baseRun = transport.run.bind(transport);
  const MAX_ERROR_CHARS = 160;

  function errorText(error) {
    const message = error instanceof Error ? error.message : String(error ?? 'unknown');
    return message.slice(0, MAX_ERROR_CHARS);
  }

  function normalizeSha(value) {
    const sha = String(value ?? '').trim().toLowerCase();
    return /^[a-f0-9]{64}$/.test(sha) ? sha : '';
  }

  function isGeneratedCandidate(candidate) {
    return candidate?.kind === 'generated-image' || candidate?.kind === 'generated-media';
  }

  async function sha256Blob(blob) {
    if (!global.crypto?.subtle || typeof blob?.arrayBuffer !== 'function') return '';
    const digest = await global.crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function readCandidate(candidate, fetchImpl) {
    let response;
    try {
      response = await fetchImpl(candidate.href, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch (error) {
      return { ok: false, error: `download_blocked:${errorText(error)}` };
    }
    if (!response?.ok) return { ok: false, error: `download_http_${response?.status ?? 0}` };
    try {
      return { ok: true, blob: await response.blob() };
    } catch (error) {
      return { ok: false, error: `download_read_failed:${errorText(error)}` };
    }
  }

  async function findIntegrityMatch(ticket, candidates, fetchImpl) {
    const expectedSha = normalizeSha(ticket?.expectedSha256);
    const expectedBytes = Number.isSafeInteger(ticket?.expectedBytes) && ticket.expectedBytes > 0
      ? ticket.expectedBytes
      : null;
    const generated = (candidates ?? []).filter(isGeneratedCandidate);
    if (!generated.length) return null;

    // Without integrity metadata, only a single generated candidate is safe to
    // choose automatically. Multiple candidates require bytes/hash so one image
    // can never be silently substituted for another.
    if (!expectedSha && expectedBytes === null && generated.length !== 1) return null;

    for (const candidate of generated) {
      const read = await readCandidate(candidate, fetchImpl);
      if (!read.ok || !read.blob?.size) continue;
      const blob = read.blob;
      if (expectedBytes !== null && blob.size !== expectedBytes) continue;
      if (ticket?.maxBytes && blob.size > ticket.maxBytes) continue;
      let digest = '';
      if (expectedSha) {
        try {
          digest = await sha256Blob(blob);
        } catch {
          digest = '';
        }
        if (!digest || digest !== expectedSha) continue;
      }
      return { candidate, blob, sha256: digest || undefined };
    }
    return null;
  }

  transport.run = async function runWithIntegrityFallback(ticket, options = {}) {
    // Strategy tickets already carry an unambiguous source selector. Trying a
    // SHA/single-candidate fallback first could silently pick an older image and
    // defeat previous-turn-image / wait-for-new-image semantics.
    if (ticket?.sourceStrategy) return baseRun(ticket, options);

    const fetchImpl =
      options.fetchImpl ??
      (typeof global.fetch === 'function' ? global.fetch.bind(global) : null);
    const listDownloads = options.listDownloads;
    if (fetchImpl && typeof listDownloads === 'function') {
      let candidates = [];
      try {
        candidates = listDownloads() ?? [];
      } catch {
        candidates = [];
      }
      const match = await findIntegrityMatch(ticket, candidates, fetchImpl);
      if (match) {
        const started = (options.now ?? Date.now)();
        try {
          const result = await transport.putToRelay(ticket, match.blob, { fetchImpl });
          return {
            ok: true,
            ...result,
            href: match.candidate.href,
            matchedBy: match.sha256 ? 'sha256' : ticket?.expectedBytes ? 'bytes' : 'single-generated-asset',
            ms: Math.max(0, (options.now ?? Date.now)() - started),
          };
        } catch (error) {
          return {
            ok: false,
            error: errorText(error),
            href: match.candidate.href,
            ms: Math.max(0, (options.now ?? Date.now)() - started),
          };
        }
      }
    }
    return baseRun(ticket, options);
  };

  transport.sha256Blob = transport.sha256Blob || sha256Blob;
  transport.findIntegrityMatch = findIntegrityMatch;
})(globalThis);
