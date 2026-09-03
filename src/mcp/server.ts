import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import {
  AgentBrowserBridge,
  publicParityTool,
} from "../adapters/agent-browser-bridge.js";
import { BrowserSiloApiClient } from "./api-client.js";

export async function createBrowserSiloMcpServer(
  client: BrowserSiloApiClient,
): Promise<McpServer> {
  const server = new McpServer({ name: "browsersilo", version: "0.4.0" });

  server.registerTool(
    "browser_open",
    {
      title: "Open or resume a private browser",
      description:
        "Open a real private Brave browser with a named identity. Cookies, logins, history, storage, and preferences are restored automatically when that identity already exists.",
      inputSchema: {
        identity: z.string().min(1).max(100).describe("A memorable name such as personal-shopping or work-travel"),
        allowedDomains: z.array(z.string().min(1).max(253)).min(1).max(100).optional(),
        ttlSeconds: z.number().int().min(10).max(86_400).optional(),
      },
    },
    async ({ identity, allowedDomains, ttlSeconds }) =>
      textResult(await client.openBrowser({
        identity,
        ...(allowedDomains ? { allowedDomains } : {}),
        ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
      })),
  );

  server.registerTool(
    "browser_act",
    {
      title: "Use an open browser",
      description:
        "Perform one ordinary action in an open browser. Read a snapshot before choosing targets, and stop for human approval before purchases, bookings, sending, publishing, or deletion.",
      inputSchema: {
        browserId: z.string().min(1),
        action: z.discriminatedUnion("type", [
          z.object({ type: z.literal("navigate"), url: z.string().min(1) }),
          z.object({ type: z.literal("snapshot") }),
          z.object({ type: z.literal("screenshot") }),
          z.object({ type: z.literal("click"), target: z.string().min(1) }),
          z.object({ type: z.literal("type"), target: z.string().min(1), text: z.string() }),
          z.object({ type: z.literal("press"), key: z.string().min(1) }),
          z.object({
            type: z.literal("scroll"),
            direction: z.enum(["up", "down", "left", "right"]),
            amount: z.number().int().positive().optional(),
          }),
          z.object({ type: z.literal("tabs") }),
        ]),
      },
    },
    async ({ browserId, action }) =>
      textResult(await client.browserAction(browserId, action)),
  );

  server.registerTool(
    "browser_close",
    {
      title: "Close and remember a browser",
      description:
        "Close the browser safely, save its encrypted identity, and destroy the disposable worker. Use this when browsing is complete.",
      inputSchema: { browserId: z.string().min(1) },
    },
    async ({ browserId }) => textResult(await client.closeBrowser(browserId)),
  );

  server.registerTool(
    "browser_capabilities",
    {
      title: "Inspect browser capabilities",
      description:
        "Report whether this BrowserSilo runtime currently provides real headed Brave, native CDP actions, persistence, recording, and Domain Capture.",
      inputSchema: {},
    },
    async () => textResult(await client.capabilities()),
  );

  server.registerTool(
    "browser_profile_create",
    {
      title: "Create browser profile",
      description:
        "Create an owner-scoped durable browser identity. Keep the returned profile id for future leases.",
      inputSchema: {
        name: z.string().min(1).max(100).describe("Human-readable profile name"),
      },
    },
    async ({ name }) => textResult(await client.createProfile(name)),
  );

  server.registerTool(
    "browser_profile_list",
    {
      title: "List browser profiles",
      description: "List durable browser identities owned by this agent principal.",
      inputSchema: {},
    },
    async () => textResult(await client.listProfiles()),
  );

  server.registerTool(
    "browser_artifact_list",
    {
      title: "List encrypted browser artifacts",
      description:
        "List owner-scoped uploads, downloads, screenshots, PDFs, HAR files, traces, recordings, state, and Domain Captures.",
      inputSchema: {
        kind: z.enum([
          "upload", "download", "screenshot", "pdf", "har", "trace", "profile",
          "recording", "state", "diff", "domain-capture", "console", "network", "other",
        ]).optional(),
      },
    },
    async ({ kind }) => textResult(await client.listArtifacts(kind)),
  );

  server.registerTool(
    "browser_artifact_upload",
    {
      title: "Upload encrypted browser artifact",
      description:
        "Store a bounded base64 payload as an encrypted owner-scoped artifact. Use its artifact id with browser upload and state tools.",
      inputSchema: {
        name: z.string().min(1).max(240),
        mimeType: z.string().min(3).max(120),
        kind: z.enum(["upload", "state", "other"]).default("upload"),
        dataBase64: z.string().max(16 * 1024 * 1024),
      },
    },
    async (input) => textResult(await client.uploadArtifact(input)),
  );

  server.registerTool(
    "browser_lease_acquire",
    {
      title: "Acquire private browser",
      description:
        "Acquire one disposable headed Brave worker for a durable profile. Save the returned lease id and fencing token; every browser action requires both.",
      inputSchema: {
        profileId: z.string().min(1).describe("Owned browser profile id"),
        ttlSeconds: z.number().int().min(10).max(86_400).optional(),
        idempotencyKey: z.string().min(1).max(200).optional(),
        allowedDomains: z.array(z.string().min(1).max(253)).min(1).max(100).optional()
          .describe("Per-lease domain allowlist. Private and special-use IP ranges are always blocked."),
      },
    },
    async ({ profileId, ttlSeconds, idempotencyKey, allowedDomains }) =>
      textResult(
        await client.acquireLease({
          profileId,
          ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
          ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
          ...(allowedDomains !== undefined ? { allowedDomains } : {}),
        }),
      ),
  );

  server.registerTool(
    "browser_lease_renew",
    {
      title: "Renew browser lease",
      description: "Extend an active browser lease using its current fencing token.",
      inputSchema: {
        leaseId: z.string().min(1),
        fencingToken: z.number().int().positive(),
        ttlSeconds: z.number().int().min(10).max(86_400).optional(),
      },
    },
    async ({ leaseId, fencingToken, ttlSeconds }) =>
      textResult(await client.renewLease(leaseId, fencingToken, ttlSeconds)),
  );

  server.registerTool(
    "browser_lease_release",
    {
      title: "Release private browser",
      description:
        "Gracefully close Brave, encrypt and commit the profile, destroy the used container, and close the lease. Always call this when browser work is complete.",
      inputSchema: {
        leaseId: z.string().min(1),
        fencingToken: z.number().int().positive(),
      },
    },
    async ({ leaseId, fencingToken }) =>
      textResult(await client.releaseLease(leaseId, fencingToken)),
  );

  server.registerTool(
    "browser_navigate",
    {
      title: "Navigate browser",
      description:
        "Navigate the leased headed Brave page using native Chrome DevTools Protocol and wait for it to load.",
      inputSchema: {
        leaseId: z.string().min(1),
        fencingToken: z.number().int().positive(),
        url: z.string().min(1).max(100_000),
      },
    },
    async ({ leaseId, fencingToken, url }) =>
      textResult(await client.navigate(leaseId, fencingToken, url)),
  );

  server.registerTool(
    "browser_snapshot",
    {
      title: "Read browser snapshot",
      description:
        "Read the current page title, URL, and bounded accessibility tree directly through CDP. Use this before choosing selectors or describing page state.",
      inputSchema: {
        leaseId: z.string().min(1),
        fencingToken: z.number().int().positive(),
      },
    },
    async ({ leaseId, fencingToken }) =>
      textResult(await client.snapshot(leaseId, fencingToken)),
  );

  server.registerTool(
    "browser_screenshot",
    {
      title: "Capture browser screenshot",
      description: "Capture the current rendered Brave page as a PNG through CDP.",
      inputSchema: {
        leaseId: z.string().min(1),
        fencingToken: z.number().int().positive(),
      },
    },
    async ({ leaseId, fencingToken }) => {
      const screenshot = await client.screenshot(leaseId, fencingToken);
      return {
        content: [
          { type: "image" as const, data: screenshot.data, mimeType: screenshot.mimeType },
          { type: "text" as const, text: "Captured the current Brave page." },
        ],
      };
    },
  );

  server.registerTool(
    "browser_click",
    {
      title: "Click page element",
      description:
        "Click one CSS-selected element using native CDP mouse input. Read a snapshot first and use a specific selector.",
      inputSchema: {
        leaseId: z.string().min(1),
        fencingToken: z.number().int().positive(),
        selector: z.string().min(1).max(2_000),
      },
    },
    async ({ leaseId, fencingToken, selector }) => {
      await client.click(leaseId, fencingToken, selector);
      return textResult({ ok: true, selector });
    },
  );

  server.registerTool(
    "browser_type",
    {
      title: "Type into page element",
      description:
        "Focus one CSS-selected form element, clear its existing value, and insert text using native CDP input.",
      inputSchema: {
        leaseId: z.string().min(1),
        fencingToken: z.number().int().positive(),
        selector: z.string().min(1).max(2_000),
        text: z.string().max(20_000),
      },
    },
    async ({ leaseId, fencingToken, selector, text }) => {
      await client.type(leaseId, fencingToken, selector, text);
      return textResult({ ok: true, selector, characters: text.length });
    },
  );

  server.registerTool(
    "browser_evaluate",
    {
      title: "Evaluate page expression",
      description:
        "Evaluate a bounded JavaScript expression in the leased page through native CDP. Use only when snapshot, click, and type are insufficient.",
      inputSchema: {
        leaseId: z.string().min(1),
        fencingToken: z.number().int().positive(),
        expression: z.string().min(1).max(20_000),
      },
    },
    async ({ leaseId, fencingToken, expression }) =>
      textResult(await client.evaluate(leaseId, fencingToken, expression)),
  );

  server.registerTool(
    "browser_tabs",
    {
      title: "List browser tabs",
      description: "List the current tabs and targets in the leased Brave worker.",
      inputSchema: {
        leaseId: z.string().min(1),
        fencingToken: z.number().int().positive(),
      },
    },
    async ({ leaseId, fencingToken }) =>
      textResult(await client.tabs(leaseId, fencingToken)),
  );

  server.registerTool(
    "browser_domain_capture",
    {
      title: "Capture a complete website domain session",
      description:
        "Navigate a private Brave lease and collect DOM, accessibility state, cookies, web storage, requests, HAR, console, errors, and a screenshot into encrypted artifacts. Secret redaction is enabled by default.",
      inputSchema: {
        leaseId: z.string().min(1),
        fencingToken: z.number().int().positive(),
        url: z.string().url().max(100_000),
        redactSecrets: z.boolean().default(true),
        includeTrace: z.boolean().default(true),
        includeVideo: z.boolean().default(false),
      },
    },
    async ({ leaseId, fencingToken, url, redactSecrets, includeTrace, includeVideo }) =>
      textResult(await client.captureDomain(
        leaseId, fencingToken, url, redactSecrets, includeTrace, includeVideo,
      )),
  );

  server.registerTool(
    "browser_domain_capture_start",
    {
      title: "Start full-fidelity Domain Capture",
      description:
        "Start a domain-scoped collection session before using ordinary browser tools. It records HAR traffic across the whole interaction and can additionally collect a trace and WebM video. Stop it with browser_domain_capture_stop.",
      inputSchema: {
        leaseId: z.string().min(1),
        fencingToken: z.number().int().positive(),
        domain: z.string().min(1).max(253),
        redactSecrets: z.boolean().default(true),
        includeTrace: z.boolean().default(true),
        includeVideo: z.boolean().default(true),
      },
    },
    async ({ leaseId, fencingToken, domain, redactSecrets, includeTrace, includeVideo }) =>
      textResult(await client.startDomainCapture(leaseId, fencingToken, domain, {
        redactSecrets,
        includeTrace,
        includeVideo,
      })),
  );

  server.registerTool(
    "browser_domain_capture_stop",
    {
      title: "Stop and seal Domain Capture",
      description:
        "Stop the active domain capture and seal its DOM, accessibility state, cookies, web storage, requests, HAR, trace, video, console, errors, and screenshot as encrypted artifacts.",
      inputSchema: {
        leaseId: z.string().min(1),
        fencingToken: z.number().int().positive(),
      },
    },
    async ({ leaseId, fencingToken }) =>
      textResult(await client.stopDomainCapture(leaseId, fencingToken)),
  );

  const catalog = new AgentBrowserBridge();
  try {
    for (const upstream of await catalog.listTools()) {
      const tool = publicParityTool(upstream);
      const inputSchema = z.fromJSONSchema(
        tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0],
      );
      server.registerTool(
        tool.name,
        {
          ...(tool.title ? { title: tool.title } : {}),
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema,
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        },
        async (input): Promise<CallToolResult> => {
          const values = input as Record<string, unknown>;
          const leaseId = values["leaseId"];
          const fencingToken = values["fencingToken"];
          if (typeof leaseId !== "string" || typeof fencingToken !== "number") {
            throw new Error("The BrowserSilo lease id and fencing token are required.");
          }
          const arguments_ = { ...values };
          delete arguments_["leaseId"];
          delete arguments_["fencingToken"];
          return (await client.agentTool(
            leaseId,
            fencingToken,
            tool.name,
            arguments_,
          )) as CallToolResult;
        },
      );
    }
  } finally {
    await catalog.close();
  }

  return server;
}

function textResult(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}
