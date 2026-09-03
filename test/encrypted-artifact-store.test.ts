import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EncryptedArtifactStore } from "../src/artifacts/encrypted-artifact-store.js";
import { LocalKeyManagement } from "../src/security/key-management.js";

const owner = {
  tenantId: "tenant-artifacts",
  principalId: "agent-artifacts",
  kind: "agent" as const,
};

test("artifacts are tenant-scoped, searchable, exportable, and crypto-erased", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browsersilo-artifacts-"));
  const source = join(directory, "source.har");
  const exported = join(directory, "exported.har");
  const secret = Buffer.from('{"cookie":"private-session"}');
  try {
    await writeFile(source, secret, { mode: 0o600 });
    const store = await EncryptedArtifactStore.create(
      join(directory, "store"),
      new LocalKeyManagement(Buffer.alloc(32, 9)),
    );
    const artifact = await store.put({
      principal: owner,
      leaseId: "lease_test",
      profileId: "profile_test",
      kind: "har",
      name: "capture.har",
      mimeType: "application/json",
      sourcePath: source,
      retentionSeconds: 60,
      labels: { domain: "example.com" },
    });

    const encrypted = await readFile(
      join(directory, "store", artifact.id, "payload.enc"),
    );
    assert.equal(encrypted.subarray(0, 5).toString("utf8"), "BSAR1");
    assert.equal(encrypted.includes(secret), false);
    assert.equal((await store.list(owner, { text: "example.com" }))[0]?.id, artifact.id);
    assert.equal((await store.list(owner, { kind: "har" })).length, 1);
    await store.exportTo(owner, artifact.id, exported);
    assert.deepEqual(await readFile(exported), secret);

    await assert.rejects(() =>
      store.get(
        { tenantId: "other", principalId: "agent-artifacts", kind: "agent" },
        artifact.id,
      ),
    );
    await store.delete(owner, artifact.id);
    assert.equal((await store.list(owner)).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("expired artifacts are removed by retention enforcement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browsersilo-retention-"));
  const source = join(directory, "source.txt");
  try {
    await writeFile(source, "expired");
    const store = await EncryptedArtifactStore.create(
      join(directory, "store"),
      new LocalKeyManagement(Buffer.alloc(32, 3)),
    );
    const artifact = await store.put({
      principal: owner,
      kind: "other",
      name: "expired.txt",
      mimeType: "text/plain",
      sourcePath: source,
      retentionSeconds: 1,
    });
    assert.deepEqual(
      await store.pruneExpired(new Date(Date.now() + 2_000)),
      [artifact.id],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact retention policy persists across store restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browsersilo-artifact-settings-"));
  try {
    const keys = new LocalKeyManagement(Buffer.alloc(32, 9));
    const artifactDirectory = join(directory, "artifacts");
    const first = await EncryptedArtifactStore.create(
      artifactDirectory,
      keys,
    );
    await first.setDefaultRetentionSeconds(12_345);
    const second = await EncryptedArtifactStore.create(
      artifactDirectory,
      keys,
    );
    assert.equal(second.defaultRetentionSeconds, 12_345);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
