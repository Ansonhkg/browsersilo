import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { startServers } from "../src/http/server.js";
import { createHarness } from "./helpers.js";

test("the stdio MCP adapter discovers and calls BrowserSilo lifecycle tools", async () => {
  const { core } = await createHarness();
  const servers = await startServers(core, {
    host: "127.0.0.1",
    browserPort: 0,
    adminPort: 0,
    agentToken: "mcp-agent",
    adminToken: "mcp-admin",
    localPrincipal: {
      tenantId: "mcp-tenant",
      principalId: "mcp-principal",
      kind: "agent",
    },
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/src/mcp/index.js"],
    cwd: process.cwd(),
    env: {
      ...stringEnvironment(),
      BROWSERSILO_API_URL: `http://127.0.0.1:${servers.browserPort}`,
      BROWSERSILO_AGENT_TOKEN: "mcp-agent",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "browsesilo-test", version: "0.1.0" });

  try {
    await client.connect(transport as unknown as Transport);
    const tools = await listEveryTool(client);
    assert.equal(tools.length, 148);
    for (const name of [
      "browser_lease_acquire",
      "browser_open",
      "browser_act",
      "browser_close",
      "browser_navigate",
      "browser_screenshot",
      "browser_domain_capture_start",
      "browser_domain_capture_stop",
      "agent_browser_get_text",
      "agent_browser_drag",
      "agent_browser_wait_for_download",
      "agent_browser_tab_switch",
      "agent_browser_set_geo",
      "agent_browser_storage_set",
      "agent_browser_network_route",
      "agent_browser_network_har_stop",
      "agent_browser_upload",
      "agent_browser_pdf",
      "agent_browser_trace_stop",
      "agent_browser_record_stop",
      "agent_browser_react_tree",
      "agent_browser_vitals",
      "agent_browser_batch",
    ]) {
      assert.ok(tools.some((tool) => tool.name === name), `${name} is exposed`);
    }
    for (const name of [
      "agent_browser_close",
      "agent_browser_connect",
      "agent_browser_get_cdp_url",
      "agent_browser_install",
      "agent_browser_upgrade",
      "agent_browser_session",
    ]) {
      assert.equal(tools.some((tool) => tool.name === name), false, `${name} is private`);
    }
    const upload = tools.find((tool) => tool.name === "agent_browser_upload");
    assert.ok(upload);
    assert.ok(upload.inputSchema.properties?.["leaseId"]);
    assert.ok(upload.inputSchema.properties?.["fencingToken"]);
    assert.ok(upload.inputSchema.properties?.["artifactIds"]);
    assert.equal(upload.inputSchema.properties?.["files"], undefined);

    const created = await client.callTool({
      name: "browser_profile_create",
      arguments: { name: "MCP profile" },
    });
    const profile = firstJsonContent(created);
    assert.equal(profile["name"], "MCP profile");

    const acquired = await client.callTool({
      name: "browser_lease_acquire",
      arguments: {
        profileId: profile["id"],
        idempotencyKey: "mcp-contract",
      },
    });
    const lease = firstJsonContent(acquired);
    assert.equal(lease["state"], "active");

    const released = await client.callTool({
      name: "browser_lease_release",
      arguments: {
        leaseId: lease["id"],
        fencingToken: lease["fencingToken"],
      },
    });
    assert.equal(firstJsonContent(released)["state"], "closed");
  } finally {
    await client.close();
    await servers.close();
  }
});

test("the public Streamable HTTP MCP endpoint authenticates and exposes the same tools", async () => {
  const { core } = await createHarness();
  const servers = await startServers(core, {
    host: "127.0.0.1",
    browserPort: 0,
    adminPort: 0,
    agentToken: "remote-mcp-agent-token",
    adminToken: "remote-mcp-admin",
    localPrincipal: {
      tenantId: "remote-mcp-tenant",
      principalId: "remote-mcp-principal",
      kind: "agent",
    },
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${servers.browserPort}/mcp`),
    { requestInit: { headers: { authorization: "Bearer remote-mcp-agent-token" } } },
  );
  const client = new Client({ name: "browsesilo-http-test", version: "0.1.0" });

  try {
    await client.connect(transport as unknown as Transport);
    const tools = await listEveryTool(client);
    assert.equal(tools.length, 148);
    assert.ok(tools.some((tool) => tool.name === "browser_open"));
    assert.ok(transport.sessionId);
  } finally {
    await client.close();
    await servers.close();
  }
});

async function listEveryTool(client: Client) {
  const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

function firstJsonContent(result: unknown): Record<string, unknown> {
  assert.ok(result && typeof result === "object");
  const content = (result as { content?: Array<{ type: string; text?: string }> })
    .content;
  const text = content?.find((item) => item.type === "text")?.text;
  assert.ok(text);
  return JSON.parse(text) as Record<string, unknown>;
}

function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
