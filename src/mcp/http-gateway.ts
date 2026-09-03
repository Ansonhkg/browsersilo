import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { BrowserSiloApiClient } from "./api-client.js";
import { createBrowserSiloMcpServer } from "./server.js";

interface HttpMcpSession {
  tokenHash: Buffer;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

export class StreamableMcpGateway {
  readonly #sessions = new Map<string, HttpMcpSession>();
  readonly #apiUrl: () => string;

  constructor(apiUrl: () => string) {
    this.#apiUrl = apiUrl;
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    bearerToken: string,
  ): Promise<void> {
    const sessionId = singleHeader(request.headers["mcp-session-id"]);
    const body = request.method === "POST" ? await readJson(request) : undefined;
    let session = sessionId ? this.#sessions.get(sessionId) : undefined;

    if (session && !sameHash(session.tokenHash, bearerToken)) {
      jsonError(response, 403, "MCP_SESSION_OWNER_MISMATCH", "This MCP session belongs to another credential.");
      return;
    }

    if (!session && request.method === "POST" && isInitializeRequest(body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (createdId) => {
          this.#sessions.set(createdId, created);
        },
      });
      const server = await createBrowserSiloMcpServer(
        new BrowserSiloApiClient(this.#apiUrl(), bearerToken),
      );
      const created: HttpMcpSession = {
        tokenHash: hash(bearerToken),
        transport,
        server,
      };
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) this.#sessions.delete(id);
      };
      await server.connect(transport as unknown as Transport);
      session = created;
    }

    if (!session) {
      jsonError(response, 400, "MCP_SESSION_REQUIRED", "Initialize an MCP session before sending this request.");
      return;
    }

    await session.transport.handleRequest(request, response, body);
  }

  async close(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.allSettled(sessions.map(async ({ server }) => server.close()));
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 4 * 1024 * 1024) throw new Error("MCP request body is too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function sameHash(expected: Buffer, token: string): boolean {
  const actual = hash(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function jsonError(response: ServerResponse, status: number, code: string, message: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { code, message } }));
}
