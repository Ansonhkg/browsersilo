# Realtime protocol

## Server-Sent Events

Browser streams emit ordered IDs and these event types: `browser.requested`, `browser.ready`, `browser.closed`, `page.changed`, `action.completed`, `action.failed`, `capture.started`, `capture.completed`, `artifact.created`, `takeover.started`, `takeover.ended`, and `warning`.

The in-memory replay window is bounded to 512 events per browser. Heartbeats arrive every 15 seconds. `Last-Event-ID` resumes after a disconnect; an expired position requires a current-state fetch.

## WebSocket handshake

- Route: `/v1/browsers/{browserId}/live`
- Subprotocol: `browsersilo.v1`
- Credential: short-lived, browser-scoped token
- Origin: same-host or explicitly allowed
- Maximum client message: 1 MiB
- Input rate: 100 messages per second

The first JSON message is `browser.ready`. Each image is announced by a JSON `frame` message containing sequence, MIME type, and length, followed by one binary PNG message. Slow viewers use latest-frame-wins backpressure; frames are not accumulated indefinitely.

## Client messages

- `{ "type": "ping" }`
- `{ "type": "takeover.request" }`
- `{ "type": "takeover.release" }`
- `{ "type": "input.keyboard", "key": "Tab" }`
- `{ "type": "input.pointer", "x": 120, "y": 240, "action": "click" }`

Observer credentials cannot inject input. One takeover controller owns input at a time. While takeover is active, normal REST and MCP agent actions fail with `HUMAN_TAKEOVER_ACTIVE`. Returning control sends `refreshSnapshot: true`; previous accessibility references are stale.

The socket is a reviewed BrowserSilo protocol, never a CDP tunnel.
