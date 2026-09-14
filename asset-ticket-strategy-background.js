// Debatidor — compatibility layer for strategy-aware Media Rail tickets.
// Loaded after background.js in the same classic service-worker global scope.
// It extends the mature ticket sanitizer/message bridge without exposing the
// upload URL to popup/public status views.
(function attachAssetTicketStrategyBackground() {
  const SOURCE_STRATEGIES = new Set(['previous-turn-image', 'wait-for-new-image']);
  const baseSanitizeAssetTicket = sanitizeAssetTicket;
  const baseTicketMessage = ticketMessage;
  const basePublicAssetTicket = publicAssetTicket;

  sanitizeAssetTicket = function sanitizeStrategyAssetTicket(data) {
    const ticket = baseSanitizeAssetTicket(data);
    if (!ticket) return null;

    const rawStrategy = typeof data?.sourceStrategy === 'string' ? data.sourceStrategy.trim() : '';
    if (rawStrategy && !SOURCE_STRATEGIES.has(rawStrategy)) return null;
    const destinationPath = String(data?.destinationPath ?? data?.path ?? ticket.path ?? '').trim();
    if (!destinationPath) return null;

    if (rawStrategy) ticket.sourceStrategy = rawStrategy;
    ticket.destinationPath = destinationPath;
    return ticket;
  };

  ticketMessage = function strategyTicketMessage(ticket) {
    return {
      ...baseTicketMessage(ticket),
      destinationPath: ticket.destinationPath ?? ticket.path,
      sourceStrategy: ticket.sourceStrategy,
    };
  };

  publicAssetTicket = function publicStrategyAssetTicket(ticket) {
    return {
      ...basePublicAssetTicket(ticket),
      destinationPath: ticket.destinationPath ?? ticket.path,
      sourceStrategy: ticket.sourceStrategy,
    };
  };
})();
