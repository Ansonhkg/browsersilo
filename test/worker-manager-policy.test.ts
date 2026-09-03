import assert from "node:assert/strict";
import test from "node:test";
import { assertApprovedDockerArguments } from "../src/worker-manager/policy.js";

const policy = {
  workerImage: "browsersilo/brave-worker:0.4.0",
  dataVolume: "browsersilo-e2e-data",
};

test("worker manager accepts a constrained BrowserSilo worker", () => {
  assert.doesNotThrow(() => assertApprovedDockerArguments([
    "run", "-d",
    "--name", "browsesilo-worker-1",
    "--label", "browsesilo.managed=true",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges=true",
    "--security-opt", "seccomp=/app/container/brave-seccomp.json",
    "--network", "browsesilo-worker-1-net",
    "--mount", "type=volume,src=browsersilo-e2e-data,dst=/home/browser/.brave-profile,volume-subpath=runtime/worker-1/profile",
    policy.workerImage,
  ], policy));
});

test("worker manager rejects general Docker authority", () => {
  for (const args of [
    ["run", "--privileged", "alpine:latest"],
    ["run", "--privileged=true", policy.workerImage],
    ["run", "--name", "browsesilo-worker-1", "--label", "browsesilo.managed=true", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true", "--network", "host", policy.workerImage],
    ["run", "--name", "browsesilo-worker-1", "--label", "browsesilo.managed=true", "--cap-drop", "ALL", "--security-opt", "apparmor=unconfined", "--network", "browsesilo-worker-1-net", policy.workerImage],
    ["run", "--name", "browsesilo-worker-1", "--label", "browsesilo.managed=true", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true", "--network", "browsesilo-worker-1-net", "-v", "/:/host", policy.workerImage],
    ["exec", "browsesilo-worker-1", "bash"],
    ["rm", "-f", "postgres-production"],
    ["network", "ls"],
    ["volume", "rm", "browsersilo-e2e-data"],
  ]) {
    assert.throws(() => assertApprovedDockerArguments(args, policy), Error, args.join(" "));
  }
});

test("worker manager accepts only the private agent-browser stdio command", () => {
  assert.doesNotThrow(() => assertApprovedDockerArguments([
    "exec", "-i", "-u", "1000", "-e", "HOME=/tmp", "-e",
    "AGENT_BROWSER_ENABLE=react-devtools", "browsesilo-worker-1",
    "agent-browser", "mcp", "--tools", "all",
  ], policy, "input"));
  assert.doesNotThrow(() => assertApprovedDockerArguments([
    "exec", "browsesilo-worker-1", "install", "-d", "-m", "700", "-o", "1000", "-g", "1000",
    "/tmp/browsersilo-broker/12345678-1234-1234-1234-123456789abc",
  ], policy));
  assert.doesNotThrow(() => assertApprovedDockerArguments([
    "exec", "-i", "-u", "1000", "browsesilo-worker-1", "cat",
    "/tmp/browsersilo-broker/12345678-1234-1234-1234-123456789abc/file.pdf",
  ], policy, "output"));
});
