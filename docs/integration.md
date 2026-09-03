# Integration guide

BrowserSilo is REST-first. SDKs are optional generated clients; no handwritten SDK contains business rules.

## Authentication

Every public request uses a bearer token. Tenant and principal identity come from the credential, never from request fields. Shared deployments configure `BROWSERSILO_PRINCIPALS_JSON`; the Admin API uses a separate token.

## Open and use a browser

```sh
curl -X POST http://127.0.0.1:4100/v1/browsers \
  -H 'Authorization: Bearer agent-local-development-token' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: morning-research-1' \
  -d '{"identity":"morning-research","allowedDomains":["wikipedia.org"]}'
```

The response contains an opaque browser ID. Call `POST /v1/browsers/{id}/actions` with typed actions such as `navigate`, `snapshot`, `click`, `type`, `press`, `scroll`, `tabs`, `screenshot`, or a reviewed `tool`. Ordered sequences use `actions:batch`. Close with `DELETE /v1/browsers/{id}`.

Clients never send a worker ID, lease, fencing token, Docker option, CDP location, or host path.

## Events

Subscribe to `GET /v1/browsers/{id}/events` with `Accept: text/event-stream`. Persist each `id:` field and reconnect using `Last-Event-ID`. If the replay window has expired, BrowserSilo returns `EVENT_REPLAY_EXPIRED`; fetch current browser state before resubscribing.

## Live view and takeover

Create a short-lived browser credential through `POST /v1/browsers/{id}/live-token`, then connect to `ws://host/v1/browsers/{id}/live?token=...` using subprotocol `browsersilo.v1`. Use `observe` for read-only viewing, `assist` for bounded input, or `takeover` for exclusive human control.

## Stream artifacts

Upload bytes to `POST /v1/artifacts` with `Content-Type`, `X-BrowserSilo-Artifact-Name`, and `X-BrowserSilo-Artifact-Kind`. Export authorized bytes from `GET /v1/artifacts/{id}/export`. Payloads stream through bounded temporary files and encrypted storage rather than being retained in API memory.

## Remote MCP

The Streamable HTTP endpoint is `/mcp`. It supports MCP session initialization, POST messages, GET event streams, and DELETE session termination. Session ownership is bound to a hash of the bearer credential. The stdio adapter is a compatibility network client for older agents.

## Discovery and errors

- `GET /health` — process liveness
- `GET /ready` — browser, storage, and encryption readiness
- `GET /version` — product/API/MCP/WebSocket/worker compatibility
- `GET /openapi.json` — OpenAPI 3.1

Errors use `{ "error": { "code", "message", "details" } }` plus an `X-BrowserSilo-Trace-Id` header. Callers should branch on the stable code, not message text.
