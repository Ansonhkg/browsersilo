import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSiloError } from "../src/core/errors.js";
import { agentA, agentB, createHarness } from "./helpers.js";

test("one active lease receives one worker and release destroys that worker", async () => {
  const { core } = await createHarness();
  const profile = await core.createProfile(agentA, { name: "Primary" });
  const lease = await core.acquireLease(agentA, { profileId: profile.id });

  const active = await core.adminSnapshot();
  assert.equal(active.overview.activeLeases, 1);
  assert.equal(active.overview.workers.active, 1);
  assert.equal(active.overview.workers.ready, 1);
  assert.equal(active.workers.find((worker) => worker.id === lease.workerId)?.everLeased, true);

  await core.releaseLease(agentA, lease.id, {
    fencingToken: lease.fencingToken,
  });
  const released = await core.adminSnapshot();
  assert.equal(released.overview.activeLeases, 0);
  assert.equal(released.overview.workers.destroyed, 1);
  assert.equal(released.overview.workers.ready, 1);
  assert.equal(
    released.profiles.find((candidate) => candidate.id === profile.id)?.status,
    "ready",
  );
});

test("a profile cannot be leased concurrently and acquisition is idempotent", async () => {
  const { core } = await createHarness();
  const profile = await core.createProfile(agentA, { name: "Exclusive" });
  const first = await core.acquireLease(agentA, {
    profileId: profile.id,
    idempotencyKey: "request-1",
  });
  const replay = await core.acquireLease(agentA, {
    profileId: profile.id,
    idempotencyKey: "request-1",
  });
  assert.equal(replay.id, first.id);

  await assert.rejects(
    () => core.acquireLease(agentA, { profileId: profile.id }),
    hasCode("PROFILE_LEASE_CONFLICT"),
  );
});

test("a stale fencing token cannot renew or release a lease", async () => {
  const { core } = await createHarness();
  const profile = await core.createProfile(agentA, { name: "Fenced" });
  const lease = await core.acquireLease(agentA, { profileId: profile.id });

  await assert.rejects(
    () => core.renewLease(agentA, lease.id, { fencingToken: lease.fencingToken - 1 }),
    hasCode("STALE_FENCE"),
  );
  await assert.rejects(
    () => core.releaseLease(agentA, lease.id, { fencingToken: lease.fencingToken + 1 }),
    hasCode("STALE_FENCE"),
  );
  assert.equal((await core.getLease(agentA, lease.id)).state, "active");
});

test("profile and lease access are bound to the authenticated principal", async () => {
  const { core } = await createHarness();
  const profile = await core.createProfile(agentA, { name: "Private" });
  const lease = await core.acquireLease(agentA, { profileId: profile.id });

  await assert.rejects(
    () => core.getProfile(agentB, profile.id),
    hasCode("FORBIDDEN"),
  );
  await assert.rejects(
    () => core.getLease(agentB, lease.id),
    hasCode("FORBIDDEN"),
  );
});

test("reconciliation expires leases, destroys used workers, and restores reserve", async () => {
  const { core, clock } = await createHarness();
  const profile = await core.createProfile(agentA, { name: "Expiring" });
  const lease = await core.acquireLease(agentA, {
    profileId: profile.id,
    ttlSeconds: 10,
  });
  clock.advanceSeconds(11);
  await core.reconcile();

  assert.equal((await core.getLease(agentA, lease.id)).state, "expired");
  const snapshot = await core.adminSnapshot();
  assert.equal(snapshot.overview.workers.destroyed, 1);
  assert.equal(snapshot.overview.workers.ready, 1);
});

test("expiry reconciliation finalizes active capture work before destroying the worker", async () => {
  const finalized: string[] = [];
  const { core, clock } = await createHarness({}, async (lease) => {
    finalized.push(lease.id);
    assert.equal(lease.state, "releasing");
  });
  const profile = await core.createProfile(agentA, { name: "Recorded expiry" });
  const lease = await core.acquireLease(agentA, {
    profileId: profile.id,
    ttlSeconds: 10,
  });
  clock.advanceSeconds(11);

  await core.reconcile();

  assert.deepEqual(finalized, [lease.id]);
  assert.equal((await core.getLease(agentA, lease.id)).state, "expired");
});

test("a failed expiry finalizer keeps the lease and worker active for retry", async () => {
  const { core, clock } = await createHarness({}, async () => {
    throw new Error("capture flush failed");
  });
  const profile = await core.createProfile(agentA, { name: "Retry expiry" });
  const lease = await core.acquireLease(agentA, {
    profileId: profile.id,
    ttlSeconds: 10,
  });
  clock.advanceSeconds(11);

  await core.reconcile();

  assert.equal((await core.getLease(agentA, lease.id)).state, "active");
  assert.equal(
    (await core.adminSnapshot()).workers.find((worker) => worker.id === lease.workerId)?.state,
    "active",
  );
});

test("capacity exhaustion is explicit", async () => {
  const { core } = await createHarness({ maxActiveWorkers: 1 });
  const first = await core.createProfile(agentA, { name: "First" });
  const second = await core.createProfile(agentA, { name: "Second" });
  await core.acquireLease(agentA, { profileId: first.id });

  await assert.rejects(
    () => core.acquireLease(agentA, { profileId: second.id }),
    hasCode("CAPACITY_EXHAUSTED"),
  );
});

test("the admission queue wakes when capacity is released", async () => {
  const { core } = await createHarness({
    maxActiveWorkers: 1,
    maxActiveWorkersPerTenant: 1,
    maxQueueDepth: 2,
    admissionTimeoutMs: 2_000,
  });
  const firstProfile = await core.createProfile(agentA, { name: "First queued" });
  const secondProfile = await core.createProfile(agentA, { name: "Second queued" });
  const firstLease = await core.acquireLease(agentA, { profileId: firstProfile.id });
  const secondLeasePromise = core.acquireLease(agentA, { profileId: secondProfile.id });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(core.admissionSnapshot().queued, 1);

  await core.releaseLease(agentA, firstLease.id, { fencingToken: firstLease.fencingToken });
  const secondLease = await secondLeasePromise;
  assert.equal(secondLease.state, "active");
  assert.equal(core.admissionSnapshot().queued, 0);
});

test("invalid live pool updates roll back cleanly", async () => {
  const { core } = await createHarness({ maxActiveWorkers: 4 });
  await assert.rejects(
    () => core.updatePool({ maxActiveWorkers: 0 }),
    /Invalid BrowserSilo pool configuration/,
  );
  assert.equal((await core.overview()).pool.maxActiveWorkers, 4);
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof BrowserSiloError && error.code === code;
}
