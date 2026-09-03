# Security and operations

## Trust model

BrowserSilo treats agent principals as mutually untrusted. Each bearer token maps to one tenant and owner. The Browser API checks that identity before every profile, lease, browser, upload, saved-state, artifact, capture, and export operation. The Admin API has a separate credential and is not an agent surface.

The Docker daemon, host kernel, key-management service, BrowserSilo service process, and Admin operators are trusted infrastructure. A compromise of those components is outside the worker sandbox boundary.

## Worker boundary

Every active lease owns one worker container, one egress sidecar, and one isolated Docker network. The worker runs as UID 1000 with a read-only root filesystem, dropped capabilities, `no-new-privileges`, a bounded PID namespace, explicit CPU/memory limits, and `container/brave-seccomp.json`. Brave's own Chromium sandbox remains enabled.

Brave listens on `127.0.0.1:9222` inside its container. BrowserSilo publishes no CDP port. The service starts the pinned `agent-browser` MCP process with `docker exec -i`; agents reach it only through authenticated, fenced BrowserSilo calls. Used workers are closed, committed, and permanently removed rather than returned to the warm reserve.

## Network boundary

The worker's HTTP(S) proxy is its egress sidecar. Every lease may restrict traffic to a list of public domains. The proxy rejects loopback, RFC1918/private, link-local, carrier-grade NAT, benchmarking, documentation, multicast, reserved, metadata, and IPv6 local/special-use destinations. DNS results are validated before connection.

This is an application egress boundary, not a replacement for host firewalling. A production deployment should also deny worker-network access at the host/cloud network layer and restrict Docker daemon access to the BrowserSilo service account.

## Profiles, cookies, and history

A BrowserSilo profile is a normal Brave user-data directory. Cookies, browsing history, local storage, cache metadata, and other browser identity state follow that profile across disposable workers. Only one live lease may own the profile. Release performs graceful browser shutdown before streaming the directory into an authenticated BSLP2 archive.

Each profile and artifact receives its own random data key. Local development wraps keys with a protected local master key. AWS KMS mode uses an authenticated encryption context containing the tenant/profile or artifact purpose, preventing wrapped-key substitution across objects.

Profile deletion and artifact deletion remove ciphertext plus the only wrapped copy of the unique data key. This is application-level crypto-erasure. Volume snapshots, backups, hardware remanence, and provider-level media destruction require separate infrastructure policy.

## Capture sensitivity

Domain Capture redacts structured secrets and HAR headers, cookies, authorization material, and configured sensitive values by default. Trace archives and WebM video are opaque browser outputs and may include page content, credentials typed on screen, or transmitted values. Keep them encrypted, owner-scoped, access-logged, and short-lived.

The capture is session-scoped: start it before the interaction and stop it afterward. It records the browser-observable activity for the chosen domain, not traffic generated outside that lease or outside the browser.

## Crash and restart behavior

Lifecycle transitions are durably recorded before and after worker mutations. On startup BrowserSilo reconciles provisioning, active, releasing, and orphaned workers against labeled Docker resources. An interrupted active worker is closed when possible, its profile is committed, the used worker is removed, and a clean reserve is restored.

`browser_lease_release` is the normal path because it seals active Domain Capture or recording work before shutting down Brave. A hard process or host crash cannot guarantee the final frame or final HAR/trace flush; recovery preserves the last durably committed browser profile and removes orphaned infrastructure.

## Operator checklist

Before sharing the service between tenants:

1. Build and pin `browsersilo/brave-worker:0.3.0` by digest.
2. Replace `agent-local-development-token` and `admin-local`; provide `BROWSERSILO_PRINCIPALS_JSON` from a secret manager.
3. Use AWS KMS or inject a stable external `BROWSERSILO_DATA_KEY`; never bake keys into the image.
4. Keep Browser and Admin listeners private. Put the Admin plane on a management network.
5. Mount `.data` on encrypted durable storage and define encrypted-backup retention.
6. Enforce host/cloud network policy in addition to the egress sidecar.
7. Tune warm reserve, global/per-tenant limits, queue depth, worker CPU/memory/PIDs, and artifact retention in the control plane.
8. Scrape `/metrics`, route alerts, and watch browser seconds, worker creation, artifact bytes, queue depth, request errors, and active leases.
9. Run `make verify` for every change and `make test-agent-live` against the exact production image before promotion.
10. After shutdown, verify `docker ps -a --filter label=browsesilo.managed=true` returns no containers.

Adapter and KMS changes are restart-gated so active leases cannot silently change isolation or key custody. Capacity, tenant quotas, queue limits, and artifact retention apply live.
