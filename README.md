# BrowserSilo

<p align="center">
  <img src="ui/public/browsersilo-mark.svg" alt="BrowserSilo logo" width="120" height="120" />
</p>

BrowserSilo gives each AI agent a real, headed Brave browser that behaves like a human browser while remaining isolated from every other agent. Cookies, history, logins, storage, and preferences belong to a named browser identity; the container that runs Brave is disposable.

BrowserSilo uses native CDP through a private, pinned `agent-browser` runtime. It does not use Playwright, expose raw CDP, or give an agent Docker access.

## The mark

BrowserSilo's mark expresses its core contract: **durable identity, disposable execution**. The continuous `S` represents the encrypted browser identity and session state that persist between runs. The four detached corners form both an isolation boundary and a capture frame, representing replaceable browser workers, tenant separation, and recorded session evidence.

![BrowserSilo control plane showing a fictional private travel browser](docs/assets/control-plane-mock.png)

_Fictional browser data shown; no live account or website._

## Start the complete product

Requirements:

- Docker Engine or Docker Desktop with Compose v2
- Node.js 24 or newer (`nvm use` reads the included `.nvmrc`)
- About 1 GiB RAM and 1 CPU per active Brave browser by default

```sh
test -f .env || cp .env.example .env
make setup
make images
make up
```

Run these commands from the source repository root. Docker Compose reads `.env` automatically; existing shell environment variables take precedence. The template uses public development tokens and binds both host ports to `127.0.0.1`. Keep it local and use test accounts only. To avoid port conflicts, edit `BROWSERSILO_BROWSER_PORT` and `BROWSERSILO_ADMIN_PORT` in `.env` before starting. Native `node`/`npm` startup commands do not automatically load this Compose template.

The bundled dashboard uses open-source UI packages installed by `make setup`. No HeroUI Pro license, account, or registry credentials are required.

This builds and starts two BrowserSilo images:

- `browsersilo/control-plane:0.4.0` — used by the public gateway and the private worker-manager role
- `browsersilo/brave-worker:0.4.0` — created fresh for each active browser

Open the HeroUI control plane at `http://127.0.0.1:4101`. The local admin token is `admin-local-development-token`. The public gateway is `http://127.0.0.1:4100`; its local agent token is `agent-local-development-token`.

Check that the gateway is ready:

```sh
curl --fail http://127.0.0.1:4100/health
```

These URLs assume the template's default ports. The dashboard starts empty until you open a browser through the API or MCP; follow [your first browser test](docs/quick-start.md#test-without-an-ai-agent). No AI-provider key is needed for this manual test.

Stop the services without deleting encrypted browser identities:

```sh
make down
```

## Product website and documentation

The standalone website and integrated documentation live in the separate sibling [`web`](../web) app. That app uses HeroUI Pro; it is not required to install, build, or run this source project. Documentation content and publication checks live in [`web/docs`](../web/docs/README.md). For website maintainers with access to its dependencies:

```sh
cd ../web
make setup
make run
```

Open `http://127.0.0.1:5173/` for the product site, `http://127.0.0.1:5173/docs/` for the task guide, and `http://127.0.0.1:5173/docs/api` for the complete external API catalog. The website stays `noindex` until a canonical production URL is supplied explicitly; see the [documentation app notes](../web/docs/README.md) for the publication gate.

## Connect an AI agent

Point any client that supports remote MCP at:

```text
http://127.0.0.1:4100/mcp
Authorization: Bearer agent-local-development-token
```

The three simplest tools are:

- `browser_open` — open or resume a named browser identity
- `browser_act` — navigate, inspect, click, type, scroll, take screenshots, or use reviewed advanced actions
- `browser_close` — save the encrypted identity and destroy the disposable worker

An ordinary prompt is enough:

> Use my `personal-travel` browser. Compare the train times on the operator’s real website, but stop before buying anything. Let me take over if sign-in is needed, then close the browser when finished.

The existing stdio MCP adapter remains available for clients without remote MCP:

```json
{
  "mcpServers": {
    "browsersilo": {
      "command": "node",
      "args": ["/absolute/path/to/BrowserSilo/source/dist/src/mcp/index.js"],
      "env": {
        "BROWSERSILO_API_URL": "http://127.0.0.1:4100",
        "BROWSERSILO_AGENT_TOKEN": "agent-local-development-token"
      }
    }
  }
}
```

## What is included

- 148 MCP tools: 3 everyday browser tools, 18 BrowserSilo lifecycle/artifact/capture tools, and 127 reviewed `agent-browser` tools
- Versioned REST and OpenAPI for language-neutral integration
- Resumable Server-Sent Events for browser lifecycle and progress
- Binary WebSocket frames with observer, assist, and exclusive human-takeover roles
- Live browser view with Watch, Take over, and Return control actions
- Streamed uploads and downloads with integrity metadata
- Screenshots, PDF, HAR, trace, profiling, WebM screen recording, and complete Domain Capture evidence
- Encrypted browser identities and encrypted artifacts with independent envelope keys
- Local key custody or AWS KMS, key rotation, retention, export/import, deletion, and crypto-erasure
- Per-browser public-domain allowlists and blocking of private, loopback, link-local, metadata, IPv4-mapped IPv6, and special-use destinations
- Per-tenant quotas, admission queues, CPU/RAM/PID limits, metrics, audit events, crash recovery, and orphan reconciliation
- Two-image Compose distribution in which only the private worker manager receives the Docker socket

## Architecture

```mermaid
flowchart LR
    Agent["AI agent"] -->|"Streamable HTTP MCP"| Public["Public control plane"]
    App["Customer app"] -->|"REST, SSE, WebSocket"| Public
    Human["Human operator"] -->|"HeroUI"| Public

    Public -->|"Authenticated narrow protocol"| Manager["Private worker manager"]
    Public <--> Data["Encrypted persistent data"]
    Public <--> KMS["Local key or AWS KMS"]

    Manager --> WorkerA["Disposable Brave worker A"]
    Manager --> WorkerB["Disposable Brave worker B"]
    WorkerA --> ProxyA["Policy egress A"]
    WorkerB --> ProxyB["Policy egress B"]
    ProxyA --> Internet["Allowed public websites"]
    ProxyB --> Internet
```

The public container has no Docker socket. The worker manager is not published to the host and rejects arbitrary images, commands, mounts, networks, ports, entrypoints, privileged mode, and unmanaged resources. CDP stays on loopback inside each disposable worker.

## Browser identities, cookies, and history

Give a browser a stable identity such as `personal-shopping`, `work-research`, or `family-travel`. On close, BrowserSilo flushes Brave, encrypts the identity, and destroys the used container. The next browser with the same identity restores its cookies, history, logins, local storage, extensions’ state, and preferences into a different clean worker.

Plaintext profile data exists only while that browser is active. One identity cannot be active twice.

## Record a workflow or collect a website

Domain Capture can collect a complete evidence package for one domain: DOM, accessibility state, cookies and storage with default redaction, requests, HAR, console output, errors, screenshot, trace, and optional WebM screen recording. BrowserSilo stores the outputs as encrypted owner-scoped artifacts. It does not generate an end-user CLI; the evidence is available for your own analysis or client generation.

## Integrate without the bundled UI

The UI is optional. Applications can use the gateway directly through REST, SSE, WebSocket, streaming artifacts, or remote MCP. Fetch the machine-readable REST contract from:

```text
http://127.0.0.1:4100/openapi.json
```

For local backend-only development, `make run-headless` compiles and runs the server without building the UI. `make mcp` likewise builds only the server for stdio MCP. These retain the existing worker-adapter configuration; use `make up` for the complete Docker-backed product.

Use `make build-ui` to build the dashboard separately, or `make build` for both server and dashboard. UI packages are development dependencies: the control-plane image serves the compiled dashboard and prunes UI build packages from its runtime layer.

See:

- [Quick start](docs/quick-start.md)
- [Integration guide](docs/integration.md)
- [Realtime protocol](docs/realtime.md)
- [Deployment guide](docs/deployment.md)
- [Security model](docs/security.md)
- [Operations guide](docs/operations.md)
- [Migration guide](docs/migration.md)
- [Completion matrix](docs/realtime-completion-matrix.md)

## Release test

The release gate obtains `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_MODEL` from the `browsersilo` `envars` namespace when they are not already present. It never writes their values to evidence or container configuration.

```sh
make test-e2e
```

The command type-checks and tests the project, builds both images, starts an isolated Compose deployment, exercises REST/SSE/WebSocket/remote MCP against real Brave and real public websites, runs a real LLM tool loop, inspects encrypted artifact exports, kills and recovers the public service, exports diagnostics and image digests, tears down the run, and proves that zero run-scoped workers or networks remain. Evidence is written under `outputs/e2e-*`.
