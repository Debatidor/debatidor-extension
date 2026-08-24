# Debatidor Extension

Browser extension that connects an open [Qwen](https://chat.qwen.ai) tab to a Debatidor room. It watches whether the model is thinking, streaming, or idle, and talks to the Debatidor backend over WebSocket.

The extension does not access the local filesystem. File changes are handled by [`debatidor-agent`](https://github.com/Debatidor/debatidor-agent).

## Install (unpacked)

1. Create an API key in the Debatidor Hub under **API Keys**.
2. Open Chrome → `chrome://extensions` → enable **Developer mode** → choose **Load unpacked** → select this folder.
3. Open the popup, paste the `deb_live_…` key, and save. Production (`wss://api.debatidor.com/extension`) is selected by default; choose **Local** only when running the Hub on `ws://localhost:3001/extension`.
4. Open [chat.qwen.ai](https://chat.qwen.ai) while signed in with your own account.
5. Use **Vincular esta pestaña** in the popup. The header shows **Hub listo** when the backend handshake succeeds.

The provider adapter declares its participant identity automatically. Advanced settings use the generic registration ID `conn_dom` by default.

## How it talks to the backend

Chrome cannot attach custom HTTP headers to `new WebSocket()`. The API key is sent on the handshake query string (`?apiKey=`). The backend also accepts `x-api-key` on HTTP.

The content script only emits `extension.dom_status` and `extension.dom_delta`. Arena events are projected by the backend.

## Supported hosts

| Host | Status |
|---|---|
| `chat.qwen.ai` | Supported (selectors versioned in `hosts/qwen.js`) |
| ChatGPT, Gemini, Claude | Coming soon; no page access requested in this release |

Qwen's DOM changes. If the composer is missing, the extension reports `error` instead of sending keys into the page. Reload the tab after a Qwen UI update, or adjust the selectors in `hosts/qwen.js`.

## Popup experience

The popup uses the official Debatidor icon at every Chrome-required size and adapts the mascot to onboarding, waiting, and active-agent states. It exposes one primary action per state, keeps API credentials inside `chrome.storage.local`, and labels unreleased integrations as **Próximamente**.

## Development

Manifest V3. `hosts/qwen.js` is the host adapter. `content.js` runs the `MutationObserver`. `background.js` holds the WebSocket.
