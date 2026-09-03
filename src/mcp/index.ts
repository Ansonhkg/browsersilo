import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BrowserSiloApiClient } from "./api-client.js";
import { createBrowserSiloMcpServer } from "./server.js";

const apiUrl = process.env["BROWSERSILO_API_URL"] ?? "http://127.0.0.1:4100";
const token =
  process.env["BROWSERSILO_AGENT_TOKEN"] ?? "agent-local-development-token";
const server = await createBrowserSiloMcpServer(
  new BrowserSiloApiClient(apiUrl, token),
);
await server.connect(new StdioServerTransport());
