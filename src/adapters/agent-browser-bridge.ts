import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { BrowserSiloError } from "../core/errors.js";
import type { BrowserToolResult } from "../core/ports.js";

const require = createRequire(import.meta.url);
const agentBrowserWrapper = require.resolve("agent-browser/bin/agent-browser.js");

const protectedArguments = new Set([
  "allowedDomains",
  "downloadPath",
  "file",
  "files",
  "baseline",
  "output",
  "screenshotDir",
  "extraArgs",
  "namespace",
  "outputPath",
  "path",
  "restore",
  "restoreCheckFn",
  "restoreCheckText",
  "restoreCheckUrl",
  "restoreSave",
  "session",
]);

const safeToolNames = new Set([
  "agent_browser_open",
  "agent_browser_snapshot",
  "agent_browser_click",
  "agent_browser_fill",
  "agent_browser_type",
  "agent_browser_press",
  "agent_browser_hover",
  "agent_browser_focus",
  "agent_browser_check",
  "agent_browser_uncheck",
  "agent_browser_select",
  "agent_browser_scroll",
  "agent_browser_scroll_into_view",
  "agent_browser_wait_ms",
  "agent_browser_wait_for_selector",
  "agent_browser_wait_for_text",
  "agent_browser_wait_for_url",
  "agent_browser_wait_for_load",
  "agent_browser_wait_for_function",
  "agent_browser_screenshot",
  "agent_browser_get_text",
  "agent_browser_get_html",
  "agent_browser_get_value",
  "agent_browser_get_url",
  "agent_browser_get_title",
  "agent_browser_eval",
  "agent_browser_back",
  "agent_browser_forward",
  "agent_browser_reload",
  "agent_browser_dblclick",
  "agent_browser_drag",
  "agent_browser_keydown",
  "agent_browser_keyup",
  "agent_browser_keyboard_type",
  "agent_browser_keyboard_insert_text",
  "agent_browser_get_attr",
  "agent_browser_get_count",
  "agent_browser_get_box",
  "agent_browser_get_styles",
  "agent_browser_is_visible",
  "agent_browser_is_enabled",
  "agent_browser_is_checked",
  "agent_browser_find",
  "agent_browser_mouse_move",
  "agent_browser_mouse_down",
  "agent_browser_mouse_up",
  "agent_browser_mouse_wheel",
  "agent_browser_set_viewport",
  "agent_browser_set_device",
  "agent_browser_set_geo",
  "agent_browser_set_offline",
  "agent_browser_set_headers",
  "agent_browser_set_credentials",
  "agent_browser_set_media",
  "agent_browser_network_route",
  "agent_browser_network_unroute",
  "agent_browser_network_requests",
  "agent_browser_network_request",
  "agent_browser_network_har_start",
  "agent_browser_storage_get",
  "agent_browser_storage_set",
  "agent_browser_storage_clear",
  "agent_browser_cookies_get",
  "agent_browser_cookies_set",
  "agent_browser_cookies_set_curl",
  "agent_browser_cookies_clear",
  "agent_browser_tab_new",
  "agent_browser_tab_list",
  "agent_browser_tab_switch",
  "agent_browser_tab_close",
  "agent_browser_window_new",
  "agent_browser_frame_switch",
  "agent_browser_frame_main",
  "agent_browser_dialog_status",
  "agent_browser_dialog_accept",
  "agent_browser_dialog_dismiss",
  "agent_browser_console",
  "agent_browser_errors",
  "agent_browser_highlight",
  "agent_browser_tap",
  "agent_browser_swipe",
  "agent_browser_device",
  "agent_browser_diff_snapshot",
  "agent_browser_diff_url",
  "agent_browser_batch",
  "agent_browser_react_tree",
  "agent_browser_react_inspect",
  "agent_browser_react_renders_start",
  "agent_browser_react_renders_stop",
  "agent_browser_react_suspense",
  "agent_browser_vitals",
  "agent_browser_pushstate",
  "agent_browser_remove_init_script",
  "agent_browser_confirm",
  "agent_browser_deny",
  "agent_browser_tools_profiles",
  "agent_browser_read",
  "agent_browser_upload",
  "agent_browser_download",
  "agent_browser_wait_for_download",
  "agent_browser_pdf",
  "agent_browser_network_har_stop",
  "agent_browser_trace_start",
  "agent_browser_trace_stop",
  "agent_browser_profiler_start",
  "agent_browser_profiler_stop",
  "agent_browser_record_start",
  "agent_browser_record_stop",
  "agent_browser_record_restart",
  "agent_browser_inspect",
  "agent_browser_clipboard_read",
  "agent_browser_clipboard_write",
  "agent_browser_clipboard_copy",
  "agent_browser_clipboard_paste",
  "agent_browser_auth_save",
  "agent_browser_auth_login",
  "agent_browser_auth_list",
  "agent_browser_auth_show",
  "agent_browser_auth_delete",
  "agent_browser_state_save",
  "agent_browser_state_load",
  "agent_browser_state_list",
  "agent_browser_state_clear",
  "agent_browser_state_show",
  "agent_browser_state_clean",
  "agent_browser_state_rename",
  "agent_browser_diff_screenshot",
]);

export interface BrowserSiloParityTool extends Tool {
  inputSchema: Tool["inputSchema"];
}

export interface AgentBrowserWorkerTransport {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AgentBrowserBridgeOptions {
  workerTransport?: (workerId: string) => AgentBrowserWorkerTransport;
}

export class AgentBrowserBridge {
  readonly #workerTransport:
    | ((workerId: string) => AgentBrowserWorkerTransport)
    | undefined;
  #client: Client | null = null;
  #transport: StdioClientTransport | null = null;
  #connecting: Promise<void> | null = null;
  #tools: BrowserSiloParityTool[] | null = null;
  readonly #workerClients = new Map<
    string,
    { client: Client; transport: StdioClientTransport }
  >();
  readonly #workerConnections = new Map<string, Promise<Client>>();

  constructor(options: AgentBrowserBridgeOptions = {}) {
    this.#workerTransport = options.workerTransport;
  }

  async listTools(): Promise<BrowserSiloParityTool[]> {
    await this.#connect();
    if (this.#tools) return this.#tools.map(cloneTool);
    const tools: BrowserSiloParityTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#client!.listTools(
        cursor === undefined ? undefined : { cursor },
      );
      tools.push(...(page.tools as BrowserSiloParityTool[]));
      cursor = page.nextCursor;
    } while (cursor);
    this.#tools = tools.filter((tool) => safeToolNames.has(tool.name));
    return this.#tools.map(cloneTool);
  }

  async callTool(
    workerId: string,
    cdpPort: number,
    toolName: string,
    arguments_: Record<string, unknown>,
    allowedDomains: string[] = ["*"],
  ): Promise<BrowserToolResult> {
    if (!safeToolNames.has(toolName)) {
      throw new BrowserSiloError(
        "FEATURE_NOT_AVAILABLE",
        "This upstream operation is not exposed until BrowserSilo can broker its files, secrets, or lifecycle safely.",
        501,
        { toolName },
      );
    }
    if (JSON.stringify(arguments_).length > 256 * 1024) {
      throw new BrowserSiloError(
        "INVALID_REQUEST",
        "Browser tool arguments exceed 256 KiB.",
        413,
      );
    }
    const tool = (await this.listTools()).find(
      (candidate) => candidate.name === toolName,
    );
    if (!tool) {
      throw new BrowserSiloError(
        "FEATURE_NOT_AVAILABLE",
        "The installed agent-browser version does not provide this tool.",
        501,
        { toolName },
      );
    }
    const properties = tool.inputSchema.properties ?? {};
    const upstreamArguments = Object.fromEntries(
      Object.entries(arguments_).filter(
        ([key, value]) => !protectedArguments.has(key) || isBrokeredPathArgument(key, value),
      ),
    );
    if ("session" in properties) {
      upstreamArguments["session"] = safeSession(workerId);
    }
    if ("namespace" in properties) {
      upstreamArguments["namespace"] = "browsersilo";
    }
    if ("allowedDomains" in properties && !this.#workerTransport) {
      upstreamArguments["allowedDomains"] = allowedDomains;
    }
    if ("extraArgs" in properties) {
      upstreamArguments["extraArgs"] = [
        "--cdp",
        String(cdpPort),
        "--content-boundaries",
        "--max-output",
        "50000",
      ];
    }
    const client = this.#workerTransport
      ? await this.#connectWorker(workerId)
      : (await this.#connect(), this.#client!);
    const result = await client.callTool({
      name: toolName,
      arguments: upstreamArguments,
    });
    const browserResult = result as BrowserToolResult;
    if (browserResult.isError) {
      const message = browserResult.content
        .filter((item) => item["type"] === "text")
        .map((item) => String(item["text"] ?? ""))
        .join("\n")
        .slice(0, 2_000);
      throw new BrowserSiloError(
        "BROWSER_COMMAND_FAILED",
        message || `The private browser tool ${toolName} failed.`,
        502,
        { toolName },
      );
    }
    return browserResult;
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    this.#transport = null;
    this.#connecting = null;
    this.#tools = null;
    const workerClients = [...this.#workerClients.values()].map(({ client }) => client);
    this.#workerClients.clear();
    this.#workerConnections.clear();
    await Promise.allSettled([
      ...(client ? [client.close()] : []),
      ...workerClients.map((workerClient) => workerClient.close()),
    ]);
  }

  async closeWorker(workerId: string): Promise<void> {
    const entry = this.#workerClients.get(workerId);
    this.#workerClients.delete(workerId);
    this.#workerConnections.delete(workerId);
    if (entry) await entry.client.close();
  }

  async #connect(): Promise<void> {
    if (this.#client) return;
    if (this.#connecting) return this.#connecting;
    this.#connecting = (async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [agentBrowserWrapper, "mcp", "--tools", "all"],
        env: stringEnvironment(),
        stderr: "pipe",
      });
      const client = new Client({
        name: "browsesilo-agent-browser-bridge",
        version: "0.3.0",
      });
      await client.connect(transport);
      this.#transport = transport;
      this.#client = client;
    })();
    try {
      await this.#connecting;
    } finally {
      this.#connecting = null;
    }
  }

  async #connectWorker(workerId: string): Promise<Client> {
    const existing = this.#workerClients.get(workerId);
    if (existing) return existing.client;
    const pending = this.#workerConnections.get(workerId);
    if (pending) return pending;
    if (!this.#workerTransport) throw new Error("Worker transport is not configured.");
    const connecting = (async () => {
      const configured = this.#workerTransport!(workerId);
      const transport = new StdioClientTransport({
        command: configured.command,
        args: configured.args,
        env: { ...stringEnvironment(), ...(configured.env ?? {}) },
        stderr: "pipe",
      });
      const client = new Client({
        name: `browsesilo-worker-${safeSession(workerId)}`,
        version: "0.3.0",
      });
      await client.connect(transport);
      this.#workerClients.set(workerId, { client, transport });
      return client;
    })();
    this.#workerConnections.set(workerId, connecting);
    try {
      return await connecting;
    } finally {
      this.#workerConnections.delete(workerId);
    }
  }
}

function isBrokeredPathArgument(key: string, value: unknown): boolean {
  const pathKeys = new Set([
    "downloadPath", "file", "baseline", "output", "screenshotDir", "outputPath", "path",
  ]);
  if (pathKeys.has(key)) return typeof value === "string" && isBrokerPath(value);
  if (key === "files") {
    return Array.isArray(value) && value.length > 0 && value.every(
      (item) => typeof item === "string" && isBrokerPath(item),
    );
  }
  return false;
}

function isBrokerPath(value: string): boolean {
  return /^\/tmp\/browsersilo-broker\/[a-f0-9-]+\/[^/]+$/.test(value);
}

export function publicParityTool(tool: BrowserSiloParityTool): BrowserSiloParityTool {
  const schema = structuredClone(tool.inputSchema);
  const properties = schema.properties ?? {};
  for (const key of protectedArguments) delete properties[key];
  schema.properties = {
    leaseId: {
      type: "string",
      minLength: 1,
      description: "Active BrowserSilo lease id",
    },
    fencingToken: {
      type: "integer",
      minimum: 1,
      description: "Current BrowserSilo lease fencing token",
    },
    ...properties,
    ...brokerProperties(tool.name),
  };
  const brokerRequired = brokerRequiredProperties(tool.name);
  schema.required = [
    "leaseId",
    "fencingToken",
    ...(schema.required ?? []).filter((key) => !protectedArguments.has(key)),
    ...brokerRequired,
  ];
  return {
    ...cloneTool(tool),
    title: tool.title ?? tool.name,
    description: `${tool.description ?? tool.name} Runs inside an authorized disposable BrowserSilo Brave lease.`,
    inputSchema: schema,
  };
}

function brokerProperties(toolName: string): Record<string, unknown> {
  if (toolName === "agent_browser_upload") {
    return {
      artifactIds: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: { type: "string", pattern: "^artifact_[a-f0-9-]+$" },
        description: "Encrypted BrowserSilo artifact ids to upload into the page.",
      },
    };
  }
  if (
    toolName === "agent_browser_state_load" ||
    toolName === "agent_browser_state_show" ||
    toolName === "agent_browser_cookies_set_curl"
  ) {
    return {
      artifactId: {
        type: "string",
        pattern: "^artifact_[a-f0-9-]+$",
        description: "Encrypted BrowserSilo artifact to use as input.",
      },
    };
  }
  if (toolName === "agent_browser_diff_screenshot") {
    return {
      baselineArtifactId: {
        type: "string",
        pattern: "^artifact_[a-f0-9-]+$",
        description: "Optional encrypted PNG artifact to use as the baseline.",
      },
    };
  }
  return {};
}

function brokerRequiredProperties(toolName: string): string[] {
  if (toolName === "agent_browser_upload") return ["artifactIds"];
  if (
    toolName === "agent_browser_state_load" ||
    toolName === "agent_browser_state_show" ||
    toolName === "agent_browser_cookies_set_curl"
  ) return ["artifactId"];
  return [];
}

function cloneTool(tool: BrowserSiloParityTool): BrowserSiloParityTool {
  return structuredClone(tool);
}

function safeSession(workerId: string): string {
  return `bs-${createHash("sha256").update(workerId).digest("hex").slice(0, 16)}`;
}

function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
