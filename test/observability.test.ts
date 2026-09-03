import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeObservability } from "../src/observability/service.js";

test("request metrics preserve normalized routes containing parameter colons", () => {
  const telemetry = new RuntimeObservability();
  telemetry.start("POST", "/v1/leases/lease_abc-123/commands/agent_browser_click").finish(200);
  telemetry.start("GET", "/v1/artifacts/artifact_dead-beef/export").finish(503);

  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.requests, 2);
  assert.equal(snapshot.errors, 1);
  assert.equal(snapshot.spans[0]?.route, "/v1/artifacts/:id/export");
  assert.match(
    telemetry.prometheus(),
    /method="POST",route="\/v1\/leases\/:id\/commands\/:tool",status="200"} 1/,
  );
  assert.match(
    telemetry.prometheus(),
    /method="GET",route="\/v1\/artifacts\/:id\/export",status="503"} 1/,
  );
});
