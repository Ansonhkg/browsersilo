import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, connect, type Server } from "node:net";
import test from "node:test";

test("egress proxy blocks private IPv4, IPv6, localhost, and disallowed domains", async () => {
  const port = await freeTcpPort();
  const proxy = spawn(process.execPath, ["container/egress-proxy.mjs"], {
    cwd: process.cwd(),
    env: {
      ...stringEnvironment(),
      BROWSERSILO_EGRESS_PORT: String(port),
      BROWSERSILO_ALLOWED_DOMAINS: "example.com",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  proxy.stderr?.on("data", (chunk: Buffer) => {
    errors = `${errors}${chunk.toString("utf8")}`.slice(-2_000);
  });
  try {
    await waitForTcp(port, proxy, () => errors);
    for (const request of [
      "CONNECT 127.0.0.1:80 HTTP/1.1\r\nHost: 127.0.0.1:80\r\n\r\n",
      "CONNECT [::1]:80 HTTP/1.1\r\nHost: [::1]:80\r\n\r\n",
      "CONNECT [::ffff:127.0.0.1]:80 HTTP/1.1\r\nHost: [::ffff:127.0.0.1]:80\r\n\r\n",
      "GET http://localhost/ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      "GET http://not-example.invalid/ HTTP/1.1\r\nHost: not-example.invalid\r\nConnection: close\r\n\r\n",
    ]) {
      const response = await rawRequest(port, request);
      assert.match(response, /^HTTP\/1\.1 403/);
    }
  } finally {
    proxy.kill("SIGTERM");
    await new Promise<void>((resolvePromise) => proxy.once("exit", () => resolvePromise()));
  }
});

function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(port, "127.0.0.1");
    let response = "";
    socket.setTimeout(2_000);
    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("latin1");
      if (response.includes("\r\n\r\n")) socket.end();
    });
    socket.once("timeout", () => socket.destroy(new Error("Proxy request timed out.")));
    socket.once("error", reject);
    socket.once("close", () => resolvePromise(response));
  });
}

async function waitForTcp(
  port: number,
  child: ChildProcess,
  errors: () => string,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Proxy exited during startup. ${errors()}`);
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const socket = connect(port, "127.0.0.1");
        socket.once("connect", () => {
          socket.end();
          resolvePromise();
        });
        socket.once("error", reject);
      });
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
  }
  throw new Error(`Proxy startup timed out. ${errors()}`);
}

async function freeTcpPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP port assigned.");
  await closeServer(server);
  return address.port;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
}

function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
