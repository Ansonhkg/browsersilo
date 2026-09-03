# Milestone 01: Executable isolation foundation

This milestone makes the BrowserSilo domain model and two public API planes executable without claiming that a browser sandbox exists before the Brave adapter is implemented.

## Included

- Framework-neutral TypeScript core with injected repository, clock, identifier, and worker-runtime ports.
- Owner-scoped browser profiles.
- Exclusive, renewable leases with monotonic fencing tokens and idempotent acquisition.
- One clean simulated worker per active lease.
- Permanent destruction of every used worker and automatic warm-reserve replenishment.
- Lease expiry reconciliation.
- Separate Browser API and Admin API listeners and credentials.
- Operator dashboard backed only by the Admin API.
- Sanitized lifecycle audit events.
- Behavioral core tests and a public HTTP acceptance test.

## Deliberately not represented as complete

- Official headed Brave and its worker supervisor.
- Docker container and network isolation.
- Brokered direct-CDP WebSocket transport.
- SQLite and encrypted durable profile storage.
- Profile hydration and commit.
- Screen observation, takeover, and recording.
- Domain Capture bundles and readers.
- Capacity queueing and tenant quotas beyond the active-worker limit.

## Next vertical slice

Implement the Docker worker-runtime adapter and worker supervisor using official stable Brave in headed Xvfb mode. The supervisor must communicate with Brave over `--remote-debugging-pipe`; no host-accessible worker CDP port may be introduced. The acceptance test should acquire a lease, navigate through the scoped gateway using native CDP, release the lease, and prove that the used worker was destroyed.
