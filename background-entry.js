// MV3 classic service worker entrypoint.
// Keep the mature realtime worker untouched; layer strategy-aware ticket
// metadata and extension-originated asset saves beside it.
importScripts(
  'background.js',
  'asset-ticket-strategy-background.js',
  'asset-save-background.js',
);
