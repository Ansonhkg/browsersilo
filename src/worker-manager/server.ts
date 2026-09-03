import { execFile, spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { assertApprovedDockerArguments, type WorkerManagerPolicy } from "./policy.js";
import { decodeArgs } from "./client.js";

const execFileAsync = promisify(execFile);

export interface WorkerManagerOptions {
  host: string;
  port: number;
  stdioPort: number;
  token: string;
  policy: WorkerManagerPolicy;
}

export async function startWorkerManager(options: WorkerManagerOptions) {
  if (options.token.length < 24) throw new Error("The worker-manager token must contain at least 24 characters.");
  const http = createServer((request, response) => {
    void handle(request, response, options).catch((error) => fail(response, error));
  });
  const tcp = createTcpServer((socket) => handleStdio(socket, options));
  await Promise.all([listen(http, options.port, options.host), listenTcp(tcp, options.stdioPort, options.host)]);
  return {
    async close() {
      await Promise.all([
        new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve())),
        new Promise<void>((resolve, reject) => tcp.close((error) => error ? reject(error) : resolve())),
      ]);
    },
  };
}

async function handle(request: IncomingMessage, response: ServerResponse, options: WorkerManagerOptions): Promise<void> {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "worker-manager" }));
    return;
  }
  authenticate(request.headers.authorization, options.token);
  if (request.method !== "POST") return failStatus(response, 404, "NOT_FOUND", "Worker-manager route not found.");
  if (request.url === "/internal/v1/docker/command") {
    const body = await readObject(request);
    const args = stringArray(body["args"]);
    assertApprovedDockerArguments(args, options.policy);
    const result = await execFileAsync("docker", args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(result.stdout);
    return;
  }
  if (request.url === "/internal/v1/docker/input") {
    const args = decodeArgs(single(request.headers["x-browsersilo-docker-args"]));
    assertApprovedDockerArguments(args, options.policy, "input");
    const child = spawn("docker", args, { stdio: ["pipe", "ignore", "pipe"] });
    await pumpInput(request, child);
    response.writeHead(204).end();
    return;
  }
  if (request.url === "/internal/v1/docker/output") {
    const body = await readObject(request);
    const args = stringArray(body["args"]);
    assertApprovedDockerArguments(args, options.policy, "output");
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    response.writeHead(200, { "content-type": "application/octet-stream" });
    await pumpOutput(child, response);
    return;
  }
  failStatus(response, 404, "NOT_FOUND", "Worker-manager route not found.");
}

function handleStdio(socket: Socket, options: WorkerManagerOptions): void {
  let buffer = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 16 * 1024) return socket.destroy();
    const newline = buffer.indexOf(0x0a);
    if (newline < 0) return;
    socket.off("data", onData);
    try {
      const handshake = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
      authenticate(typeof handshake["token"] === "string" ? `Bearer ${handshake["token"]}` : undefined, options.token);
      const containerName = String(handshake["containerName"] ?? "");
      const args = ["exec", "-i", "-u", "1000", "-e", "HOME=/tmp", "-e", "AGENT_BROWSER_ENABLE=react-devtools", containerName, "agent-browser", "mcp", "--tools", "all"];
      assertApprovedDockerArguments(args, options.policy, "input");
      const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
      const remainder = buffer.subarray(newline + 1);
      if (remainder.length > 0) child.stdin.write(remainder);
      socket.pipe(child.stdin);
      child.stdout.pipe(socket);
      child.stderr.on("data", (value: Buffer) => process.stderr.write(value));
      socket.once("close", () => child.kill("SIGTERM"));
      child.once("close", () => socket.end());
    } catch {
      socket.destroy();
    }
  };
  socket.on("data", onData);
}

function authenticate(value: string | undefined, expected: string): void {
  const token = value?.startsWith("Bearer ") ? value.slice(7) : "";
  const actualHash = createHash("sha256").update(token).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  if (!timingSafeEqual(actualHash, expectedHash)) throw Object.assign(new Error("Worker-manager authentication failed."), { status: 401 });
}

async function readObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 1024 * 1024) throw Object.assign(new Error("Request too large."), { status: 413 });
    chunks.push(value);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("A JSON object is required.");
  return parsed as Record<string, unknown>;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error("args must be a string array.");
  return value;
}

async function pumpInput(request: IncomingMessage, child: ReturnType<typeof spawn>): Promise<void> {
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk}`.slice(-4000); });
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `docker exited ${code}`)));
  });
  await Promise.all([pipeline(request, child.stdin!), completed]);
}

async function pumpOutput(child: ReturnType<typeof spawn>, response: ServerResponse): Promise<void> {
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk}`.slice(-4000); });
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `docker exited ${code}`)));
  });
  await Promise.all([pipeline(child.stdout!, response), completed]);
}

function single(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }
function fail(response: ServerResponse, error: unknown): void {
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : 400;
  failStatus(response, status, "WORKER_MANAGER_REJECTED", error instanceof Error ? error.message : "Operation rejected.");
}
function failStatus(response: ServerResponse, status: number, code: string, message: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { code, message } }));
}
function listen(server: ReturnType<typeof createServer>, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
}
function listenTcp(server: ReturnType<typeof createTcpServer>, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
}
