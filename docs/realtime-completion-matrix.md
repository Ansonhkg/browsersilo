# BrowserSilo 0.4 completion matrix

| Capability | Status | Release evidence |
|---|:---:|---|
| Real headed Brave, not Playwright | ✅ | Pinned Brave worker and real Wikipedia acceptance |
| Human-compatible agent-browser parity | ✅ | 127 reviewed parity tools plus 21 BrowserSilo tools |
| Everyday browser lifecycle vocabulary | ✅ | `browser_open`, `browser_act`, `browser_close` |
| REST and OpenAPI 3.1 | ✅ | `/v1/browsers`, typed actions/batch/capture/artifacts, `/openapi.json` |
| Resumable SSE | ✅ | Ordered IDs, replay, resume, expiry error, heartbeat |
| Binary WebSocket live view | ✅ | `browsersilo.v1`, PNG binary frames, latest-frame backpressure |
| Observer, assist, and exclusive takeover | ✅ | Short-lived scoped tokens, agent pause, fresh-snapshot return |
| Streamable HTTP MCP | ✅ | Authenticated stateful `/mcp`; real LLM release journey |
| Stdio MCP compatibility | ✅ | Existing adapter retained and tested |
| Open-source HeroUI operator interface | ✅ | Capacity, resources, adapters, policies, live watch/takeover |
| Screen recording | ✅ | X11-to-WebM, encrypted artifact, EBML inspection |
| HAR, trace, screenshot, PDF, download | ✅ | Real-domain capture and signature/parseability checks |
| Complete domain evidence collection | ✅ | Redacted Domain Capture manifest plus linked artifacts |
| Encrypted cookie/history/login continuity | ✅ | Identity restored across distinct disposable workers |
| Local keys and AWS KMS | ✅ | Independent envelope keys, rotation, retention, deletion |
| Streaming encrypted artifacts | ✅ | 1 MiB+ upload/export SHA-256 integrity proof |
| Multi-tenant ownership and concurrency | ✅ | Simultaneous tenant workers and cross-tenant denial |
| Domain and private-network protection | ✅ | Public allowlists plus loopback/metadata/private denial |
| Public service without Docker socket | ✅ | Compose mount exists only on worker-manager role |
| Restricted worker manager | ✅ | Arbitrary image/command/mount/network/port/privilege rejection tests |
| Two version-matched images | ✅ | Control-plane 0.4.0 and Brave-worker 0.4.0 digests recorded |
| Crash recovery and orphan reconciliation | ✅ | Forced public-service kill, replacement worker, zero-orphan audit |
| One-command release gate | ✅ | `make test-e2e` builds, runs, proves, exports, and cleans up |
