/**
 * ChatGPT generated-asset adapter (ADR-0013).
 *
 * Image generation renders the original as an <img src="/backend-api/estuary/content?...">
 * and often has no <a download>. Surface those same-origin URLs as typed
 * candidates and annotate their relation to the latest user turn. Source
 * selection can then be semantic (previous turn vs current response) instead
 * of abusing the destination filename as a DOM identity.
 */
(function attachChatGPTGeneratedAssets(global) {
  const host = global.__debatidorHost;
  if (!host || host.hostId !== 'chatgpt') return;

  const previousListDownloads =
    typeof host.listDownloads === 'function' ? host.listDownloads.bind(host) : () => [];
  const ASSISTANT_MESSAGE = '[data-message-author-role="assistant"]';
  const TURN = 'section[data-turn]';
  const RECENT_TURNS = 6;

  function isGeneratedMediaUrl(value) {
    const href = String(value ?? '').trim();
    return (
      href.startsWith('blob:') ||
      href.includes('/backend-api/estuary/content') ||
      href.includes('/backend-api/files/')
    );
  }

  function turnRole(node) {
    return String(node?.getAttribute?.('data-turn') ?? node?.dataset?.turn ?? '').trim();
  }

  function assistantTurns() {
    const turns = Array.from(document.querySelectorAll(TURN));
    if (turns.length) {
      let latestUserIndex = -1;
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        if (turnRole(turns[i]) === 'user') {
          latestUserIndex = i;
          break;
        }
      }
      let previousAssistantIndex = -1;
      if (latestUserIndex >= 0) {
        for (let i = latestUserIndex - 1; i >= 0; i -= 1) {
          if (turnRole(turns[i]) === 'assistant') {
            previousAssistantIndex = i;
            break;
          }
        }
      }
      return turns
        .map((shell, index) => {
          if (turnRole(shell) !== 'assistant') return null;
          const relation =
            latestUserIndex >= 0 && index > latestUserIndex
              ? 'after-latest-user'
              : index === previousAssistantIndex
                ? 'previous-turn'
                : 'older';
          return { shell, relation, turnIndex: index };
        })
        .filter(Boolean)
        .slice(-RECENT_TURNS)
        .reverse();
    }

    // Compatibility fallback for old ChatGPT DOMs where only message nodes
    // expose a stable role marker. Relation is unknown, so strategy selectors
    // intentionally will not guess.
    return Array.from(document.querySelectorAll(ASSISTANT_MESSAGE))
      .slice(-RECENT_TURNS)
      .reverse()
      .map((answer) => ({
        shell:
          answer.closest?.('section[data-turn="assistant"], [data-testid^="conversation-turn"]') ??
          answer,
        relation: undefined,
        turnIndex: undefined,
      }));
  }

  function generatedMediaCandidatesInTurn(shell, relation, turnIndex) {
    if (!shell) return [];
    const out = [];
    const seen = new Set();
    for (const image of shell.querySelectorAll?.('img[src]') ?? []) {
      const href = String(image.currentSrc || image.src || image.getAttribute?.('src') || '').trim();
      if (!href || !isGeneratedMediaUrl(href) || seen.has(href)) continue;
      const generated = Boolean(
        image.closest?.('[id^="image-"], [data-testid="image-gen-overlay-actions"], .group\/imagegen-image') ||
          shell.querySelector?.('[id^="image-"], [data-testid="image-gen-overlay-actions"], .group\/imagegen-image'),
      );
      seen.add(href);
      out.push({
        href,
        kind: generated ? 'generated-image' : 'chatgpt-media',
        relation,
        turnIndex,
        names: [
          image.getAttribute?.('alt'),
          image.getAttribute?.('aria-label'),
          image.getAttribute?.('data-file-name'),
        ].filter(Boolean),
        width: Number(image.naturalWidth || image.width || 0) || undefined,
        height: Number(image.naturalHeight || image.height || 0) || undefined,
      });
    }
    return out;
  }

  function generatedMediaCandidates() {
    const out = [];
    const seen = new Set();
    for (const { shell, relation, turnIndex } of assistantTurns()) {
      for (const candidate of generatedMediaCandidatesInTurn(shell, relation, turnIndex)) {
        if (seen.has(candidate.href)) continue;
        seen.add(candidate.href);
        out.push(candidate);
      }
    }
    return out;
  }

  function generatedOnly(candidates) {
    return (candidates ?? []).filter((candidate) => candidate?.kind === 'generated-image');
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

  host.listGeneratedAssets = () => generatedOnly(generatedMediaCandidates());
  host.listPreviousTurnGeneratedAssets = () =>
    generatedOnly(generatedMediaCandidates()).filter((candidate) => candidate.relation === 'previous-turn');
  host.listGeneratedAssetsAfterLatestUser = () =>
    generatedOnly(generatedMediaCandidates()).filter(
      (candidate) => candidate.relation === 'after-latest-user',
    );
})(globalThis);
