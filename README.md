# Debatidor Extension

Browser extension that connects an open [Qwen](https://chat.qwen.ai) tab to a Debatidor room. It watches whether the model is thinking, streaming, or idle, and talks to the Debatidor backend over WebSocket.

The extension does not access the local filesystem. File changes are handled by [`debatidor-agent`](https://github.com/Debatidor/debatidor-agent).

## Install (unpacked)

1. Create an API key in the Debatidor hub: **API Keys**.
2. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
3. Open the extension popup, paste the `deb_live_…` key, and choose:
   - Local: `ws://localhost:3001/extension`
   - Production: `wss://api.debatidor.com/extension`
4. Open [chat.qwen.ai](https://chat.qwen.ai) while signed in with your own account.
5. Keep that tab focused. The popup shows **Conectado** when the backend handshake succeeds.

`connectionId` must match the participant in the room (default `conn_dom_qwen_01`).

## How it talks to the backend

Chrome cannot attach custom HTTP headers to `new WebSocket()`. The API key is sent on the handshake query string (`?apiKey=`). The backend also accepts `x-api-key` on HTTP.

The content script only emits `extension.dom_status` and `extension.dom_delta`. Arena events are projected by the backend.

## Supported hosts

| Host | Status |
|---|---|
| `chat.qwen.ai` | Supported (selectors versioned in `hosts/qwen.js`) |
| ChatGPT, Gemini, Claude | Not in this release |

Qwen’s DOM changes. If the composer is missing, the extension reports `error` instead of sending keys into the page. Reload the tab after a Qwen UI update, or adjust the selectors in `hosts/qwen.js`.

## Development

Manifest V3. `hosts/qwen.js` is the host adapter. `content.js` runs the `MutationObserver`. `background.js` holds the WebSocket.
