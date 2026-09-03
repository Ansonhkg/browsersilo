# Deployment guide

## Images and roles

BrowserSilo publishes two version-matched images. Compose runs the trusted control-plane image twice:

1. `control-plane` — public REST, SSE, WebSocket, Streamable HTTP MCP, HeroUI, scheduling, encryption, persistence, policy, and observability; no Docker socket.
2. `worker-manager` — private allowlisted Docker operations; the only service with `/var/run/docker.sock`.
3. Disposable containers from `browsersilo/brave-worker:0.4.0` — one active browser each, plus a bounded egress sidecar on an isolated internal network.

## Persistent data

The `browsersilo-data-*` named volume stores encrypted profiles, encrypted artifacts, control state, and operator settings. Active profile plaintext is a temporary subdirectory of that volume mounted into one worker using `volume-subpath`; it is encrypted and removed on close.

Set a stable base64 32-byte `BROWSERSILO_DATA_KEY`, or configure AWS KMS with `BROWSERSILO_KMS_PROVIDER=aws-kms`, `BROWSERSILO_AWS_KMS_KEY_ID`, and `AWS_REGION`. Never rotate a raw local master key by simply replacing the environment variable; use the application rotation flow.

## Production configuration

Replace all local credentials, terminate TLS before the gateway, restrict trusted WebSocket origins, keep the Admin API on a management network, pin both images by digest, and back up the encrypted volume. Configure global/per-tenant capacity, queue timeout, worker RAM, CPU, and PID limits for the host.

The 0.4 control plane rejects worker tags outside the compatible 0.4 line. Releases record both image content digests.

Docker-socket authority remains powerful even behind a narrow service. For production, additionally apply a Docker authorization proxy/policy or a future non-Docker provider. Never publish worker-manager ports 4200 or 4201.

## Upgrade and recovery

Stop and replace the public service without removing its data volume. Startup reconciles interrupted durable states and BrowserSilo-labeled resources. Used workers are destroyed, never returned to the clean reserve. Keep the worker manager on the same immutable control-plane image during an upgrade.
