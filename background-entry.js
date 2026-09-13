// MV3 classic service worker entrypoint.
// Keep the mature realtime worker untouched; layer extension-originated asset
// saves beside it so the feature can evolve independently.
importScripts('background.js', 'asset-save-background.js');
