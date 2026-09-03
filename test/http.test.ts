import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserLease, BrowserProfile } from "../src/core/model.js";
import { createAgentCredential, startServers } from "../src/http/server.js";
import { createHarness } from "./helpers.js";

test("Browser and Admin APIs expose the first public acceptance seam", async () => {
  const { core } = await createHarness();
  const servers = await startServers(core, {
    host: "127.0.0.1",
    browserPort: 0,
    adminPort: 0,
    adminToken: "admin-test",
    agentCredentials: [
      createAgentCredential("agent-test-token-a", {
        tenantId: "tenant-api",
        principalId: "agent-api",
        kind: "agent",
      }),
      createAgentCredential("agent-test-token-b", {
        tenantId: "tenant-other",
        principalId: "agent-other",
        kind: "agent",
      }),
    ],
  });

  const browser = `http://127.0.0.1:${servers.browserPort}`;
  const admin = `http://127.0.0.1:${servers.adminPort}`;
  try {
    const unauthenticated = await fetch(`${browser}/v1/profiles`);
    assert.equal(unauthenticated.status, 401);

    const profileResponse = await fetch(`${browser}/v1/profiles`, {
      method: "POST",
      headers: agentHeaders(),
      body: JSON.stringify({ name: "API profile" }),
    });
    assert.equal(profileResponse.status, 201);
    assert.match(profileResponse.headers.get("x-browsersilo-trace-id") ?? "", /^[a-f0-9-]{36}$/);
    const profile = (await profileResponse.json()) as BrowserProfile;
    const crossTenant = await fetch(`${browser}/v1/profiles/${profile.id}`, {
      headers: { authorization: "Bearer agent-test-token-b" },
    });
    assert.equal(crossTenant.status, 403);

    const leaseResponse = await fetch(`${browser}/v1/leases`, {
      method: "POST",
      headers: { ...agentHeaders(), "idempotency-key": "api-lease" },
      body: JSON.stringify({ profileId: profile.id, ttlSeconds: 60 }),
    });
    assert.equal(leaseResponse.status, 201);
    const lease = (await leaseResponse.json()) as BrowserLease;
    assert.equal(lease.state, "active");
    assert.equal(lease.cdpEndpoint, null);

    const snapshotResponse = await fetch(`${admin}/admin/v1/snapshot`, {
      headers: { authorization: "Bearer admin-test" },
    });
    assert.equal(snapshotResponse.status, 200);
    const snapshot = (await snapshotResponse.json()) as {
      overview: { activeLeases: number; workers: { active: number; ready: number } };
    };
    assert.equal(snapshot.overview.activeLeases, 1);
    assert.equal(snapshot.overview.workers.active, 1);
    assert.equal(snapshot.overview.workers.ready, 1);

    const releaseResponse = await fetch(
      `${browser}/v1/leases/${lease.id}/release`,
      {
        method: "POST",
        headers: agentHeaders(),
        body: JSON.stringify({ fencingToken: lease.fencingToken }),
      },
    );
    assert.equal(releaseResponse.status, 200);
    assert.equal(((await releaseResponse.json()) as BrowserLease).state, "closed");

    const metricsResponse = await fetch(`${admin}/metrics`, {
      headers: { authorization: "Bearer admin-test" },
    });
    assert.equal(metricsResponse.status, 200);
    const metrics = await metricsResponse.text();
    assert.match(metrics, /browsersilo_http_requests_total/);
    assert.match(metrics, /browsersilo_active_leases 0/);
    assert.match(metrics, /browsersilo_workers\{state="ready"\} 1/);
  } finally {
    await servers.close();
  }
});

function agentHeaders(): Record<string, string> {
  return {
    authorization: "Bearer agent-test-token-a",
    "content-type": "application/json",
  };
}
