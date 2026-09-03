# Security model

The trust boundary is the authenticated BrowserSilo service plus a separate disposable worker/network pair for each active browser.

## Guarantees

- The public service has no Docker socket.
- The private worker manager accepts only the configured image, managed labels, approved networks, the encrypted profile volume subpath, and reviewed private operations.
- Privileged mode, added capabilities, host namespaces, host networks, host mounts, device access, published ports, arbitrary entrypoints, arbitrary commands, unmanaged targets, and volume deletion are rejected.
- Workers run non-root, read-only, capability-free, `no-new-privileges`, resource-limited, and with the BrowserSilo seccomp profile.
- CDP and the private agent-browser MCP process remain on worker loopback and are never published.
- Egress goes through one policy sidecar and blocks private/special networks, metadata endpoints, mixed public/private DNS, and domains outside the browser allowlist.
- Browser, artifact, live token, WebSocket message, and admin operations are authorized at use time.
- Profile and artifact objects have independent wrapped data keys and authenticated encryption context.

## Human takeover

Viewer tokens are random, hashed in memory, browser-scoped, role-scoped, and expire after five minutes. A takeover pauses agent input. Observer sockets are read-only. Message size, origin, schema, coordinate, rate, and backpressure limits are enforced.

## Limits

BrowserSilo does not defend against a compromised Docker daemon, host kernel, KMS administrator, or operator with direct encrypted-volume and key access. A website can still detect automation or require human CAPTCHA completion. Trace and video outputs can contain visible secrets even when structured capture fields are redacted; use short retention where appropriate.
