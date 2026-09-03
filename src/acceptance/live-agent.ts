import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const requiredEnvironment = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
] as const;
for (const name of requiredEnvironment) {
  if (!process.env[name]) throw new Error(`${name} is required through envars.`);
}

const proofPath = resolve(
  process.env["BROWSERSILO_PROOF_PATH"] ??
    ".data/proofs/browsersilo-live-llm.png",
);
const continuityProofPath = proofPath.replace(/\.png$/, "-continuity.png");
await mkdir(dirname(proofPath), { recursive: true });

const browserPort = await freePort();
const adminPort = await freePort();
let service = startBrowserSilo(browserPort, adminPort);
let serviceOutput = "";
attachServiceOutput(service);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/src/mcp/index.js"],
  cwd: process.cwd(),
  env: {
    ...stringEnvironment(),
    BROWSERSILO_API_URL: `http://127.0.0.1:${browserPort}`,
    BROWSERSILO_AGENT_TOKEN: "live-agent-token",
  },
  stderr: "pipe",
});
const client = new Client({ name: "browsesilo-live-acceptance", version: "0.3.0" });
let primaryFailure = false;

try {
  await waitForHealth(browserPort, service, () => serviceOutput);
  await client.connect(transport);
  const tools = await listEveryTool(client);
  if (tools.length !== 145) {
    throw new Error(`Expected 145 BrowserSilo MCP tools, found ${tools.length}.`);
  }
  const toolNames = new Set(tools.map((tool) => tool.name));
  for (const required of [
    "browser_profile_create",
    "browser_lease_acquire",
    "browser_navigate",
    "browser_snapshot",
    "browser_screenshot",
    "browser_click",
    "browser_type",
    "browser_lease_release",
    "agent_browser_snapshot",
  ]) {
    if (!toolNames.has(required)) throw new Error(`MCP tool ${required} is missing.`);
  }

  const continuity = await proveProfileContinuity(
    client,
    continuityProofPath,
  );
  const parity = await proveParityAndArtifacts(client, browserPort);
  const liveLlm = await runLlmAgent(
    client,
    tools.filter((tool) => tool.name.startsWith("browser_")),
    proofPath,
  );
  const crashRecovery = await proveCrashRecovery(client);

  const containers = await managedContainers();
  const unexpected = containers.filter(
    (container) => container.role !== "warm" || container.status !== "created",
  );
  if (unexpected.length > 0) {
    throw new Error(`Used BrowserSilo containers remain: ${JSON.stringify(unexpected)}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        mcpTools: tools.length,
        continuity,
        parity,
        liveLlm,
        crashRecovery,
        proofPath,
        continuityProofPath,
        cleanWarmContainers: containers.length,
      },
      null,
      2,
    ),
  );
} catch (error) {
  primaryFailure = true;
  if (serviceOutput.trim()) console.error(`BrowserSilo service output:\n${serviceOutput}`);
  throw error;
} finally {
  await client.close().catch(() => undefined);
  await stopChild(service);
  const remaining = await managedContainers();
  if (remaining.length > 0) {
    const message = `BrowserSilo shutdown left managed containers: ${JSON.stringify(remaining)}`;
    if (!primaryFailure) throw new Error(message);
    console.error(message);
  }
}

function attachServiceOutput(child: ChildProcess): void {
  child.stdout?.on("data", (chunk: Buffer) => {
    serviceOutput = `${serviceOutput}${chunk.toString("utf8")}`.slice(-8_000);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    serviceOutput = `${serviceOutput}${chunk.toString("utf8")}`.slice(-8_000);
  });
}

async function proveProfileContinuity(
  client: Client,
  screenshotPath: string,
): Promise<Record<string, unknown>> {
  const profile = await callJson(client, "browser_profile_create", {
    name: "Encrypted continuity proof",
  });
  const profileId = requiredString(profile, "id");
  const firstLease = await callJson(client, "browser_lease_acquire", {
    profileId,
    ttlSeconds: 600,
    idempotencyKey: `continuity-first-${Date.now()}`,
    allowedDomains: ["example.com"],
  });
  const firstLeaseId = requiredString(firstLease, "id");
  const firstFence = requiredNumber(firstLease, "fencingToken");
  const firstWorkerId = requiredString(firstLease, "workerId");
  const fixtureUrl = "https://example.com/";
  await callJson(client, "browser_navigate", {
    leaseId: firstLeaseId,
    fencingToken: firstFence,
    url: fixtureUrl,
  });
  await injectProofPage(client, firstLeaseId, firstFence);
  const paritySnapshot = await client.callTool({
    name: "agent_browser_snapshot",
    arguments: {
      leaseId: firstLeaseId,
      fencingToken: firstFence,
      interactive: true,
    },
  });
  const parityText = mcpResultForModel(paritySnapshot);
  if (!parityText.includes("[ref=e")) {
    throw new Error(
      `The fenced agent-browser parity tool returned no stable refs: ${parityText.slice(0, 800)}`,
    );
  }
  const initialSnapshot = await callJson(client, "browser_snapshot", {
    leaseId: firstLeaseId,
    fencingToken: firstFence,
  });
  if (!JSON.stringify(initialSnapshot).includes("Agent note")) {
    throw new Error(
      `MCP snapshot did not expose the fixture input. Native: ${JSON.stringify(initialSnapshot).slice(0, 1_000)} Upstream: ${JSON.stringify(paritySnapshot).slice(0, 2_000)}`,
    );
  }
  await callJson(client, "browser_type", {
    leaseId: firstLeaseId,
    fencingToken: firstFence,
    selector: "#note",
    text: "Persisted across disposable workers",
  });
  await callJson(client, "browser_click", {
    leaseId: firstLeaseId,
    fencingToken: firstFence,
    selector: "#save",
  });
  const persistedState = await callJson(client, "browser_evaluate", {
    leaseId: firstLeaseId,
    fencingToken: firstFence,
    expression: "() => ({ note: document.querySelector('#note')?.value, saved: document.querySelector('#saved')?.textContent, storage: localStorage.getItem('browsersilo-note') })",
  });
  const saved = await callJson(client, "browser_snapshot", {
    leaseId: firstLeaseId,
    fencingToken: firstFence,
  });
  if (!JSON.stringify(saved).includes("Persisted across disposable workers")) {
    throw new Error(
      `The fixture did not save the value before worker release. State: ${JSON.stringify(persistedState)} Snapshot: ${JSON.stringify(saved).slice(0, 3_000)}`,
    );
  }
  await callJson(client, "browser_lease_release", {
    leaseId: firstLeaseId,
    fencingToken: firstFence,
  });

  const secondLease = await callJson(client, "browser_lease_acquire", {
    profileId,
    ttlSeconds: 600,
    idempotencyKey: `continuity-second-${Date.now()}`,
    allowedDomains: ["example.com"],
  });
  const secondLeaseId = requiredString(secondLease, "id");
  const secondFence = requiredNumber(secondLease, "fencingToken");
  const secondWorkerId = requiredString(secondLease, "workerId");
  if (firstWorkerId === secondWorkerId) {
    throw new Error("Profile continuity reused the previous worker.");
  }
  await callJson(client, "browser_navigate", {
    leaseId: secondLeaseId,
    fencingToken: secondFence,
    url: fixtureUrl,
  });
  await injectProofPage(client, secondLeaseId, secondFence);
  const restored = await callJson(client, "browser_snapshot", {
    leaseId: secondLeaseId,
    fencingToken: secondFence,
  });
  if (!JSON.stringify(restored).includes("Persisted across disposable workers")) {
    throw new Error("The encrypted browser profile did not restore localStorage.");
  }
  await saveMcpScreenshot(
    await client.callTool({
      name: "browser_screenshot",
      arguments: { leaseId: secondLeaseId, fencingToken: secondFence },
    }),
    screenshotPath,
  );
  await callJson(client, "browser_lease_release", {
    leaseId: secondLeaseId,
    fencingToken: secondFence,
  });
  return {
    profileId,
    firstWorkerId,
    secondWorkerId,
    restored: true,
  };
}

async function proveParityAndArtifacts(
  client: Client,
  browserPort: number,
): Promise<Record<string, unknown>> {
  const profile = await callJson(client, "browser_profile_create", {
    name: "Parity and artifact proof",
  });
  const lease = await callJson(client, "browser_lease_acquire", {
    profileId: requiredString(profile, "id"),
    ttlSeconds: 900,
    idempotencyKey: `parity-${Date.now()}`,
    allowedDomains: ["example.com", "react.dev"],
  });
  const leaseId = requiredString(lease, "id");
  const fencingToken = requiredNumber(lease, "fencingToken");
  const workerId = requiredString(lease, "workerId");
  const fenced = { leaseId, fencingToken };
  const called: string[] = [];
  const parity = async (name: string, input: Record<string, unknown> = {}) => {
    called.push(name);
    return callToolText(client, name, { ...fenced, ...input });
  };

  try {
    const isolation = await inspectWorkerIsolation(workerId);
    const concurrency = await proveRealConcurrency(client, workerId);
    await expectToolError(client, "browser_navigate", {
      ...fenced,
      url: "http://127.0.0.1/hostile-private-network-proof",
    }, "denied by this lease's egress policy");
    await expectToolError(client, "browser_navigate", {
      ...fenced,
      url: "https://not-allowed.invalid/",
    }, "denied by this lease's egress policy");
    await callJson(client, "browser_navigate", {
      ...fenced,
      url: "https://example.com/",
    });
    await callJson(client, "browser_evaluate", {
      ...fenced,
      expression: `() => {
        document.body.innerHTML = \`<main style="min-height:1800px">
          <h1 id="title" data-proof="yes">BrowserSilo parity proof</h1>
          <label>Text <input id="text" value="ready"></label>
          <label>Check <input id="check" type="checkbox"></label>
          <label>Choice <select id="choice"><option value="one">One</option><option value="two">Two</option></select></label>
          <button id="double">Double</button><p id="double-result"></p>
          <div id="source" draggable="true">Drag source</div><div id="target">Drop target</div>
          <input id="file" type="file"><p id="file-result"></p>
          <button id="dialog">Dialog</button>
          <a id="download" download="proof.txt" href="data:text/plain,browsersilo-download-proof">Download</a>
          <iframe id="frame" srcdoc="<p id='inside'>Frame proof</p>"></iframe>
          <div id="bottom" style="margin-top:1200px">Bottom</div>
        </main>\`;
        document.querySelector('#double').ondblclick = () => document.querySelector('#double-result').textContent = 'double-clicked';
        document.querySelector('#target').ondragover = event => event.preventDefault();
        document.querySelector('#target').ondrop = event => { event.preventDefault(); event.currentTarget.textContent = 'dropped'; };
        document.querySelector('#file').onchange = event => document.querySelector('#file-result').textContent = event.target.files[0]?.name || '';
        document.querySelector('#dialog').onclick = () => alert('BrowserSilo dialog proof');
        return true;
      }`,
    });

    const snapshot = await parity("agent_browser_snapshot", { interactive: true });
    if (!snapshot.includes("[ref=e")) throw new Error("Parity snapshot returned no stable refs.");
    for (const [name, input] of [
      ["agent_browser_get_text", { selector: "#title" }],
      ["agent_browser_get_html", { selector: "main" }],
      ["agent_browser_get_value", { selector: "#text" }],
      ["agent_browser_get_attr", { selector: "#title", name: "data-proof" }],
      ["agent_browser_get_styles", { selector: "#title" }],
      ["agent_browser_is_visible", { selector: "#title" }],
      ["agent_browser_is_enabled", { selector: "#text" }],
      ["agent_browser_focus", { selector: "#text" }],
      ["agent_browser_hover", { selector: "#double" }],
      ["agent_browser_dblclick", { selector: "#double" }],
      ["agent_browser_select", { selector: "#choice", values: ["two"] }],
      ["agent_browser_check", { selector: "#check" }],
      ["agent_browser_is_checked", { selector: "#check" }],
      ["agent_browser_scroll_into_view", { selector: "#bottom" }],
      ["agent_browser_scroll", { direction: "up", amount: 200 }],
      ["agent_browser_mouse_move", { x: 20, y: 20 }],
      ["agent_browser_mouse_down", { button: "left" }],
      ["agent_browser_mouse_up", { button: "left" }],
      ["agent_browser_mouse_wheel", { dy: 100 }],
      ["agent_browser_drag", { source: "#source", target: "#target" }],
      ["agent_browser_wait_for_selector", { selector: "#title", waitTimeoutMs: 5_000 }],
      ["agent_browser_wait_for_text", { text: "BrowserSilo parity proof", waitTimeoutMs: 5_000 }],
      ["agent_browser_wait_for_url", { url: "**/", waitTimeoutMs: 5_000 }],
      ["agent_browser_wait_for_load", { state: "domcontentloaded", waitTimeoutMs: 5_000 }],
      ["agent_browser_wait_for_function", { expression: "document.querySelector('#title') !== null", waitTimeoutMs: 5_000 }],
    ] as const) {
      await parity(name, input);
    }

    await parity("agent_browser_press", { key: "Tab" });
    await parity("agent_browser_set_viewport", { width: 1024, height: 720 });
    await parity("agent_browser_set_device", { device: "iPhone 14" });
    await parity("agent_browser_set_geo", { latitude: 51.5072, longitude: -0.1276 });
    await parity("agent_browser_set_headers", { headers: { "x-browsersilo-proof": "yes" } });
    await parity("agent_browser_set_credentials", { username: "proof", password: "proof" });
    await parity("agent_browser_set_media", { colorScheme: "dark", reducedMotion: "reduce" });
    await parity("agent_browser_set_offline", { enabled: true });
    await parity("agent_browser_set_offline", { enabled: false });

    await parity("agent_browser_storage_set", {
      storageType: "session", key: "parity", value: "stored",
    });
    const storage = await parity("agent_browser_storage_get", {
      storageType: "session", key: "parity",
    });
    if (!storage.includes("stored")) throw new Error("Session storage parity failed.");
    await parity("agent_browser_cookies_set", {
      name: "browsersilo-proof", value: "cookie", url: "https://example.com/",
    });
    const cookies = await parity("agent_browser_cookies_get");
    if (!cookies.includes("browsersilo-proof")) throw new Error("Cookie parity failed.");

    await parity("agent_browser_network_route", {
      url: "https://example.com/browsersilo-mock", body: "mocked-by-browsersilo",
    });
    const mocked = await callJson(client, "browser_evaluate", {
      ...fenced,
      expression: "async () => await (await fetch('/browsersilo-mock')).text()",
    });
    if (!JSON.stringify(mocked).includes("mocked-by-browsersilo")) {
      throw new Error("Network response mocking parity failed.");
    }
    await parity("agent_browser_network_requests", { filter: "browsersilo-mock" });
    await parity("agent_browser_network_unroute", { url: "https://example.com/browsersilo-mock" });

    await parity("agent_browser_tab_new", { label: "proof-tab", url: "https://example.com/" });
    const tabs = await parity("agent_browser_tab_list");
    if (!tabs.includes("proof-tab") && !tabs.includes("example.com")) {
      throw new Error("Tab list parity did not report the new tab.");
    }
    await parity("agent_browser_tab_switch", { tab: "proof-tab" });
    await parity("agent_browser_tab_close", { tab: "proof-tab" });
    await parity("agent_browser_window_new");
    await parity("agent_browser_tab_close");
    await parity("agent_browser_frame_switch", { frame: "#frame" });
    const frameText = await parity("agent_browser_get_text", { selector: "#inside" });
    if (!frameText.includes("Frame proof")) throw new Error("Frame parity failed.");
    await parity("agent_browser_frame_main");
    await parity("agent_browser_click", { selector: "#double" });
    await callJson(client, "browser_evaluate", {
      ...fenced,
      expression: "() => { setTimeout(() => confirm('BrowserSilo dialog proof'), 250); return true; }",
    });
    await delay(500);
    await parity("agent_browser_dialog_status");
    await parity("agent_browser_dialog_accept");
    await callJson(client, "browser_evaluate", {
      ...fenced,
      expression: "() => { history.pushState({}, '', '/proof-history'); return location.href; }",
    });
    await parity("agent_browser_back");
    await parity("agent_browser_forward");

    const uploaded = await callJson(client, "browser_artifact_upload", {
      name: "upload-proof.txt",
      mimeType: "text/plain",
      kind: "upload",
      dataBase64: Buffer.from("BrowserSilo upload proof").toString("base64"),
    });
    await parity("agent_browser_upload", {
      selector: "#file", artifactIds: [requiredString(uploaded, "id")],
    });
    const fileResult = await parity("agent_browser_get_text", { selector: "#file-result" });
    if (!fileResult.includes("upload-proof.txt")) throw new Error("Upload broker parity failed.");
    await parity("agent_browser_clipboard_write", { text: "BrowserSilo clipboard proof" });
    const clipboard = await parity("agent_browser_clipboard_read");
    if (!clipboard.includes("BrowserSilo clipboard proof")) throw new Error("Clipboard parity failed.");
    await parity("agent_browser_download", { selector: "#download" });
    await callJson(client, "browser_evaluate", {
      ...fenced,
      expression: "() => { setTimeout(() => document.querySelector('#download').click(), 2_000); return true; }",
    });
    await parity("agent_browser_wait_for_download", { waitTimeoutMs: 5_000 });

    await parity("agent_browser_network_har_start");
    await parity("agent_browser_reload");
    await parity("agent_browser_network_har_stop");
    await parity("agent_browser_trace_start");
    await parity("agent_browser_reload");
    await parity("agent_browser_trace_stop");
    await parity("agent_browser_profiler_start");
    await parity("agent_browser_wait_ms", { ms: 250 });
    await parity("agent_browser_profiler_stop");
    await parity("agent_browser_pdf");
    await parity("agent_browser_state_save");
    await parity("agent_browser_diff_snapshot", { compact: true });
    const baselineScreenshot = await client.callTool({
      name: "browser_screenshot",
      arguments: fenced,
    });
    const baselineArtifact = await callJson(client, "browser_artifact_upload", {
      name: "diff-baseline.png",
      mimeType: "image/png",
      kind: "other",
      dataBase64: mcpScreenshotData(baselineScreenshot),
    });
    await callJson(client, "browser_evaluate", {
      ...fenced,
      expression: "() => { const marker = document.createElement('div'); marker.textContent = 'Visual diff proof'; marker.style.cssText = 'position:fixed;inset:20px auto auto 20px;padding:20px;background:#ff0055;color:white;z-index:2147483647'; document.body.appendChild(marker); return true; }",
    });
    await parity("agent_browser_diff_screenshot", {
      baselineArtifactId: requiredString(baselineArtifact, "id"),
      fullPage: false,
    });
    await parity("agent_browser_batch", {
      commands: [["get", "title"], ["get", "url"]], bail: true,
    });

    const captureStarted = await callJson(client, "browser_domain_capture_start", {
      ...fenced,
      domain: "example.com",
      redactSecrets: true,
      includeTrace: true,
      includeVideo: true,
    });
    if (captureStarted["active"] !== true) throw new Error("Domain Capture did not start.");
    await callJson(client, "browser_evaluate", {
      ...fenced,
      expression: "() => { let frame = 0; const timer = setInterval(() => { document.body.style.backgroundColor = frame++ % 2 ? '#ffffff' : '#eef2ff'; }, 100); setTimeout(() => clearInterval(timer), 1_800); fetch('/?browsersilo-domain-capture=1').catch(() => undefined); return true; }",
    });
    await parity("agent_browser_wait_ms", { ms: 2_000 });
    const capture = await callJson(client, "browser_domain_capture_stop", fenced);
    if (!capture["artifact"] || !capture["harArtifact"] || !capture["traceArtifact"] || !capture["recordingArtifact"]) {
      throw new Error("Domain Capture did not seal every requested artifact.");
    }

    await proveLiveStream(browserPort, leaseId, fencingToken);
    const artifacts = await callJson(client, "browser_artifact_list", {});
    const artifactList = Array.isArray(artifacts["artifacts"])
      ? artifacts["artifacts"] as Array<Record<string, unknown>>
      : [];
    for (const kind of ["upload", "download", "pdf", "har", "trace", "recording", "state", "diff", "domain-capture", "screenshot"]) {
      if (!artifactList.some((artifact) => artifact["kind"] === kind)) {
        throw new Error(`Live acceptance produced no ${kind} artifact.`);
      }
    }
    await inspectArtifacts(browserPort, artifactList);

    await callJson(client, "browser_navigate", { ...fenced, url: "https://react.dev/" });
    await parity("agent_browser_wait_for_load", { state: "domcontentloaded", waitTimeoutMs: 30_000 });
    await parity("agent_browser_react_tree", { json: true });
    await parity("agent_browser_vitals", { json: true });

    return {
      profileId: profile["id"],
      workerId: lease["workerId"],
      parityCalls: called.length,
      artifactKinds: [...new Set(artifactList.map((artifact) => artifact["kind"]))].sort(),
      stream: "multipart PNG verified",
      isolation,
      concurrency,
    };
  } finally {
    await callJson(client, "browser_lease_release", fenced);
  }
}

async function proveCrashRecovery(client: Client): Promise<Record<string, unknown>> {
  const profile = await callJson(client, "browser_profile_create", {
    name: "Crash recovery proof",
  });
  const profileId = requiredString(profile, "id");
  const before = await callJson(client, "browser_lease_acquire", {
    profileId,
    ttlSeconds: 600,
    idempotencyKey: `crash-before-${Date.now()}`,
    allowedDomains: ["example.com"],
  });
  const beforeFence = requiredNumber(before, "fencingToken");
  await callJson(client, "browser_navigate", {
    leaseId: requiredString(before, "id"),
    fencingToken: beforeFence,
    url: "https://example.com/",
  });
  await callJson(client, "browser_evaluate", {
    leaseId: requiredString(before, "id"),
    fencingToken: beforeFence,
    expression: "() => { localStorage.setItem('browsersilo-crash-proof', 'recovered'); return true; }",
  });

  await stopChildHard(service);
  serviceOutput = "";
  service = startBrowserSilo(browserPort, adminPort);
  attachServiceOutput(service);
  await waitForHealth(browserPort, service, () => serviceOutput);

  const after = await callJson(client, "browser_lease_acquire", {
    profileId,
    ttlSeconds: 600,
    idempotencyKey: `crash-after-${Date.now()}`,
    allowedDomains: ["example.com"],
  });
  if (before["workerId"] === after["workerId"]) {
    throw new Error("Crash recovery reused the orphaned worker.");
  }
  const afterFence = requiredNumber(after, "fencingToken");
  await callJson(client, "browser_navigate", {
    leaseId: requiredString(after, "id"),
    fencingToken: afterFence,
    url: "https://example.com/",
  });
  const restored = await callJson(client, "browser_evaluate", {
    leaseId: requiredString(after, "id"),
    fencingToken: afterFence,
    expression: "() => localStorage.getItem('browsersilo-crash-proof')",
  });
  if (!JSON.stringify(restored).includes("recovered")) {
    throw new Error("Crash recovery did not commit and restore the orphaned profile.");
  }
  await callJson(client, "browser_lease_release", {
    leaseId: requiredString(after, "id"),
    fencingToken: afterFence,
  });
  return {
    profileId,
    orphanedWorkerId: before["workerId"],
    replacementWorkerId: after["workerId"],
    restored: true,
  };
}

async function proveRealConcurrency(
  client: Client,
  firstWorkerId: string,
): Promise<Record<string, unknown>> {
  const secondProfile = await callJson(client, "browser_profile_create", {
    name: "Concurrent worker proof",
  });
  const secondLease = await callJson(client, "browser_lease_acquire", {
    profileId: requiredString(secondProfile, "id"),
    ttlSeconds: 300,
    idempotencyKey: `concurrency-second-${Date.now()}`,
    allowedDomains: ["example.com"],
  });
  const secondWorkerId = requiredString(secondLease, "workerId");
  if (secondWorkerId === firstWorkerId) {
    throw new Error("Concurrent leases were assigned the same worker.");
  }
  const thirdProfile = await callJson(client, "browser_profile_create", {
    name: "Capacity rejection proof",
  });
  try {
    await expectToolError(client, "browser_lease_acquire", {
      profileId: requiredString(thirdProfile, "id"),
      ttlSeconds: 300,
      idempotencyKey: `concurrency-third-${Date.now()}`,
      allowedDomains: ["example.com"],
    }, "quota");
  } finally {
    await callJson(client, "browser_lease_release", {
      leaseId: requiredString(secondLease, "id"),
      fencingToken: requiredNumber(secondLease, "fencingToken"),
    });
  }
  return {
    simultaneousWorkers: 2,
    firstWorkerId,
    secondWorkerId,
    thirdLeaseRejected: true,
  };
}

async function inspectWorkerIsolation(workerId: string): Promise<Record<string, unknown>> {
  const ids = await execFileAsync(
    "docker",
    [
      "ps", "-aq",
      "--filter", `label=browsesilo.worker-id=${workerId}`,
      "--filter", "label=browsesilo.role=worker",
    ],
    { encoding: "utf8" },
  );
  const containerId = ids.stdout.trim().split("\n").filter(Boolean)[0];
  if (!containerId) throw new Error(`No Docker worker exists for ${workerId}.`);
  const inspected = JSON.parse(
    (await execFileAsync("docker", ["inspect", containerId], { encoding: "utf8" })).stdout,
  ) as Array<Record<string, unknown>>;
  const container = inspected[0];
  if (!container) throw new Error("Docker inspect returned no worker.");
  const config = recordValue(container["Config"]);
  const host = recordValue(container["HostConfig"]);
  const portBindings = recordValue(host["PortBindings"]);
  const capDrop = Array.isArray(host["CapDrop"]) ? host["CapDrop"].map(String) : [];
  const securityOptions = Array.isArray(host["SecurityOpt"])
    ? host["SecurityOpt"].map(String)
    : [];
  const processList = (
    await execFileAsync("docker", ["top", containerId, "-eo", "pid,args"], { encoding: "utf8" })
  ).stdout;
  const checks = {
    nonRoot: new Set(["browser", "1000", "1000:1000"]).has(String(config["User"] ?? "")),
    readOnlyRoot: host["ReadonlyRootfs"] === true,
    capabilitiesDropped: capDrop.includes("ALL"),
    noNewPrivileges: securityOptions.some((value) => value.includes("no-new-privileges")),
    customSeccomp: securityOptions.some((value) => value.startsWith("seccomp=")),
    noHostPorts: Object.keys(portBindings).length === 0,
    chromiumSandboxEnabled: processList.includes("brave") && !processList.includes("--no-sandbox"),
  };
  if (Object.values(checks).some((value) => !value)) {
    throw new Error(`Worker isolation inspection failed: ${JSON.stringify(checks)}`);
  }
  return checks;
}

async function expectToolError(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  expectedText: string,
): Promise<void> {
  const result = await client.callTool({ name, arguments: args });
  const text = mcpResultForModel(result);
  if (!result.isError || !text.toLowerCase().includes(expectedText.toLowerCase())) {
    throw new Error(`${name} did not fail with ${expectedText}: ${text.slice(0, 1_000)}`);
  }
}

async function runLlmAgent(
  client: Client,
  tools: Array<{
    name: string;
    description?: string | undefined;
    inputSchema: object;
  }>,
  screenshotPath: string,
): Promise<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [
    {
      role: "system",
      content:
        "You are a browser acceptance agent. Use BrowserSilo tools for every browser action. Never invent results. Always release the lease before completing.",
    },
    {
      role: "user",
      content: `Prove that you can operate a real private browser. Create a new profile. Acquire it with allowedDomains set to ["example.com"]. Navigate to https://example.com/. Use browser_evaluate with this exact JavaScript expression: () => { document.body.innerHTML = '<main><h1>BrowserSilo Live Agent Proof</h1><label for="note">Agent note</label><input id="note"><button id="save">Save</button><p id="saved" role="status"></p></main>'; document.querySelector('#save').onclick = () => { document.querySelector('#saved').textContent = document.querySelector('#note').value; }; return true; }. Inspect the snapshot, type exactly "Driven by a real LLM through MCP" into #note, click #save, inspect another snapshot to verify the text, capture a screenshot, release the lease, and then reply exactly BROWSERSILO_AGENT_OK.`,
    },
  ];
  const openAiTools = tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? tool.name,
      parameters: tool.inputSchema,
    },
  }));
  const called: string[] = [];
  let finalText = "";
  let screenshotSaved = false;

  for (let turn = 0; turn < 24; turn += 1) {
    const response = await fetch(chatCompletionsUrl(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env["OPENAI_API_KEY"]}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: process.env["OPENAI_MODEL"],
        messages,
        tools: openAiTools,
        tool_choice: "auto",
        temperature: 0,
        max_tokens: 1_500,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(`Live LLM request failed with HTTP ${response.status}.`);
    }
    const choices = payload["choices"];
    if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") {
      throw new Error("Live LLM response contained no choice.");
    }
    const message = (choices[0] as Record<string, unknown>)["message"];
    if (!message || typeof message !== "object") {
      throw new Error("Live LLM response contained no assistant message.");
    }
    const assistant = message as Record<string, unknown>;
    messages.push(assistant);
    const toolCalls = assistant["tool_calls"];
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      finalText = typeof assistant["content"] === "string" ? assistant["content"] : "";
      break;
    }

    for (const rawCall of toolCalls) {
      if (!rawCall || typeof rawCall !== "object") continue;
      const call = rawCall as Record<string, unknown>;
      const fn = call["function"] as Record<string, unknown> | undefined;
      const name = typeof fn?.["name"] === "string" ? fn["name"] : "";
      const callId = typeof call["id"] === "string" ? call["id"] : "";
      const rawArguments =
        typeof fn?.["arguments"] === "string" ? fn["arguments"] : "{}";
      const args = JSON.parse(rawArguments) as Record<string, unknown>;
      called.push(name);
      const result = await client.callTool({ name, arguments: args });
      if (name === "browser_screenshot") {
        await saveMcpScreenshot(result, screenshotPath);
        screenshotSaved = true;
      }
      messages.push({
        role: "tool",
        tool_call_id: callId,
        content: mcpResultForModel(result),
      });
    }
  }

  for (const required of [
    "browser_profile_create",
    "browser_lease_acquire",
    "browser_navigate",
    "browser_evaluate",
    "browser_snapshot",
    "browser_type",
    "browser_click",
    "browser_screenshot",
    "browser_lease_release",
  ]) {
    if (!called.includes(required)) {
      throw new Error(`The real LLM did not call required MCP tool ${required}.`);
    }
  }
  if (!screenshotSaved) throw new Error("The real LLM did not produce a screenshot.");
  if (finalText.trim() !== "BROWSERSILO_AGENT_OK") {
    throw new Error(`The real LLM returned an unexpected final response: ${finalText}`);
  }
  return {
    model: process.env["OPENAI_MODEL"],
    finalText: finalText.trim(),
    toolCalls: called,
  };
}

async function injectProofPage(
  client: Client,
  leaseId: string,
  fencingToken: number,
): Promise<void> {
  await callJson(client, "browser_evaluate", {
    leaseId,
    fencingToken,
    expression: `() => {
      document.body.innerHTML = '<main><h1>BrowserSilo Live Agent Proof</h1><label for="note">Agent note</label><input id="note"><button id="save">Save</button><p id="saved" role="status"></p></main>';
      const note = document.querySelector('#note');
      const saved = document.querySelector('#saved');
      note.value = localStorage.getItem('browsersilo-note') || '';
      saved.textContent = note.value;
      document.querySelector('#save').onclick = () => {
        localStorage.setItem('browsersilo-note', note.value);
        saved.textContent = note.value;
      };
      return true;
    }`,
  });
}

async function managedContainers(): Promise<Array<{ name: string; status: string; role: string }>> {
  const containers = await execFileAsync(
    "docker",
    [
      "ps", "-a",
      "--filter", "label=browsesilo.managed=true",
      "--format", "{{.Names}}|{{.State}}|{{.Label \"browsesilo.role\"}}",
    ],
    { encoding: "utf8" },
  );
  return containers.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [name = "", status = "", role = ""] = line.split("|");
    return { name, status, role };
  });
}

async function listEveryTool(client: Client): Promise<Array<{
  name: string;
  description?: string | undefined;
  inputSchema: object;
}>> {
  const tools: Array<{
    name: string;
    description?: string | undefined;
    inputSchema: object;
  }> = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

async function callToolText(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(`${name} failed: ${mcpResultForModel(result).slice(0, 1_500)}`);
  }
  return mcpResultForModel(result);
}

async function proveLiveStream(
  browserPort: number,
  leaseId: string,
  fencingToken: number,
): Promise<void> {
  const controller = new AbortController();
  const response = await fetch(
    `http://127.0.0.1:${browserPort}/v1/leases/${encodeURIComponent(leaseId)}/stream?fencingToken=${fencingToken}`,
    {
      headers: { authorization: "Bearer live-agent-token" },
      signal: controller.signal,
    },
  );
  if (!response.ok || !response.body) {
    throw new Error(`Live stream returned HTTP ${response.status}.`);
  }
  if (!response.headers.get("content-type")?.includes("multipart/x-mixed-replace")) {
    throw new Error("Live stream did not return multipart frames.");
  }
  const reader = response.body.getReader();
  let payload = Buffer.alloc(0);
  try {
    for (let index = 0; index < 10 && payload.length < 2 * 1024 * 1024; index += 1) {
      const chunk = await reader.read();
      if (chunk.done) break;
      payload = Buffer.concat([payload, Buffer.from(chunk.value)]);
      if (payload.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47])) >= 0) return;
    }
    throw new Error("Live stream produced no PNG frame.");
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
}

async function inspectArtifacts(
  browserPort: number,
  artifacts: Array<Record<string, unknown>>,
): Promise<void> {
  const proofExtensions: Record<string, string> = {
    download: "txt",
    pdf: "pdf",
    har: "har",
    trace: "trace",
    recording: "webm",
    state: "json",
    diff: "png",
    "domain-capture": "json",
    screenshot: "png",
  };
  for (const kind of ["download", "pdf", "har", "trace", "recording", "state", "diff", "domain-capture", "screenshot"]) {
    const artifact = artifacts.find((candidate) => candidate["kind"] === kind);
    if (!artifact) throw new Error(`No ${kind} artifact is available for inspection.`);
    const id = requiredString(artifact, "id");
    const response = await fetch(
      `http://127.0.0.1:${browserPort}/v1/artifacts/${encodeURIComponent(id)}/export`,
      { headers: { authorization: "Bearer live-agent-token" } },
    );
    if (!response.ok) throw new Error(`Exporting ${kind} returned HTTP ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 8) throw new Error(`${kind} artifact is unexpectedly small.`);
    if (kind === "pdf" && bytes.subarray(0, 5).toString() !== "%PDF-") {
      throw new Error("PDF artifact has an invalid signature.");
    }
    if (kind === "download" && !bytes.includes(Buffer.from("browsersilo-download-proof"))) {
      throw new Error("Downloaded artifact does not contain the fixture payload.");
    }
    if (kind === "har") {
      const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      if (!value["log"]) throw new Error("HAR artifact has no log object.");
    }
    if (kind === "trace" && !bytes.subarray(0, 2).equals(Buffer.from("PK"))) {
      const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
      if (!parsed) throw new Error("Trace artifact is neither ZIP nor JSON.");
    }
    if (kind === "recording" && !bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
      throw new Error("WebM recording has an invalid EBML signature.");
    }
    if (kind === "state") JSON.parse(bytes.toString("utf8"));
    if (kind === "diff" && !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      throw new Error("Diff artifact has an invalid PNG signature.");
    }
    if (kind === "domain-capture") {
      const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      if (value["schemaVersion"] !== 2 || !value["artifacts"]) {
        throw new Error("Domain Capture manifest is invalid.");
      }
      if (bytes.includes(Buffer.from("browsersilo-proof=cookie"))) {
        throw new Error("Domain Capture leaked a cookie secret.");
      }
    }
    if (kind === "screenshot" && !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      throw new Error("Screenshot artifact has an invalid PNG signature.");
    }
    await writeFile(
      resolve(dirname(proofPath), `browsersilo-live-${kind}.${proofExtensions[kind]}`),
      bytes,
    );
  }
}

async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  const content = result && typeof result === "object" && "content" in result
    ? (result as { content: Array<{ type: string; text?: string }> }).content
    : [];
  const text = content.find((item) => item.type === "text")?.text;
  if (!text) throw new Error(`${name} returned no JSON text content.`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function saveMcpScreenshot(result: unknown, path: string): Promise<void> {
  await writeFile(path, Buffer.from(mcpScreenshotData(result), "base64"));
}

function mcpScreenshotData(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) {
    throw new Error("MCP screenshot result has no content.");
  }
  const content = (result as {
    content: Array<{ type: string; data?: string; mimeType?: string }>;
  }).content;
  const image = content.find(
    (item) => item.type === "image" && item.mimeType === "image/png",
  );
  if (!image?.data) throw new Error("MCP screenshot result has no PNG image.");
  return image.data;
}

function mcpResultForModel(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) {
    return JSON.stringify(result);
  }
  const content = (result as {
    content: Array<{ type: string; text?: string; mimeType?: string }>;
  }).content;
  return content
    .map((item) =>
      item.type === "text"
        ? item.text ?? ""
        : `[${item.mimeType ?? item.type} captured successfully]`,
    )
    .join("\n");
}

function startBrowserSilo(browserPort: number, adminPort: number): ChildProcess {
  return spawn(process.execPath, ["dist/src/index.js"], {
    cwd: process.cwd(),
    env: {
      ...stringEnvironment(),
      BROWSERSILO_WORKER_ADAPTER: "docker",
      BROWSERSILO_BROWSER_PORT: String(browserPort),
      BROWSERSILO_ADMIN_PORT: String(adminPort),
      BROWSERSILO_AGENT_TOKEN: "live-agent-token",
      BROWSERSILO_ADMIN_TOKEN: "live-admin-token",
      BROWSERSILO_DATA_DIR: resolve(".data/live-acceptance"),
      BROWSERSILO_MAX_ACTIVE: "2",
      BROWSERSILO_MAX_ACTIVE_PER_TENANT: "2",
      BROWSERSILO_MAX_QUEUE: "0",
      BROWSERSILO_ADMISSION_TIMEOUT_MS: "1000",
      BROWSERSILO_WARM_SHELLS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForHealth(
  port: number,
  child: ChildProcess,
  output: () => string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`BrowserSilo exited during startup. ${output()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await delay(100);
  }
  throw new Error(`BrowserSilo health check timed out. ${output()}`);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  const port = (server.address() as AddressInfo).port;
  await closeServer(server);
  return port;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())),
    delay(20_000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
}

async function stopChildHard(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGKILL");
  await Promise.race([
    new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())),
    delay(5_000).then(() => {
      throw new Error("BrowserSilo did not exit after SIGKILL.");
    }),
  ]);
}

function chatCompletionsUrl(): string {
  const base = process.env["OPENAI_BASE_URL"]!.replace(/\/$/, "");
  return `${base.endsWith("/v1") ? base : `${base}/v1`}/chat/completions`;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string") throw new Error(`${key} is missing.`);
  return result;
}

function requiredNumber(value: Record<string, unknown>, key: string): number {
  const result = value[key];
  if (typeof result !== "number") throw new Error(`${key} is missing.`);
  return result;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
