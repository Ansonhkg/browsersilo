# BrowserSilo completion matrix

This is the executable definition of “no more crosses”. A row becomes ✅ only when implementation and repository evidence exist. The final gate also requires the real-Brave suite, artifact inspection, and an orphan audit on a working Docker Engine.

## Agent-browser parity

The runtime pins `agent-browser@0.32.2`. BrowserSilo exposes all 127 tenant-safe page/browser operations from that release and adds lease/fencing parameters to every schema. It intentionally replaces 24 host, installation, plugin, dashboard, session-lifecycle, and direct-CDP management tools with BrowserSilo-owned lifecycle and brokerage. Together with 18 BrowserSilo tools, the MCP surface contains 145 typed tools.

| ID | Requirement | Status | Evidence |
| --- | --- | :---: | --- |
| AB-01 | Navigate, snapshot, stable element refs, click, fill, type, evaluate, screenshot | ✅ | Real-Brave acceptance exercised the native CDP action loop and produced inspected PNG proofs |
| AB-02 | Read text/HTML/value/attributes/styles, visibility/enabled/checked state | ✅ | Real-Brave parity traversal passed for page inspection and state queries |
| AB-03 | Focus, double click, keyboard, hover, mouse, scroll, select, check, drag | ✅ | Real-Brave parity traversal passed for pointer, keyboard, form, and drag interactions |
| AB-04 | Selector/text/URL/load/function/download waits | ✅ | Real waits passed, including synchronized download into encrypted artifact brokerage |
| AB-05 | Tabs, windows, frames, dialogs, navigation history | ✅ | Real tabs, popup window, iframe, confirm dialog, and history traversal passed |
| AB-06 | Viewport, device, geolocation, offline, headers, credentials, media | ✅ | Real worker emulation and browser-context controls passed |
| AB-07 | Cookies, localStorage, sessionStorage inspection and mutation | ✅ | Real encrypted profile continuity restored browser state into a different disposable worker |
| AB-08 | Request inspection, interception, response mocking, HAR | ✅ | Real routing and inspection passed; exported HAR was decrypted and validated as JSON |
| AB-09 | Upload, download, PDF, clipboard | ✅ | Brokered real files passed; PDF signature and private X11 clipboard behavior were inspected |
| AB-10 | Console, errors, highlight, trace, profiler | ✅ | Real console/error tools and trace/profile lifecycles passed; 7.4 MiB trace proof inspected |
| AB-11 | Live stream and WebM recording | ✅ | Multipart PNG stream passed; FFprobe verified VP8 WebM at 1440×900 and 10 fps |
| AB-12 | React tree, renders, suspense, Web Vitals | ✅ | Built-in React hook is injected before page code; real `react.dev` tree and vitals calls passed |
| AB-13 | Batch execution and complete typed MCP surface | ✅ | Exact paginated 145-tool contract and representative calls across all safe feature groups passed |

## BrowserSilo platform

| ID | Requirement | Status | Evidence |
| --- | --- | :---: | --- |
| BS-01 | Real headed Brave on disposable workers | ✅ | Existing live LLM milestone proof and Docker runtime |
| BS-02 | Exclusive leases and fencing | ✅ | Core, HTTP, lifecycle, and MCP tests |
| BS-03 | Encrypted profile continuity across workers | ✅ | Existing live continuity proof and profile-store tests |
| BS-04 | KMS envelope keys and per-profile/per-artifact data keys | ✅ | Local and fake AWS KMS tests verify authenticated encryption context |
| BS-05 | Streaming profile encryption/decryption | ✅ | BSLP2 streaming profile-store tests, confidentiality, and tamper rejection |
| BS-06 | Retention, crypto-erasure, export/import, rotation | ✅ | Profile lifecycle HTTP and store tests |
| BS-07 | Purpose-built sandbox-compatible Brave image | ✅ | Non-root image has no `--no-sandbox`; seccomp/read-only/cap-drop runtime contract |
| BS-08 | Private supervisor transport with no host CDP listener | ✅ | In-container MCP over `docker exec`; CDP is `127.0.0.1:9222` with no host publish |
| BS-09 | Per-tenant credentials and principal mapping | ✅ | Bearer-plane and owner-isolation HTTP/MCP tests |
| BS-10 | Per-lease egress policy and private-network protection | ✅ | Live proxy subprocess tests reject IPv4, IPv6, localhost, and unlisted hosts |
| BS-11 | Tenant-neutral warm isolation pool | ✅ | Warm network scaffolds reduce activation work without prebinding a tenant profile or policy to a reusable container |
| BS-12 | Durable control-plane state and crash/orphan recovery | ✅ | JSON repository, two-phase lifecycle, and reconciliation tests |
| BS-13 | Encrypted artifact store, retention, search, export | ✅ | BSAR1 streaming store and lifecycle HTTP tests |
| BS-14 | Comprehensive Domain Capture and redaction | ✅ | Session capture, structured redaction, HAR replacement, and lifecycle tests |
| BS-15 | Quotas, admission queue, pool sizing, placement | ✅ | Core concurrency/admission tests and live operator policy endpoint |
| BS-16 | Metrics, traces, alerts, resource accounting | ✅ | Observability tests and complete Prometheus HELP/TYPE contract |
| BS-17 | Adjustable adapters, policies, resources, and artifacts | ✅ | Persistent operator settings tests and Admin API/UI controls |
| BS-18 | TanStack + Effect + HeroUI control plane | ✅ | Production build; navigation, search, and mobile interaction tests |
| BS-19 | Dark/light themes, shortcuts, deep links, responsive and overflow QA | ✅ | Desktop/mobile browser QA, 390×844 no-overflow measurement, Cmd+K, saved screenshots |
| BS-20 | Concurrency, hostile-site, crash, security, and scale acceptance | ✅ | Two simultaneous isolated workers, third-lease rejection, private-target denial, forced crash recovery, real LLM task, and zero-orphan audit passed |

## Deliberately replaced upstream tools

The 24 excluded upstream tools are `get_cdp_url`, `close`, `connect`, `stream_enable`, `stream_disable`, `stream_status`, `session`, `session_list`, `session_id`, `session_info`, `profiles`, `skills_list`, `skills_get`, `skills_path`, `plugin_add`, `plugin_list`, `plugin_show`, `plugin_run`, `doctor`, `dashboard_start`, `dashboard_stop`, `install`, `upgrade`, and `chat`.

They are not missing page-control features. BrowserSilo replaces them with exclusive leases/fencing, authenticated multipart streaming, durable encrypted profiles, encrypted artifact brokerage, pinned dependencies, and the separate Admin control plane. Exposing the upstream versions would let a tenant bypass ownership, lifecycle, filesystem, or transport boundaries.

## Completion rule

The project is complete only when every row is ✅, `make verify` passes, `make test-agent-live` passes, the generated PNG/WebM/HAR/trace artifacts are inspected, and both labeled Docker containers and networks are empty after shutdown. The July 19, 2026 acceptance run met every gate: 145 tools, 80 representative parity calls, 11 artifact kinds, two concurrent tenants, encrypted state continuity, crash recovery, a real LLM-driven browser task, and zero managed Docker resources left behind.
