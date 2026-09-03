import { MemoryRuntimeRepository } from "../src/adapters/memory-repository.js";
import { MemoryWorkerRuntime } from "../src/adapters/memory-worker-runtime.js";
import type { PoolConfiguration } from "../src/core/model.js";
import type { BrowserLease } from "../src/core/model.js";
import type { Clock, IdGenerator } from "../src/core/ports.js";
import { BrowserSiloCore } from "../src/core/service.js";

export class FakeClock implements Clock {
  #current: Date;

  constructor(initial = "2026-07-19T12:00:00.000Z") {
    this.#current = new Date(initial);
  }

  now(): Date {
    return new Date(this.#current);
  }

  advanceSeconds(seconds: number): void {
    this.#current = new Date(this.#current.getTime() + seconds * 1_000);
  }
}

class SequenceIds implements IdGenerator {
  #next = 0;

  next(prefix: "profile" | "lease" | "worker" | "audit"): string {
    this.#next += 1;
    return `${prefix}_${String(this.#next).padStart(4, "0")}`;
  }
}

export async function createHarness(
  poolOverrides: Partial<PoolConfiguration> = {},
  beforeLeaseDestroy?: (lease: BrowserLease) => Promise<void>,
): Promise<{
  core: BrowserSiloCore;
  clock: FakeClock;
  workers: MemoryWorkerRuntime;
}> {
  const clock = new FakeClock();
  const workers = new MemoryWorkerRuntime();
  const core = new BrowserSiloCore({
    repository: new MemoryRuntimeRepository(),
    workerRuntime: workers,
    clock,
    ids: new SequenceIds(),
    pool: {
      warmShellReserve: 1,
      maxActiveWorkers: 4,
      minLeaseTtlSeconds: 10,
      maxLeaseTtlSeconds: 3_600,
      defaultLeaseTtlSeconds: 900,
      ...poolOverrides,
    },
    ...(beforeLeaseDestroy ? { beforeLeaseDestroy } : {}),
  });
  await core.initialize();
  return { core, clock, workers };
}

export const agentA = {
  tenantId: "tenant-a",
  principalId: "agent-a",
  kind: "agent" as const,
};

export const agentB = {
  tenantId: "tenant-b",
  principalId: "agent-b",
  kind: "agent" as const,
};
