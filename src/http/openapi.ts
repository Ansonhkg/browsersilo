export const browserSiloOpenApi = {
  openapi: "3.1.0",
  info: {
    title: "BrowserSilo Gateway API",
    version: "0.4.0",
    description: "Human-oriented REST, streaming artifacts, resumable events, and live Brave browser control for AI agents.",
  },
  servers: [{ url: "/" }],
  security: [{ bearerAuth: [] }],
  paths: {
    "/health": { get: operation("Process liveness", "health", {}, false) },
    "/ready": { get: operation("Gateway readiness", "ready", {}, false) },
    "/version": { get: operation("Protocol and image compatibility", "version", {}, false) },
    "/mcp": {
      post: operation("Streamable HTTP MCP messages", "mcpPost"),
      get: operation("Streamable HTTP MCP event stream", "mcpGet"),
      delete: operation("End an MCP session", "mcpDelete"),
    },
    "/v1/browsers": {
      post: operation("Open or resume a private Brave browser", "openBrowser", {
        identity: { type: "string" },
        allowedDomains: { type: "array", items: { type: "string" } },
        ttlSeconds: { type: "integer" },
      }),
    },
    "/v1/browsers/{browserId}": {
      get: operation("Read current browser state", "getBrowser"),
      delete: operation("Close, remember, and destroy a browser", "closeBrowser"),
    },
    "/v1/browsers/{browserId}/actions": {
      post: operation("Perform one typed browser action", "browserAction", {
        type: { enum: ["navigate", "snapshot", "screenshot", "click", "type", "press", "scroll", "tabs", "tool"] },
      }),
    },
    "/v1/browsers/{browserId}/actions:batch": {
      post: operation("Perform ordered browser actions", "browserActionBatch", {
        actions: { type: "array", items: { type: "object" } },
        stopOnError: { type: "boolean", default: true },
      }),
    },
    "/v1/browsers/{browserId}/snapshot": {
      get: operation("Read the current accessibility snapshot", "browserSnapshot"),
    },
    "/v1/browsers/{browserId}/events": {
      get: { ...operation("Subscribe to resumable browser events", "browserEvents"), responses: { "200": { description: "SSE event stream", content: { "text/event-stream": {} } } } },
    },
    "/v1/browsers/{browserId}/live-token": {
      post: operation("Issue a short-lived observer, assist, or takeover credential", "browserLiveToken", {
        role: { enum: ["observe", "assist", "takeover"] },
      }),
    },
    "/v1/browsers/{browserId}/captures": {
      post: operation("Start complete evidence capture for one domain", "startCapture", {
        domain: { type: "string" }, redactSecrets: { type: "boolean", default: true },
        includeTrace: { type: "boolean", default: true }, includeVideo: { type: "boolean" },
      }),
    },
    "/v1/browsers/{browserId}/captures/current/stop": {
      post: operation("Stop and encrypt the active evidence capture", "stopCapture"),
    },
    "/v1/artifacts": {
      get: operation("List encrypted artifacts", "listArtifacts"),
      post: { ...operation("Stream an upload into encrypted storage", "uploadArtifact"), requestBody: { required: true, content: { "application/octet-stream": {} } } },
    },
    "/v1/artifacts/{artifactId}/export": {
      get: { ...operation("Stream an authorized artifact download", "downloadArtifact"), responses: { "200": { description: "Artifact byte stream", content: { "application/octet-stream": {} } } } },
      delete: operation("Delete one encrypted artifact", "deleteArtifact"),
    },
  },
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    schemas: {
      Error: {
        type: "object",
        properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, details: { type: "object" } }, required: ["code", "message"] } },
      },
    },
  },
} as const;

function operation(
  summary: string,
  operationId: string,
  bodyProperties?: Record<string, unknown>,
  secured = true,
): Record<string, unknown> {
  return {
    summary,
    operationId,
    ...(secured ? {} : { security: [] }),
    ...(bodyProperties ? {
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object", properties: bodyProperties } } },
      },
    } : {}),
    responses: {
      "200": { description: "Success", content: { "application/json": {} } },
      "400": { description: "Invalid request", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      "401": { description: "Authentication required" },
      "403": { description: "Operation forbidden" },
      "409": { description: "State conflict" },
      "429": { description: "Capacity or rate limit" },
    },
  };
}
