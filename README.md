# Debatidor Extension

Browser extension that connects supported web-chat tabs to a Debatidor room. It watches whether the model is thinking, streaming, or idle, and talks to the Debatidor backend over WebSocket.

The extension does not access the local filesystem. File changes are handled by [`debatidor-agent`](https://github.com/Debatidor/debatidor-agent).

## Install (unpacked)

1. Create an API key in the Debatidor Hub under **API Keys**.
2. Open Chrome → `chrome://extensions` → enable **Developer mode** → choose **Load unpacked** → select this folder.
3. Open the popup, paste the `deb_live_…` key, and save. Production (`wss://api.debatidor.com/extension`) is selected by default; choose **Local** only when running the Hub on `ws://localhost:3001/extension`.
4. Open any supported host while signed in with your own account.
5. Use **Vincular esta pestaña** in the popup. The header shows **Hub listo** when the backend handshake succeeds.

The provider adapter declares its participant identity automatically. Advanced settings use the generic registration ID `conn_dom` by default.

## How it talks to the backend

Chrome cannot attach custom HTTP headers to `new WebSocket()`. The API key is sent on the handshake query string (`?apiKey=`). The backend also accepts `x-api-key` on HTTP.

The content script only emits `extension.dom_status` and `extension.dom_delta`. Arena events are projected by the backend.

## Supported hosts

| Host | Adapter | Status |
|---|---|---|
| `chat.qwen.ai` | `hosts/qwen.js` | Supported |
| `chatgpt.com` | `hosts/chatgpt.js` | Supported |
| `z.ai` / `chat.z.ai` | `hosts/zai.js` | Supported |
| `claude.ai` | `hosts/claude.js` | Supported |
| Gemini | — | Coming soon; no page access requested yet |

Each adapter owns its selectors, completion signals and participant identity. If a provider changes its DOM, the adapter reports `error` instead of blindly sending keys into the page.

### Z.ai / GLM selector contract

The Z.ai adapter is based on real DOM captures from 2026-09-01/02. It intentionally anchors to semantic/stable attributes (`#chat-input`, `#send-message-button`, `aria-label="Stop"`, `.chat-assistant`, `#response-content-container`, `Regenerate`) and ignores volatile Svelte hashes and `bits-*` ids.

### Claude selector contract

The first Claude adapter is based on a real `claude.ai` capture from 2026-09-02. It anchors to `data-testid="chat-input"`, `data-testid="chat-input-send"`, transcript rows with `data-perf-row`, `data-perf-row-streaming` / `data-is-streaming`, `data-cds="Prose"`, and the final assistant action bar. It intentionally ignores React-generated `_r_*` ids, Base UI ids and utility-class hashes.

## Popup experience

The popup derives the compatibility list and all **open host** actions from the live `HOSTS` catalog in `popup.js`. There are no provider-specific buttons in `popup.html`: adding a supported host to the catalog automatically adds its action and increments the active-host count.

The popup uses the official Debatidor icon at every Chrome-required size and adapts the mascot to onboarding, waiting, and active-agent states. API credentials remain inside `chrome.storage.local`.

## Room routing (0.4.6)

For an Arena turn, save its ID in the extension settings and enable injection for the selected chat tab. Use the same Debatidor account in the Hub, extension and MCP client. A provider API key is not required for web turns.

Room and turn IDs travel with each prompt and response. A tab explicitly bound to another room ignores the prompt; configuration refreshes cannot move a captured response to another room. Presence reports consent and whether the host is busy. Keep one enabled tab per provider when running a single-response acceptance check.

After updating the extension, reload the chat tabs and enable injection again. Verify persistence by reloading the Arena and checking the participant's response, separately from the human prompt.

## Development

Manifest V3. Each file in `hosts/` is a provider adapter. `content.js` runs the shared capture/tool-loop bridge and `background.js` holds the WebSocket.
