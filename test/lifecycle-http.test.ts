import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalEncryptedProfileStore } from "../src/adapters/encrypted-profile-store.js";
import { EncryptedArtifactStore } from "../src/artifacts/encrypted-artifact-store.js";
import type { BrowserProfile } from "../src/core/model.js";
import { createAgentCredential, startServers } from "../src/http/server.js";
import { createHarness } from "./helpers.js";

const token = "lifecycle-agent-token";
const otherToken = "lifecycle-other-token";

test("profile and artifact lifecycle APIs stream, isolate, rotate, import, and erase", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browsersilo-lifecycle-"));
  const { core } = await createHarness();
  const profileStore = await LocalEncryptedProfileStore.create({
    dataDirectory: directory,
    keyBase64: Buffer.alloc(32, 11).toString("base64"),
  });
  const artifactStore = await EncryptedArtifactStore.create(
    join(directory, "artifacts"),
    profileStore.keyManagement,
  );
  const servers = await startServers(core, {
    host: "127.0.0.1",
    browserPort: 0,
    adminPort: 0,
    adminToken: "lifecycle-admin-token",
    profileStore,
    artifactStore,
    agentCredentials: [
      createAgentCredential(token, {
        tenantId: "tenant-life",
        principalId: "agent-life",
        kind: "agent",
      }),
      createAgentCredential(otherToken, {
        tenantId: "tenant-other",
        principalId: "agent-other",
        kind: "agent",
      }),
    ],
  });
  const base = `http://127.0.0.1:${servers.browserPort}`;
  try {
    const profileResponse = await fetch(`${base}/v1/profiles`, {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({ name: "Lifecycle identity" }),
    });
    assert.equal(profileResponse.status, 201);
    const profile = await profileResponse.json() as BrowserProfile;
    const materialized = await profileStore.materialize(profile.id, "worker_lifecycle");
    await mkdir(join(materialized, "Default"), { recursive: true });
    await writeFile(join(materialized, "Default", "History"), "durable browser history");
    await profileStore.commit(profile.id, "worker_lifecycle");

    const exportedResponse = await fetch(`${base}/v1/profiles/${profile.id}/export`, {
      headers: authHeaders(token),
    });
    assert.equal(exportedResponse.status, 200);
    const exported = Buffer.from(await exportedResponse.arrayBuffer());
    assert.equal(exported.subarray(0, 5).toString("utf8"), "BSLP2");

    const rotateResponse = await fetch(`${base}/v1/profiles/${profile.id}/rotate`, {
      method: "POST",
      headers: jsonHeaders(token),
      body: "{}",
    });
    assert.equal(rotateResponse.status, 200);

    const importResponse = await fetch(`${base}/v1/profiles/import`, {
      method: "POST",
      headers: {
        ...authHeaders(token),
        "content-type": "application/vnd.browsersilo.profile",
        "x-browsersilo-profile-name": "Imported identity",
      },
      body: exported,
    });
    assert.equal(importResponse.status, 201);
    const imported = await importResponse.json() as BrowserProfile;
    const importedDirectory = await profileStore.materialize(imported.id, "worker_import_check");
    assert.equal(
      await readFile(join(importedDirectory, "Default", "History"), "utf8"),
      "durable browser history",
    );
    await profileStore.discard("worker_import_check");

    const artifactPayload = Buffer.from("tenant-private HAR payload");
    const artifactResponse = await fetch(`${base}/v1/artifacts`, {
      method: "POST",
      headers: {
        ...authHeaders(token),
        "content-type": "application/json",
        "x-browsersilo-artifact-name": "capture.har",
        "x-browsersilo-artifact-kind": "har",
      },
      body: artifactPayload,
    });
    assert.equal(artifactResponse.status, 201);
    const artifact = await artifactResponse.json() as { id: string };
    assert.equal(
      (await fetch(`${base}/v1/artifacts/${artifact.id}`, {
        headers: authHeaders(otherToken),
      })).status,
      404,
    );
    const artifactExport = await fetch(`${base}/v1/artifacts/${artifact.id}/export`, {
      headers: authHeaders(token),
    });
    assert.deepEqual(Buffer.from(await artifactExport.arrayBuffer()), artifactPayload);

    assert.equal(
      (await fetch(`${base}/v1/artifacts/${artifact.id}`, {
        method: "DELETE",
        headers: authHeaders(token),
      })).status,
      204,
    );
    assert.equal(
      (await fetch(`${base}/v1/profiles/${profile.id}`, {
        method: "DELETE",
        headers: authHeaders(token),
      })).status,
      204,
    );
    assert.equal(await profileStore.archiveExists(profile.id), false);
  } finally {
    await servers.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function authHeaders(value: string): Record<string, string> {
  return { authorization: `Bearer ${value}` };
}

function jsonHeaders(value: string): Record<string, string> {
  return { ...authHeaders(value), "content-type": "application/json" };
}
