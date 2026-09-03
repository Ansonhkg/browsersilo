import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRuntimeRepository } from "../src/adapters/memory-repository.js";
import type { LeaseEgressPolicy, WorkerRuntimeCapabilities } from "../src/core/model.js";
import type { IdGenerator, WorkerDescriptor, WorkerRuntimePort } from "../src/core/ports.js";
import { BrowserSiloCore } from "../src/core/service.js";
import { agentA, FakeClock } from "./helpers.js";

test("activation and release persist crash-recoverable intermediate states around runtime I/O", async () => {
  const repository = new MemoryRuntimeRepository();
  const runtime = new BlockingRuntime();
  const core = new BrowserSiloCore({
    repository,
    workerRuntime: runtime,
    clock: new FakeClock(),
    ids: sequenceIds(),
    pool: {
      warmShellReserve: 1,
      maxActiveWorkers: 2,
      minLeaseTtlSeconds: 10,
      maxLeaseTtlSeconds: 3_600,
      defaultLeaseTtlSeconds: 900,
      maxActiveWorkersPerTenant: 2,
      maxQueueDepth: 0,
      admissionTimeoutMs: 0,
    },
  });
  await core.initialize();
  const profile = await core.createProfile(agentA, { name: "Crash-safe" });

  const acquire = core.acquireLease(agentA, { profileId: profile.id });
  await runtime.activationStarted;
  const provisioning = await repository.snapshot();
  const reservedLease = Object.values(provisioning.leases)[0]!;
  assert.equal(reservedLease.state, "provisioning");
  assert.equal(provisioning.profiles[profile.id]?.status, "leased");
  assert.equal(provisioning.workers[reservedLease.workerId]?.state, "claimed");
  runtime.finishActivation();
  const lease = await acquire;
  assert.equal(lease.state, "active");

  const release = core.releaseLease(agentA, lease.id, { fencingToken: lease.fencingToken });
  await runtime.destructionStarted;
  const releasing = await repository.snapshot();
  assert.equal(releasing.leases[lease.id]?.state, "releasing");
  assert.equal(releasing.workers[lease.workerId]?.state, "draining");
  runtime.finishDestruction();
  assert.equal((await release).state, "closed");
});

class BlockingRuntime implements WorkerRuntimePort {
  readonly #activation = deferred<void>();
  readonly #activationStarted = deferred<void>();
  readonly #destruction = deferred<void>();
  readonly #destructionStarted = deferred<void>();

  get activationStarted(): Promise<void> { return this.#activationStarted.promise; }
  get destructionStarted(): Promise<void> { return this.#destructionStarted.promise; }
  finishActivation(): void { this.#activation.resolve(undefined); }
  finishDestruction(): void { this.#destruction.resolve(undefined); }

  capabilities(): WorkerRuntimeCapabilities {
    return {
      mode: "browser",
      adapter: "blocking-test",
      headedBrave: true,
      nativeCdp: true,
      browserActions: true,
      profilePersistence: "envelope-encrypted",
      limitations: [],
    };
  }

  async createWarmShell(workerId: string): Promise<WorkerDescriptor> {
    return {
      runtimeRef: `test://${workerId}`,
      adapter: "blocking-test",
      braveVersion: null,
      cdpVersion: null,
    };
  }

  async activate(
    _workerId: string,
    _leaseId: string,
    _profileId: string,
    _egressPolicy: LeaseEgressPolicy,
  ): Promise<void> {
    this.#activationStarted.resolve(undefined);
    await this.#activation.promise;
  }

  async destroy(): Promise<void> {
    this.#destructionStarted.resolve(undefined);
    await this.#destruction.promise;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function sequenceIds(): IdGenerator {
  let next = 0;
  return { next: (prefix) => `${prefix}_${++next}` };
}
