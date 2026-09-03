import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonFileRuntimeRepository } from "../src/adapters/json-file-repository.js";
import { MemoryWorkerRuntime } from "../src/adapters/memory-worker-runtime.js";
import { BrowserSiloCore } from "../src/core/service.js";
import type { IdGenerator } from "../src/core/ports.js";
import { FakeClock } from "./helpers.js";

test("runtime state is atomically persisted and restored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browsersilo-state-test-"));
  const statePath = join(directory, "control-plane", "runtime.json");
  const first = await JsonFileRuntimeRepository.create(statePath);
  await first.transaction((state) => {
    state.profileFences["profile_one"] = 7;
    state.idempotencyKeys["tenant:owner:key"] = "lease_one";
  });

  const second = await JsonFileRuntimeRepository.create(statePath);
  const restored = await second.snapshot();
  assert.equal(restored.profileFences["profile_one"], 7);
  assert.equal(restored.idempotencyKeys["tenant:owner:key"], "lease_one");
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  const persisted = await readFile(statePath, "utf8");
  assert.doesNotThrow(() => JSON.parse(persisted));
});

test("live pool settings survive control-plane restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browsersilo-pool-state-"));
  const path = join(directory, "runtime.json");
  try {
    const first = new BrowserSiloCore({
      repository: await JsonFileRuntimeRepository.create(path),
      workerRuntime: new MemoryWorkerRuntime(),
      clock: new FakeClock(),
      ids: sequenceIds(),
      pool: pool(4),
    });
    await first.initialize();
    await first.updatePool({ maxActiveWorkers: 3, maxActiveWorkersPerTenant: 2, maxQueueDepth: 9 });

    const second = new BrowserSiloCore({
      repository: await JsonFileRuntimeRepository.create(path),
      workerRuntime: new MemoryWorkerRuntime(),
      clock: new FakeClock(),
      ids: sequenceIds(),
      pool: pool(7),
    });
    await second.initialize();
    const restored = (await second.overview()).pool;
    assert.equal(restored.maxActiveWorkers, 3);
    assert.equal(restored.maxActiveWorkersPerTenant, 2);
    assert.equal(restored.maxQueueDepth, 9);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function pool(maxActiveWorkers: number) {
  return {
    warmShellReserve: 1,
    maxActiveWorkers,
    minLeaseTtlSeconds: 10,
    maxLeaseTtlSeconds: 3_600,
    defaultLeaseTtlSeconds: 900,
    maxActiveWorkersPerTenant: Math.min(2, maxActiveWorkers),
    maxQueueDepth: 4,
    admissionTimeoutMs: 1_000,
  };
}

function sequenceIds(): IdGenerator {
  let next = 0;
  return { next: (prefix) => `${prefix}_${++next}` };
}
