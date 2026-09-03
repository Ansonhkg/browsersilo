import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OperatorSettingsStore, type OperatorSettings } from "../src/config/operator-settings.js";

const defaults: OperatorSettings = {
  workerAdapter: "docker",
  workerImage: "browsersilo/brave-worker:0.3.0",
  kmsProvider: "local",
  awsKmsKeyId: null,
  seccompProfile: "/opt/browsersilo/brave-seccomp.json",
  workerMemoryBytes: 1_073_741_824,
  workerCpus: 1,
  workerPidsLimit: 512,
};

test("restart-gated operator settings validate and persist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browsersilo-operator-"));
  const path = join(directory, "operator-settings.json");
  try {
    const first = await OperatorSettingsStore.create(path, defaults);
    const updated = await first.update({
      workerImage: "registry.example/browsesilo:0.4",
      workerCpus: 2.5,
      workerMemoryBytes: 2_147_483_648,
    });
    assert.equal(updated.workerCpus, 2.5);
    const second = await OperatorSettingsStore.create(path, defaults);
    assert.equal(second.current.workerImage, "registry.example/browsesilo:0.4");
    assert.equal(second.current.workerMemoryBytes, 2_147_483_648);
    await assert.rejects(() => second.update({ workerAdapter: "unsafe-host" }));
    assert.equal(second.current.workerAdapter, "docker");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
