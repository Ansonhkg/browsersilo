# Operations guide

Use `/health`, `/ready`, `/version`, and Admin `/metrics` for probes and monitoring. Every HTTP response has `X-BrowserSilo-Trace-Id`. Prometheus output covers requests, errors, latency, active browsers, queue depth, worker states, profile counts, artifact bytes, and resource accounting.

The HeroUI overview surfaces capacity, destroyed workers, current alerts, audit events, adapters, policy controls, encrypted artifacts, and live browsers. Adapter/KMS changes are restart-gated; capacity, queues, quotas, and retention update live.

BrowserSilo reconciles expired browsers once per second and interrupted durable state at startup. A graceful shutdown finalizes capture/recording work, closes Brave, commits encrypted identities, and destroys managed infrastructure.

The release harness retains `compose.log`, partial/final summaries, screenshots, exported artifacts, versions, and image digests under `outputs/e2e-*`. It always attempts run-scoped Compose teardown and then audits both containers and networks by BrowserSilo scope label.

Common failures:

- `CAPACITY_EXHAUSTED` — raise capacity, shorten work, or wait for another browser to close.
- `DOMAIN_NOT_ALLOWED` or `EGRESS_DENIED` — update the public-domain allowlist; private destinations cannot be enabled per browser.
- `HUMAN_TAKEOVER_ACTIVE` — wait for the human to return control, then request a fresh snapshot.
- `MCP_SESSION_REQUIRED` — initialize Streamable HTTP MCP before other messages.
- worker image compatibility error — deploy the same BrowserSilo minor line for both images.
