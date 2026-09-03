import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalEncryptedProfileStore } from "../src/adapters/encrypted-profile-store.js";
import { BrowserSiloError } from "../src/core/errors.js";

test("browser profiles are encrypted, authenticated, and restorable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browsersilo-profile-test-"));
  const profileId = "profile_test";
  const secret = "private-cookie-and-history-state";
  try {
    const store = await LocalEncryptedProfileStore.create({
      dataDirectory: directory,
      keyBase64: Buffer.alloc(32, 7).toString("base64"),
    });
    const first = await store.materialize(profileId, "worker_first");
    await mkdir(join(first, "Default"), { recursive: true });
    await writeFile(join(first, "Default", "Cookies"), secret);
    await store.commit(profileId, "worker_first");

    const archivePath = join(directory, "profiles", profileId, "profile.enc");
    const archive = await readFile(archivePath);
    assert.equal(archive.subarray(0, 5).toString("utf8"), "BSLP2");
    assert.equal(archive.includes(Buffer.from(secret)), false);

    const second = await store.materialize(profileId, "worker_second");
    assert.equal(await readFile(join(second, "Default", "Cookies"), "utf8"), secret);
    await store.discard("worker_second");

    const exported = join(directory, "profile-export.bslp");
    await store.exportArchive(profileId, exported);
    await store.importArchive("profile_imported", exported);
    const imported = await store.materialize("profile_imported", "worker_imported");
    assert.equal(await readFile(join(imported, "Default", "Cookies"), "utf8"), secret);
    await store.discard("worker_imported");

    const beforeRotation = await readFile(archivePath);
    await store.rotateArchive(profileId);
    const afterRotation = await readFile(archivePath);
    assert.notDeepEqual(beforeRotation, afterRotation);
    const rotated = await store.materialize(profileId, "worker_rotated");
    assert.equal(await readFile(join(rotated, "Default", "Cookies"), "utf8"), secret);
    await store.discard("worker_rotated");

    const tampered = Buffer.from(afterRotation);
    const lastByte = tampered.length - 1;
    tampered[lastByte] = tampered[lastByte]! ^ 1;
    await writeFile(archivePath, tampered);
    await assert.rejects(
      () => store.materialize(profileId, "worker_tampered"),
      (error: unknown) =>
        error instanceof BrowserSiloError &&
        error.code === "BROWSER_COMMAND_FAILED",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
