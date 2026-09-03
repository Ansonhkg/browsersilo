import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EncryptedArtifactStore } from "../src/artifacts/encrypted-artifact-store.js";
import type { ArtifactKind } from "../src/artifacts/encrypted-artifact-store.js";
import { BrowserAutomationService } from "../src/browser/service.js";
import type {
  BrowserAutomationPort,
  BrowserScreenshot,
  BrowserSnapshot,
  BrowserTab,
  BrowserToolResult,
} from "../src/core/ports.js";
import { LocalKeyManagement } from "../src/security/key-management.js";
import { agentA, createHarness } from "./helpers.js";

test("session Domain Capture seals redacted HAR, trace, video, screenshot, and manifest artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browsersilo-domain-capture-"));
  try {
    const { core } = await createHarness();
    const profile = await core.createProfile(agentA, { name: "Capture identity" });
    const lease = await core.acquireLease(agentA, { profileId: profile.id });
    const artifacts = await EncryptedArtifactStore.create(
      join(directory, "artifacts"),
      new LocalKeyManagement(Buffer.alloc(32, 13)),
    );
    const automation = new FakeBrowserAutomation();
    const service = new BrowserAutomationService(core, automation, artifacts);

    const capture = await service.captureDomain(
      agentA,
      lease.id,
      lease.fencingToken,
      "https://example.com/checkout",
      { includeTrace: true, includeVideo: true, redactSecrets: true },
    );

    assert.equal(capture.url, "https://example.com/checkout");
    assert.ok(capture.harArtifact);
    assert.ok(capture.traceArtifact);
    assert.ok(capture.recordingArtifact);
    const kinds = (await artifacts.list(agentA)).map((artifact) => artifact.kind);
    for (const kind of ["domain-capture", "har", "trace", "recording", "screenshot"] as ArtifactKind[]) {
      assert.ok(kinds.includes(kind), `expected ${kind} artifact`);
    }
    const manifest = (await artifacts.readBuffer(agentA, capture.artifact.id)).toString("utf8");
    assert.match(manifest, /\[REDACTED\]/);
    assert.doesNotMatch(manifest, /supersecret/);
    assert.match(
      (await artifacts.readBuffer(agentA, capture.harArtifact!.id)).toString("utf8"),
      /example\.com/,
    );
    assert.doesNotMatch(
      (await artifacts.readBuffer(agentA, capture.harArtifact!.id)).toString("utf8"),
      /har-secret/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

class FakeBrowserAutomation implements BrowserAutomationPort {
  readonly #files = new Map<string, Buffer>();
  #url = "about:blank";
  #recordingPath: string | null = null;
  #nextFile = 0;

  async navigate(_workerId: string, url: string): Promise<{ url: string; title: string }> {
    this.#url = url;
    return { url, title: "Capture fixture" };
  }

  async snapshot(): Promise<BrowserSnapshot> {
    return {
      url: this.#url,
      title: "Capture fixture",
      nodes: [{ role: "heading", name: "Checkout", value: null, description: null, focused: false, disabled: false }],
      elements: [],
    };
  }

  async screenshot(): Promise<BrowserScreenshot> {
    return { mimeType: "image/png", data: Buffer.from("fake-png").toString("base64") };
  }

  async click(): Promise<void> {}
  async type(): Promise<void> {}
  async evaluate(): Promise<unknown> { return true; }
  async tabs(): Promise<BrowserTab[]> { return []; }

  async agentTool(
    _workerId: string,
    toolName: string,
    arguments_: Record<string, unknown>,
  ): Promise<BrowserToolResult> {
    if (toolName === "agent_browser_record_start") {
      this.#recordingPath = String(arguments_["path"]);
    }
    if (toolName === "agent_browser_record_stop" && this.#recordingPath) {
      this.#files.set(this.#recordingPath, Buffer.from("webm-recording"));
    }
    if (toolName === "agent_browser_network_har_stop") {
      this.#files.set(
        String(arguments_["path"]),
        Buffer.from(JSON.stringify({ log: { entries: [{ request: {
          url: "https://example.com/checkout",
          headers: [{ name: "Authorization", value: "Bearer har-secret" }],
        } }] } })),
      );
    }
    if (toolName === "agent_browser_trace_stop") {
      this.#files.set(String(arguments_["path"]), Buffer.from("trace-zip"));
    }
    const secretPayload = toolName === "agent_browser_cookies_get"
      ? { cookies: [{ name: "sessionToken", value: "supersecret" }] }
      : { ok: true, toolName };
    return {
      content: [{ type: "text", text: JSON.stringify(secretPayload) }],
      structuredContent: secretPayload,
    };
  }

  async stageFile(): Promise<string> { throw new Error("not used"); }

  async prepareFile(_workerId: string, fileName: string): Promise<string> {
    this.#nextFile += 1;
    return `/tmp/browsersilo-broker/00000000-0000-4000-8000-${String(this.#nextFile).padStart(12, "0")}/${fileName}`;
  }

  async collectFile(_workerId: string, containerPath: string, destination: string): Promise<void> {
    const payload = this.#files.get(containerPath);
    if (!payload) throw new Error(`Missing fake broker output ${containerPath}`);
    await writeFile(destination, payload);
  }

  async removeFile(_workerId: string, containerPath: string): Promise<void> {
    this.#files.delete(containerPath);
  }
}
