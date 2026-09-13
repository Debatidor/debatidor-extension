/**
 * ChatGPT generated-asset adapter (ADR-0013).
 *
 * The normal ChatGPT adapter enumerates download anchors. Image generation is
 * different: the original is rendered as an <img src="/backend-api/estuary/content?...">
 * and often has no <a download> at all. Surface those same-origin URLs as
 * candidates so the Media Rail can verify them by expected bytes/SHA before
 * spending a relay token.
 */
(function attachChatGPTGeneratedAssets(global) {
  const host = global.__debatidorHost;
  if (!host || host.hostId !== 'chatgpt') return;

  const previousListDownloads =
    typeof host.listDownloads === 'function' ? host.listDownloads.bind(host) : () => [];
  const ASSISTANT = '[data-message-author-role="assistant"]';
  const RECENT_TURNS = 4;

  function isGeneratedMediaUrl(value) {
    const href = String(value ?? '').trim();
    return (
      href.startsWith('blob:') ||
      href.includes('/backend-api/estuary/content') ||
      href.includes('/backend-api/files/')
    );
  }

  function generatedMediaCandidates() {
    const answers = Array.from(document.querySelectorAll(ASSISTANT));
    const recent = answers.slice(-RECENT_TURNS).reverse();
    const out = [];
    const seen = new Set();

    for (const answer of recent) {
      const shell =
        answer.closest?.('section[data-turn="assistant"], [data-testid^="conversation-turn"]') ??
        answer;
      for (const image of shell.querySelectorAll?.('img[src]') ?? []) {
        const href = String(image.currentSrc || image.src || image.getAttribute?.('src') || '').trim();
        if (!href || !isGeneratedMediaUrl(href) || seen.has(href)) continue;
        // Prefer actual image-generation cards. Estuary is also used for some
        // file previews, so keep the candidate typed and let integrity matching
        // decide; never upload a random candidate merely because it exists.
        const generated = Boolean(
          image.closest?.('[id^="image-"], [data-testid="image-gen-overlay-actions"], .group\/imagegen-image'),
        );
        seen.add(href);
        out.push({
          href,
          kind: generated ? 'generated-image' : 'chatgpt-media',
          names: [
            image.getAttribute?.('alt'),
            image.getAttribute?.('aria-label'),
            image.getAttribute?.('data-file-name'),
          ].filter(Boolean),
          width: Number(image.naturalWidth || image.width || 0) || undefined,
          height: Number(image.naturalHeight || image.height || 0) || undefined,
        });
      }
    }
    return out;
  }

  host.listDownloads = function listDownloadsWithGeneratedMedia() {
    const existing = previousListDownloads() ?? [];
    const generated = generatedMediaCandidates();
    const out = [];
    const seen = new Set();
    for (const candidate of [...existing, ...generated]) {
      const href = String(candidate?.href ?? '').trim();
      if (!href || seen.has(href)) continue;
      seen.add(href);
      out.push(candidate);
    }
    return out;
  };

  host.listGeneratedAssets = generatedMediaCandidates;
})(globalThis);
