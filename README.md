# Debatidor Extension

Browser extension that connects an open chat tab to a Debatidor room. It observes generation state in the page and exchanges messages with the Debatidor backend.

The extension does not access the local filesystem.

## Install (unpacked)

1. Start the Debatidor backend, or point the popup at production (`wss://api.debatidor.com/extension`).
2. Chrome → `chrome://extensions` → Developer mode → Load unpacked → this folder.
3. Open the chat site (Qwen is supported first).
4. Open the extension popup and set:

- WebSocket URL: `ws://localhost:3001/extension` or `wss://api.debatidor.com/extension`
- `connectionId` for the participant in the room

## Supported hosts

| Host | Status |
|---|---|
| `chat.qwen.ai` | Supported |
| ChatGPT, Gemini, Claude | Adapter interface ready; selectors pending |

## Development

Manifest V3. Content scripts live in `hosts/` and `content.js`. The service worker (`background.js`) holds the WebSocket to the backend.
