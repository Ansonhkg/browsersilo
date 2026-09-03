import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const execFileAsync = promisify(execFile);
const requiredEnvironment = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"] as const;
for (const name of requiredEnvironment) if (!process.env[name]) throw new Error(`${name} is required.`);

const runId = `e2e-${process.pid}-${Date.now()}`;
const project = `browsersilo-${runId}`;
const outputDirectory = resolve("outputs", runId);
const agentA = `e2e-agent-a-${randomBytes(12).toString("hex")}`;
const agentB = `e2e-agent-b-${randomBytes(12).toString("hex")}`;
const adminToken = `e2e-admin-${randomBytes(16).toString("hex")}`;
const managerToken = `e2e-manager-${randomBytes(16).toString("hex")}`;
const browserPort = await freePort();
const adminPort = await freePort();
const composeEnvironment = {
  ...stringEnvironment(),
  BROWSERSILO_RUN_ID: runId,
  BROWSERSILO_COMPOSE_PROJECT: project,
  BROWSERSILO_BROWSER_PORT: String(browserPort),
  BROWSERSILO_ADMIN_PORT: String(adminPort),
  BROWSERSILO_ADMIN_TOKEN: adminToken,
  BROWSERSILO_WORKER_MANAGER_TOKEN: managerToken,
  BROWSERSILO_DATA_KEY: randomBytes(32).toString("base64"),
  BROWSERSILO_PRINCIPALS_JSON: JSON.stringify([
    { token: agentA, tenantId: "e2e-tenant-a", principalId: "e2e-agent-a", kind: "agent" },
    { token: agentB, tenantId: "e2e-tenant-b", principalId: "e2e-agent-b", kind: "agent" },
  ]),
  BROWSERSILO_WARM_SHELLS: "2",
  BROWSERSILO_MAX_ACTIVE: "3",
  BROWSERSILO_MAX_ACTIVE_PER_TENANT: "2",
  BROWSERSILO_ADMISSION_TIMEOUT_MS: "2000",
};
const browserUrl = `http://127.0.0.1:${browserPort}`;
const adminUrl = `http://127.0.0.1:${adminPort}`;
const summary: Record<string, unknown> = {
  runId,
  status: "running",
  startedAt: new Date().toISOString(),
};
let primaryBrowserId: string | null = null;

await mkdir(outputDirectory, { recursive: true });
try {
  await compose(["up", "-d", "--no-build"]);
  await waitFor(`${browserUrl}/ready`, 90_000);
  await waitFor(`${adminUrl}/health`, 30_000);

  const [version, openapi, uiResponse] = await Promise.all([
    getJson(`${browserUrl}/version`),
    getJson(`${browserUrl}/openapi.json`),
    fetch(adminUrl),
  ]);
  const uiHtml = await uiResponse.text();
  assert(uiResponse.ok && uiHtml.includes('id="root"') && uiHtml.includes("/assets/"), "HeroUI control plane was not served.");
  assert((openapi as { openapi?: string }).openapi === "3.1.0", "OpenAPI 3.1 contract is missing.");
  summary["protocols"] = version;

  const opened = await api(agentA, "POST", "/v1/browsers", {
    identity: "daily-research",
    allowedDomains: ["wikipedia.org", "codeload.github.com"],
  }) as { id: string };
  primaryBrowserId = opened.id;

  const initialEvents = await readSse(opened.id, agentA);
  assert(initialEvents.text.includes("event: browser.ready"), "SSE did not replay browser.ready.");
  await api(agentA, "POST", `/v1/browsers/${opened.id}/captures`, {
    domain: "wikipedia.org", redactSecrets: true, includeTrace: true, includeVideo: true,
  });
  await api(agentA, "POST", `/v1/browsers/${opened.id}/actions:batch`, {
    actions: [
      { type: "navigate", url: "https://www.wikipedia.org/" },
      { type: "snapshot" },
      { type: "scroll", direction: "down", amount: 500 },
      { type: "tabs" },
    ],
  });
  const screenshot = await api(agentA, "POST", `/v1/browsers/${opened.id}/actions`, { type: "screenshot" }) as {
    result: { data: string };
  };
  const screenshotBytes = Buffer.from(screenshot.result.data, "base64");
  assertPng(screenshotBytes, "REST screenshot");
  await writeFile(resolve(outputDirectory, "real-site.png"), screenshotBytes);

  const replay = await readSse(opened.id, agentA, initialEvents.lastId);
  assert(replay.text.includes("event: action.completed"), "SSE resume did not replay new actions.");
  await verifyWebSocket(opened.id);

  await api(agentA, "POST", `/v1/browsers/${opened.id}/actions`, {
    type: "tool",
    name: "agent_browser_eval",
    arguments: {
      script: `(() => { localStorage.setItem('browsersilo-e2e', 'remembered-across-workers'); const a=document.createElement('a'); a.id='browsersilo-download'; a.href='https://codeload.github.com/github/gitignore/zip/refs/heads/main'; a.textContent='Download the real GitHub gitignore archive'; document.body.appendChild(a); return true; })()`,
    },
  });
  await api(agentA, "POST", `/v1/browsers/${opened.id}/actions`, {
    type: "tool", name: "agent_browser_download", arguments: { selector: "#browsersilo-download" },
  });
  await api(agentA, "POST", `/v1/browsers/${opened.id}/actions`, {
    type: "tool", name: "agent_browser_pdf", arguments: {},
  });
  const capture = await api(agentA, "POST", `/v1/browsers/${opened.id}/captures/current/stop`) as Record<string, unknown>;
  assert(capture["recordingArtifact"], "Domain Capture did not produce a video artifact.");

  const uploadBytes = randomBytes(1024 * 1024 + 37);
  const uploaded = await uploadArtifact(agentA, uploadBytes) as { id: string; sha256: string };
  const exportedUpload = await exportArtifact(agentA, uploaded.id);
  assert(createHash("sha256").update(exportedUpload).digest("hex") === uploaded.sha256, "Streaming artifact integrity failed.");

  const artifactsPayload = await api(agentA, "GET", `/v1/artifacts?leaseId=${encodeURIComponent(opened.id)}`) as {
    artifacts: Array<{ id: string; kind: string; name: string }>;
  };
  const inspectedKinds = await inspectArtifacts(artifactsPayload.artifacts);
  summary["artifacts"] = inspectedKinds;

  const beforeClose = await adminSnapshot();
  const firstWorker = activeWorkerFor(beforeClose, opened.id);
  await api(agentA, "DELETE", `/v1/browsers/${opened.id}`);
  primaryBrowserId = null;

  const resumed = await api(agentA, "POST", "/v1/browsers", {
    identity: "daily-research", allowedDomains: ["wikipedia.org"],
  }) as { id: string };
  await api(agentA, "POST", `/v1/browsers/${resumed.id}/actions`, { type: "navigate", url: "https://www.wikipedia.org/" });
  const remembered = await api(agentA, "POST", `/v1/browsers/${resumed.id}/actions`, {
    type: "tool", name: "agent_browser_eval", arguments: { script: "localStorage.getItem('browsersilo-e2e')" },
  });
  assert(JSON.stringify(remembered).includes("remembered-across-workers"), "Encrypted identity continuity failed.");
  const secondWorker = activeWorkerFor(await adminSnapshot(), resumed.id);
  assert(firstWorker !== secondWorker, "A used worker was reused for the durable identity.");
  await api(agentA, "DELETE", `/v1/browsers/${resumed.id}`);

  await verifyConcurrencyAndIsolation();
  await verifySecurityDenials();
  summary["llm"] = await runRealLlmOverRemoteMcp();
  summary["crashRecovery"] = await verifyCrashRecovery();

  const digests = await imageDigests();
  summary["images"] = digests;
  summary["status"] = "passed";
  summary["finishedAt"] = new Date().toISOString();
} catch (error) {
  summary["status"] = "failed";
  summary["failedAt"] = new Date().toISOString();
  summary["error"] = error instanceof Error ? error.message : String(error);
  if (primaryBrowserId) await api(agentA, "DELETE", `/v1/browsers/${primaryBrowserId}`).catch(() => undefined);
  throw error;
} finally {
  await writeDiagnostics();
  await compose(["down", "--volumes", "--remove-orphans"]).catch(() => undefined);
  const orphans = await auditOrphans();
  summary["zeroOrphans"] = orphans.containers === 0 && orphans.networks === 0;
  summary["orphans"] = orphans;
  await writeFile(resolve(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  if (!summary["zeroOrphans"] && summary["status"] === "passed") {
    throw new Error(`BrowserSilo left managed resources behind: ${JSON.stringify(orphans)}`);
  }
}

console.log(JSON.stringify(summary));
console.log(`BrowserSilo E2E PASS — evidence: ${outputDirectory}`);

async function verifyWebSocket(browserId: string): Promise<void> {
  const live = await api(agentA, "POST", `/v1/browsers/${browserId}/live-token`, { role: "takeover" }) as { token: string };
  const socket = new WebSocket(
    `ws://127.0.0.1:${browserPort}/v1/browsers/${browserId}/live?token=${encodeURIComponent(live.token)}`,
    "browsersilo.v1",
  );
  socket.binaryType = "arraybuffer";
  const messages: unknown[] = [];
  socket.addEventListener("message", (event) => messages.push(
    typeof event.data === "string" ? JSON.parse(event.data) : event.data,
  ));
  try {
    await until(() => messages.some((item) => messageType(item) === "browser.ready"));
    await until(() => messages.some((item) => item instanceof ArrayBuffer));
    socket.send(JSON.stringify({ type: "takeover.request" }));
    await until(() => messages.some((item) => messageType(item) === "takeover.started"));
    const paused = await rawApi(agentA, "POST", `/v1/browsers/${browserId}/actions`, { type: "snapshot" });
    assert(paused.status === 409 && (await paused.text()).includes("HUMAN_TAKEOVER_ACTIVE"), "Agent input was not paused during takeover.");
    socket.send(JSON.stringify({ type: "input.keyboard", key: "Tab" }));
    await until(() => messages.some((item) => messageType(item) === "input.accepted"));
    socket.send(JSON.stringify({ type: "takeover.release" }));
    await until(() => messages.some((item) => messageType(item) === "takeover.ended"));
    await api(agentA, "POST", `/v1/browsers/${browserId}/actions`, { type: "snapshot" });
  } finally {
    socket.close();
  }
}

async function verifyConcurrencyAndIsolation(): Promise<void> {
  const [a, b] = await Promise.all([
    api(agentA, "POST", "/v1/browsers", { identity: "tenant-a-concurrent", allowedDomains: ["wikipedia.org"] }),
    api(agentB, "POST", "/v1/browsers", { identity: "tenant-b-concurrent", allowedDomains: ["wikipedia.org"] }),
  ]) as [{ id: string }, { id: string }];
  const snapshot = await adminSnapshot();
  assert(activeWorkerFor(snapshot, a.id) !== activeWorkerFor(snapshot, b.id), "Concurrent tenants shared a worker.");
  const crossTenant = await rawApi(agentB, "GET", `/v1/browsers/${a.id}`);
  assert(new Set([403, 404]).has(crossTenant.status), "A tenant could read another tenant's browser.");
  await Promise.all([api(agentA, "DELETE", `/v1/browsers/${a.id}`), api(agentB, "DELETE", `/v1/browsers/${b.id}`)]);
}

async function verifySecurityDenials(): Promise<void> {
  const browser = await api(agentA, "POST", "/v1/browsers", { identity: "security-check", allowedDomains: ["wikipedia.org"] }) as { id: string };
  try {
    for (const url of ["http://127.0.0.1:4100/health", "http://169.254.169.254/latest/meta-data", "https://example.net/"]) {
      const response = await rawApi(agentA, "POST", `/v1/browsers/${browser.id}/actions`, { type: "navigate", url });
      assert(new Set([400, 403]).has(response.status), `Security policy allowed ${url}.`);
    }
  } finally {
    await api(agentA, "DELETE", `/v1/browsers/${browser.id}`);
  }
  const rejected = await fetch("http://127.0.0.1:9/internal/v1/docker/command").catch(() => null);
  assert(rejected === null, "Worker manager unexpectedly had a public port.");
}

async function runRealLlmOverRemoteMcp(): Promise<Record<string, unknown>> {
  const transport = new StreamableHTTPClientTransport(new URL(`${browserUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${agentA}` } },
  });
  const client = new Client({ name: "browsersilo-e2e", version: "0.4.0" });
  await client.connect(transport as unknown as Transport);
  try {
    const listed = await client.listTools();
    const selected = listed.tools.filter((tool) => new Set(["browser_open", "browser_act", "browser_close"]).has(tool.name));
    assert(selected.length === 3, "Remote MCP did not expose the human-oriented browser tools.");
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: "You operate a real private browser only through the supplied tools. Never invent website results. Always close the browser when done." },
      { role: "user", content: "Open the identity llm-daily-research with wikipedia.org allowed. Visit https://en.wikipedia.org/wiki/Brave_(web_browser), read a snapshot, scroll down once, list the tabs, close the browser, and reply exactly BROWSERSILO_REMOTE_MCP_OK." },
    ];
    const tools = selected.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description ?? tool.name, parameters: tool.inputSchema },
    }));
    const called: string[] = [];
    let finalText = "";
    for (let turn = 0; turn < 18; turn += 1) {
      const response = await fetch(chatCompletionsUrl(), {
        method: "POST",
        headers: { authorization: `Bearer ${process.env["OPENAI_API_KEY"]}`, "content-type": "application/json" },
        body: JSON.stringify({ model: process.env["OPENAI_MODEL"], messages, tools, tool_choice: "auto", temperature: 0, max_tokens: 1200, chat_template_kwargs: { enable_thinking: false } }),
        signal: AbortSignal.timeout(120_000),
      });
      const payload = await response.json() as Record<string, unknown>;
      assert(response.ok, `Real LLM returned HTTP ${response.status}.`);
      const assistant = ((payload["choices"] as Array<Record<string, unknown>>)?.[0]?.["message"] ?? null) as Record<string, unknown> | null;
      assert(assistant, "Real LLM returned no assistant message.");
      messages.push(assistant);
      const calls = assistant["tool_calls"] as Array<Record<string, unknown>> | undefined;
      if (!calls?.length) {
        finalText = String(assistant["content"] ?? "").trim();
        break;
      }
      for (const call of calls) {
        const fn = call["function"] as Record<string, unknown>;
        const name = String(fn["name"] ?? "");
        called.push(name);
        const result = await client.callTool({ name, arguments: JSON.parse(String(fn["arguments"] ?? "{}")) as Record<string, unknown> });
        messages.push({ role: "tool", tool_call_id: String(call["id"]), content: mcpText(result) });
      }
    }
    assert(["browser_open", "browser_act", "browser_close"].every((name) => called.includes(name)), `Real LLM missed required tools: ${called.join(", ")}`);
    assert(finalText === "BROWSERSILO_REMOTE_MCP_OK", `Unexpected real LLM result: ${finalText}`);
    return { model: process.env["OPENAI_MODEL"], result: finalText, toolCalls: called };
  } finally {
    await client.close();
  }
}

async function verifyCrashRecovery(): Promise<Record<string, unknown>> {
  const browser = await api(agentA, "POST", "/v1/browsers", { identity: "crash-recovery", allowedDomains: ["wikipedia.org"] }) as { id: string };
  await api(agentA, "POST", `/v1/browsers/${browser.id}/actions`, { type: "navigate", url: "https://www.wikipedia.org/" });
  const before = activeWorkerFor(await adminSnapshot(), browser.id);
  await compose(["kill", "control-plane"]);
  await compose(["up", "-d", "--no-build", "control-plane"]);
  await waitFor(`${browserUrl}/ready`, 90_000);
  const recovered = await api(agentA, "POST", "/v1/browsers", { identity: "crash-recovery", allowedDomains: ["wikipedia.org"] }) as { id: string };
  const after = activeWorkerFor(await adminSnapshot(), recovered.id);
  assert(before !== after, "Crash recovery reused an abandoned worker.");
  await api(agentA, "DELETE", `/v1/browsers/${recovered.id}`);
  return { recovered: true, abandonedWorkerDestroyed: before, replacementWorker: after };
}

async function inspectArtifacts(artifacts: Array<{ id: string; kind: string; name: string }>): Promise<string[]> {
  const required = ["download", "pdf", "har", "trace", "recording", "domain-capture", "screenshot"];
  for (const kind of required) {
    const artifact = artifacts.find((candidate) => candidate.kind === kind);
    assert(artifact, `No ${kind} artifact was produced.`);
    const bytes = await exportArtifact(agentA, artifact.id);
    assert(bytes.length > 8, `${kind} artifact is empty.`);
    if (kind === "download") assert(bytes.subarray(0, 2).toString() === "PK", "download is not the expected ZIP archive.");
    if (kind === "pdf") assert(bytes.subarray(0, 5).toString() === "%PDF-", "pdf artifact is not a PDF.");
    if (kind === "har") assert(JSON.parse(bytes.toString("utf8")).log, "HAR is invalid.");
    if (kind === "trace" && !bytes.subarray(0, 2).equals(Buffer.from("PK"))) JSON.parse(bytes.toString("utf8"));
    if (kind === "recording") assert(bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), "WebM signature is invalid.");
    if (kind === "domain-capture") assert(JSON.parse(bytes.toString("utf8")).schemaVersion === 2, "Domain Capture is invalid.");
    if (kind === "screenshot") assertPng(bytes, "capture screenshot");
    await writeFile(resolve(outputDirectory, `artifact-${kind}-${artifact.name.replace(/[^a-zA-Z0-9_.-]/g, "_")}`), bytes);
  }
  return required;
}

async function readSse(browserId: string, token: string, lastId?: string): Promise<{ text: string; lastId: string }> {
  const controller = new AbortController();
  const response = await fetch(`${browserUrl}/v1/browsers/${browserId}/events`, {
    headers: { authorization: `Bearer ${token}`, ...(lastId ? { "last-event-id": lastId } : {}) },
    signal: controller.signal,
  });
  assert(response.ok && response.body, `SSE returned HTTP ${response.status}.`);
  const reader = response.body.getReader();
  const chunk = await reader.read();
  controller.abort();
  await reader.cancel().catch(() => undefined);
  const text = new TextDecoder().decode(chunk.value);
  const ids = [...text.matchAll(/^id: (.+)$/gm)];
  assert(ids.length > 0, "SSE returned no event identifiers.");
  return { text, lastId: ids.at(-1)![1]! };
}

async function api(token: string, method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
  const response = await rawApi(token, method, path, body);
  const value = await response.json().catch(() => null) as unknown;
  assert(response.ok, `${method} ${path} returned ${response.status}: ${JSON.stringify(value)}`);
  return value;
}

function rawApi(token: string, method: string, path: string, body?: Record<string, unknown>): Promise<Response> {
  return fetch(`${browserUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(120_000),
  });
}

async function uploadArtifact(token: string, bytes: Buffer): Promise<unknown> {
  const response = await fetch(`${browserUrl}/v1/artifacts`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
      "x-browsersilo-artifact-kind": "upload",
      "x-browsersilo-artifact-name": "streaming-proof.bin",
    },
    body: Uint8Array.from(bytes),
  });
  assert(response.ok, `Artifact upload returned HTTP ${response.status}.`);
  return response.json();
}

async function exportArtifact(token: string, id: string): Promise<Buffer> {
  const response = await fetch(`${browserUrl}/v1/artifacts/${encodeURIComponent(id)}/export`, { headers: { authorization: `Bearer ${token}` } });
  assert(response.ok, `Artifact export returned HTTP ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}

async function adminSnapshot(): Promise<{ leases: Array<{ id: string; workerId: string }>; workers: Array<{ id: string; state: string }> }> {
  const response = await fetch(`${adminUrl}/admin/v1/snapshot`, { headers: { authorization: `Bearer ${adminToken}` } });
  assert(response.ok, `Admin snapshot returned HTTP ${response.status}.`);
  return response.json() as Promise<{ leases: Array<{ id: string; workerId: string }>; workers: Array<{ id: string; state: string }> }>;
}

function activeWorkerFor(snapshot: { leases: Array<{ id: string; workerId: string }> }, browserId: string): string {
  const worker = snapshot.leases.find((lease) => lease.id === browserId)?.workerId;
  assert(worker, `No worker was found for browser ${browserId}.`);
  return worker;
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  assert(response.ok, `${url} returned HTTP ${response.status}.`);
  return response.json();
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(url).catch(() => null);
    if (response?.ok) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

async function until(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for a realtime browser message.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

function messageType(value: unknown): string | undefined {
  return typeof value === "object" && value !== null ? String((value as Record<string, unknown>)["type"] ?? "") : undefined;
}

function assertPng(bytes: Buffer, name: string): void {
  assert(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${name} has an invalid PNG signature.`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function mcpText(result: unknown): string {
  if (!result || typeof result !== "object") return JSON.stringify(result);
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content.map((item) => item.type === "text" ? item.text ?? "" : `[${item.type}]`).join("\n").slice(0, 100_000);
}

function chatCompletionsUrl(): string {
  const base = process.env["OPENAI_BASE_URL"]!.replace(/\/$/, "");
  return `${base.endsWith("/v1") ? base : `${base}/v1`}/chat/completions`;
}

async function compose(args: string[]) {
  return execFileAsync("docker", ["compose", ...args], { cwd: process.cwd(), env: composeEnvironment, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

async function imageDigests(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const image of ["browsersilo/control-plane:0.4.0", "browsersilo/brave-worker:0.4.0"]) {
    const value = await execFileAsync("docker", ["image", "inspect", image, "--format", "{{.Id}}"], { encoding: "utf8" });
    result[image] = value.stdout.trim();
  }
  return result;
}

async function auditOrphans(): Promise<{ containers: number; networks: number }> {
  const [containers, networks] = await Promise.all([
    execFileAsync("docker", ["ps", "-aq", "--filter", "label=browsesilo.managed=true", "--filter", `label=browsesilo.scope=${runId}`], { encoding: "utf8" }),
    execFileAsync("docker", ["network", "ls", "-q", "--filter", "label=browsesilo.managed=true", "--filter", `label=browsesilo.scope=${runId}`], { encoding: "utf8" }),
  ]);
  return {
    containers: containers.stdout.split("\n").filter(Boolean).length,
    networks: networks.stdout.split("\n").filter(Boolean).length,
  };
}

async function writeDiagnostics(): Promise<void> {
  const logs = await compose(["logs", "--no-color", "--tail", "500"]).then((value) => value.stdout, (error: unknown) => error instanceof Error ? error.message : String(error));
  await writeFile(resolve(outputDirectory, "compose.log"), logs);
  await writeFile(resolve(outputDirectory, "summary.partial.json"), `${JSON.stringify(summary, null, 2)}\n`);
}

function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePromise(port));
    });
  });
}
