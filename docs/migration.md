# Migration guide

## From host-run BrowserSilo

Keep the existing data directory, stop the host service cleanly, copy its encrypted contents into the Compose data volume, configure the same local key or KMS key, then start `make up`. Back up before migration. Do not copy an active plaintext runtime directory.

## From stdio MCP

Preferred: point the agent directly to `https://your-gateway/mcp` with its bearer credential. No local Node adapter is required.

Compatibility: retain `dist/src/mcp/index.js` and change only `BROWSERSILO_API_URL` and `BROWSERSILO_AGENT_TOKEN`. The stdio adapter remains a thin network client.

Existing detailed lifecycle tools continue to work. New integrations should prefer `browser_open`, `browser_act`, and `browser_close`, which keep profiles, workers, and stale-command fencing private.

## Without the bundled UI

Keep your own control plane and integrate through OpenAPI REST, SSE, WebSocket, streaming artifacts, or remote MCP. The HeroUI app is not a runtime dependency for browser clients.
