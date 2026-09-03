import assert from "node:assert/strict";
import test from "node:test";
import type {
  BrowserAutomationPort,
  BrowserScreenshot,
  BrowserSnapshot,
  BrowserTab,
  BrowserToolResult,
} from "../src/core/ports.js";
import { BrowserAutomationService } from "../src/browser/service.js";
import { createAgentCredential, startServers } from "../src/http/server.js";
import { createHarness } from "./helpers.js";

const AGENT_TOKEN = "realtime-agent-token";
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

class FakeBrowser implements BrowserAutomationPort {
  url = "about:blank";
  title = "Blank";

  async navigate(_workerId: string, url: string): Promise<{ url: string; title: string }> {
    this.url = url;
    this.title = "BrowserSilo test page";
    return { url, title: this.title };
  }

  async snapshot(): Promise<BrowserSnapshot> {
    return { url: this.url, title: this.title, nodes: [], elements: [] };
  }

  async screenshot(): Promise<BrowserScreenshot> {
    return { mimeType: "image/png", data: PNG_1X1 };
  }

  async click(): Promise<void> {}
  async type(): Promise<void> {}
  async evaluate(): Promise<unknown> { return null; }
  async tabs(): Promise<BrowserTab[]> {
    return [{ id: "tab-1", type: "page", title: this.title, url: this.url }];
  }
  async agentTool(_workerId: string, toolName: string): Promise<BrowserToolResult> {
    return { content: [{ type: "text", text: toolName }] };
  }
  async stageFile(): Promise<string> { return "/tmp/upload"; }
  async prepareFile(): Promise<string> { return "/tmp/download"; }
  async collectFile(): Promise<void> {}
  async removeFile(): Promise<void> {}
}

test("one public gateway serves REST, resumable SSE, and binary WebSocket takeover", async () => {
  const { core } = await createHarness();
  const automation = new BrowserAutomationService(core, new FakeBrowser());
  const servers = await startServers(core, {
    host: "127.0.0.1",
    browserPort: 0,
    adminPort: 0,
    adminToken: "realtime-admin-token",
    automation,
    agentCredentials: [createAgentCredential(AGENT_TOKEN, {
      tenantId: "realtime-tenant",
      principalId: "realtime-agent",
      kind: "agent",
    })],
  });
  const baseUrl = `http://127.0.0.1:${servers.browserPort}`;
  let socket: WebSocket | undefined;

  try {
    const opened = await api(baseUrl, "POST", "/v1/browsers", {
      identity: "daily-life",
      allowedDomains: ["wikipedia.org"],
    }) as {
      id: string;
      status: string;
      live: { token: string; role: string };
    };
    assert.equal(opened.status, "ready");
    assert.equal(opened.live.role, "observe");

    const navigated = await api(baseUrl, "POST", `/v1/browsers/${opened.id}/actions`, {
      type: "navigate",
      url: "https://www.wikipedia.org/",
    }) as { result: { title: string } };
    assert.equal(navigated.result.title, "BrowserSilo test page");

    const eventsResponse = await fetch(`${baseUrl}/v1/browsers/${opened.id}/events`, {
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(eventsResponse.status, 200);
    const reader = eventsResponse.body!.getReader();
    const firstEvents = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    assert.match(firstEvents, /event: browser\.ready/);
    assert.match(firstEvents, /event: page\.changed/);
    const eventId = [...firstEvents.matchAll(/^id: (.+)$/gm)].at(-1)?.[1];
    assert.ok(eventId);

    await api(baseUrl, "POST", `/v1/browsers/${opened.id}/actions`, { type: "snapshot" });
    const replayResponse = await fetch(`${baseUrl}/v1/browsers/${opened.id}/events`, {
      headers: {
        authorization: `Bearer ${AGENT_TOKEN}`,
        "last-event-id": eventId,
      },
      signal: AbortSignal.timeout(2_000),
    });
    const replayReader = replayResponse.body!.getReader();
    const replay = new TextDecoder().decode((await replayReader.read()).value);
    await replayReader.cancel();
    assert.match(replay, /event: action\.completed/);

    const live = await api(baseUrl, "POST", `/v1/browsers/${opened.id}/live-token`, {
      role: "takeover",
    }) as { token: string };
    socket = new WebSocket(
      `ws://127.0.0.1:${servers.browserPort}/v1/browsers/${opened.id}/live?token=${encodeURIComponent(live.token)}`,
      "browsersilo.v1",
    );
    const messages: unknown[] = [];
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      messages.push(typeof event.data === "string" ? JSON.parse(event.data) : event.data);
    });
    await waitUntil(() => messages.some((item) => isMessage(item, "browser.ready")));
    await waitUntil(() => messages.some((item) => item instanceof ArrayBuffer));

    socket.send(JSON.stringify({ type: "takeover.request" }));
    await waitUntil(() => messages.some((item) => isMessage(item, "takeover.started")));
    const paused = await fetch(`${baseUrl}/v1/browsers/${opened.id}/actions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${AGENT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "snapshot" }),
    });
    assert.equal(paused.status, 409);
    assert.equal(((await paused.json()) as { error: { code: string } }).error.code, "HUMAN_TAKEOVER_ACTIVE");

    socket.send(JSON.stringify({ type: "input.keyboard", key: "Tab" }));
    await waitUntil(() => messages.some((item) => isMessage(item, "input.accepted")));
    socket.send(JSON.stringify({ type: "takeover.release" }));
    await waitUntil(() => messages.some((item) => isMessage(item, "takeover.ended")));
    await api(baseUrl, "POST", `/v1/browsers/${opened.id}/actions`, { type: "snapshot" });

    socket.close();
    await api(baseUrl, "DELETE", `/v1/browsers/${opened.id}`);
  } finally {
    socket?.close();
    await servers.close();
  }
});

async function api(
  baseUrl: string,
  method: "POST" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${AGENT_TOKEN}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json() as unknown;
  assert.ok(response.ok, JSON.stringify(result));
  return result;
}

function isMessage(value: unknown, type: string): boolean {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>)["type"] === type;
}

async function waitUntil(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for realtime message.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
