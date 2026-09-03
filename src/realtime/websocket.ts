import { createHash } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import { BrowserSiloError } from "../core/errors.js";
import type { Principal } from "../core/model.js";
import type { BrowserGatewayService } from "../browser/gateway.js";

export interface LiveWebSocketOptions {
  allowedOrigins?: string[];
  frameIntervalMs?: number;
  maximumBufferedBytes?: number;
}

export function attachLiveWebSocket(
  server: Server,
  gateway: BrowserGatewayService,
  options: LiveWebSocketOptions = {},
): () => void {
  const sockets = new Set<Socket>();
  const onUpgrade = (
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ) => {
    void acceptLiveSocket(request, socket, head, gateway, options).catch((error) => {
      writeUpgradeError(socket, error);
    });
  };
  server.on("upgrade", onUpgrade);
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return () => {
    server.off("upgrade", onUpgrade);
    for (const socket of sockets) socket.destroy();
  };
}

async function acceptLiveSocket(
  request: IncomingMessage,
  socket: Socket,
  head: Buffer,
  gateway: BrowserGatewayService,
  options: LiveWebSocketOptions,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://browsesilo.local");
  const match = url.pathname.match(/^\/v1\/browsers\/([^/]+)\/live$/);
  if (!match?.[1]) {
    throw new BrowserSiloError("NOT_FOUND", "Live browser route not found.", 404);
  }
  if (request.headers.upgrade?.toLowerCase() !== "websocket") {
    throw new BrowserSiloError("INVALID_REQUEST", "A WebSocket upgrade is required.", 400);
  }
  validateOrigin(request, options.allowedOrigins ?? []);
  const token = url.searchParams.get("token");
  if (!token) {
    throw new BrowserSiloError("UNAUTHENTICATED", "A live browser credential is required.", 401);
  }
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    throw new BrowserSiloError("INVALID_REQUEST", "The WebSocket key is missing.", 400);
  }
  const browserId = match[1];
  const { principal, role } = gateway.principalFromLiveToken(token, browserId);
  await gateway.get(principal, browserId);
  const connectionId = gateway.takeover.connectionId();
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  const requestedProtocols = String(request.headers["sec-websocket-protocol"] ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  if (requestedProtocols.length > 0 && !requestedProtocols.includes("browsersilo.v1")) {
    throw new BrowserSiloError("INVALID_REQUEST", "The browsersilo.v1 WebSocket protocol is required.", 400);
  }
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    ...(requestedProtocols.includes("browsersilo.v1")
      ? ["Sec-WebSocket-Protocol: browsersilo.v1"]
      : []),
    "\r\n",
  ].join("\r\n"));

  let closed = false;
  let sequence = 0;
  let sendingFrame = false;
  let rateWindowStartedAt = Date.now();
  let messagesInWindow = 0;
  const decoder = new ClientFrameDecoder();
  const closeSocket = () => {
    if (closed) return;
    closed = true;
    if (gateway.takeover.end(browserId, connectionId)) {
      gateway.events.emit(browserId, "takeover.ended", { reason: "connection-closed" });
    }
    socket.destroy();
  };
  socket.once("close", closeSocket);
  socket.once("error", closeSocket);
  socket.on("data", (chunk: Buffer) => {
    try {
      for (const frame of decoder.push(chunk)) {
        if (frame.opcode === 0x8) {
          sendFrame(socket, 0x8, Buffer.alloc(0));
          closeSocket();
          return;
        }
        if (frame.opcode === 0x9) {
          sendFrame(socket, 0xa, frame.payload);
          continue;
        }
        if (frame.opcode !== 0x1) continue;
        const now = Date.now();
        if (now - rateWindowStartedAt >= 1_000) {
          rateWindowStartedAt = now;
          messagesInWindow = 0;
        }
        messagesInWindow += 1;
        if (messagesInWindow > 100) {
          sendJson(socket, { type: "error", code: "RATE_LIMITED", message: "Live input rate exceeded." });
          continue;
        }
        const message = JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown>;
        void handleLiveMessage(
          gateway,
          principal,
          browserId,
          connectionId,
          role,
          message,
          socket,
        ).catch((error) => {
          const safe = error instanceof BrowserSiloError
            ? { code: error.code, message: error.message }
            : { code: "LIVE_INPUT_FAILED", message: "The live input operation failed." };
          sendJson(socket, { type: "error", ...safe });
        });
      }
    } catch {
      sendJson(socket, { type: "error", code: "INVALID_MESSAGE", message: "The WebSocket message is invalid." });
    }
  });
  if (head.length > 0) socket.emit("data", head);
  sendJson(socket, {
    type: "browser.ready",
    browserId,
    role,
    protocol: "browsersilo.v1",
    connectionId,
  });

  const timer = setInterval(() => {
    if (closed || sendingFrame) return;
    const maximumBufferedBytes = options.maximumBufferedBytes ?? 1024 * 1024;
    if (socket.writableLength > maximumBufferedBytes) return;
    sendingFrame = true;
    void gateway.screenshot(principal, browserId, { fullPage: false }).then((screenshot) => {
      if (closed) return;
      const frame = Buffer.from(screenshot.data, "base64");
      sequence += 1;
      sendJson(socket, {
        type: "frame",
        sequence,
        mimeType: screenshot.mimeType,
        byteLength: frame.length,
      });
      sendFrame(socket, 0x2, frame);
    }).catch((error) => {
      sendJson(socket, {
        type: "warning",
        code: error instanceof BrowserSiloError ? error.code : "FRAME_FAILED",
        message: "The next browser frame could not be captured.",
      });
    }).finally(() => {
      sendingFrame = false;
    });
  }, options.frameIntervalMs ?? 100);
  socket.once("close", () => clearInterval(timer));
}

async function handleLiveMessage(
  gateway: BrowserGatewayService,
  principal: Principal,
  browserId: string,
  connectionId: string,
  role: "observe" | "assist" | "takeover",
  message: Record<string, unknown>,
  socket: Socket,
): Promise<void> {
  const type = message["type"];
  if (type === "takeover.request") {
    if (role !== "takeover") {
      throw new BrowserSiloError("FORBIDDEN", "This connection cannot take over browser input.", 403);
    }
    gateway.takeover.begin(browserId, connectionId);
    gateway.events.emit(browserId, "takeover.started", { connectionId });
    sendJson(socket, { type: "takeover.started", connectionId });
    return;
  }
  if (type === "takeover.release") {
    gateway.takeover.assertController(browserId, connectionId);
    gateway.takeover.end(browserId, connectionId);
    gateway.events.emit(browserId, "takeover.ended", { reason: "returned" });
    sendJson(socket, { type: "takeover.ended", refreshSnapshot: true });
    return;
  }
  if (type === "input.keyboard" || type === "input.pointer") {
    if (role === "observe") {
      throw new BrowserSiloError("FORBIDDEN", "This connection is read-only.", 403);
    }
    if (role === "assist") {
      gateway.takeover.begin(browserId, connectionId, 30);
    }
    await gateway.input(principal, browserId, connectionId, message);
    sendJson(socket, { type: "input.accepted", inputType: type });
    return;
  }
  if (type === "ping") {
    sendJson(socket, { type: "pong", at: new Date().toISOString() });
    return;
  }
  throw new BrowserSiloError("INVALID_REQUEST", "The live message type is unsupported.", 400);
}

function validateOrigin(request: IncomingMessage, allowedOrigins: string[]): void {
  const origin = request.headers.origin;
  if (!origin) return;
  if (allowedOrigins.includes(origin)) return;
  try {
    const originUrl = new URL(origin);
    const host = request.headers.host?.split(":")[0];
    if (host && originUrl.hostname === host) return;
  } catch {
    // Rejected below.
  }
  throw new BrowserSiloError("FORBIDDEN", "The WebSocket origin is not allowed.", 403);
}

function sendJson(socket: Socket, value: Record<string, unknown>): void {
  sendFrame(socket, 0x1, Buffer.from(JSON.stringify(value)));
}

function sendFrame(socket: Socket, opcode: number, payload: Buffer): void {
  if (socket.destroyed) return;
  const first = 0x80 | opcode;
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([first, payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = first;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = first;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

interface DecodedFrame {
  opcode: number;
  payload: Buffer;
}

class ClientFrameDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Buffer): DecodedFrame[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const frames: DecodedFrame[] = [];
    while (this.#buffer.length >= 2) {
      const first = this.#buffer[0]!;
      const second = this.#buffer[1]!;
      const final = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      if (!final || !masked) throw new Error("Unsupported WebSocket frame.");
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.#buffer.length < 4) break;
        length = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) break;
        const largeLength = this.#buffer.readBigUInt64BE(2);
        if (largeLength > BigInt(1024 * 1024)) throw new Error("WebSocket frame too large.");
        length = Number(largeLength);
        offset = 10;
      }
      if (length > 1024 * 1024) throw new Error("WebSocket frame too large.");
      const total = offset + 4 + length;
      if (this.#buffer.length < total) break;
      const mask = this.#buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.#buffer.subarray(offset + 4, total));
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = payload[index]! ^ mask[index % 4]!;
      }
      frames.push({ opcode, payload });
      this.#buffer = this.#buffer.subarray(total);
    }
    return frames;
  }
}

function writeUpgradeError(socket: Socket, error: unknown): void {
  if (socket.destroyed) return;
  const status = error instanceof BrowserSiloError ? error.status : 500;
  const message = error instanceof BrowserSiloError ? error.message : "The WebSocket upgrade failed.";
  const body = JSON.stringify({ error: { code: error instanceof BrowserSiloError ? error.code : "INTERNAL_ERROR", message } });
  socket.end([
    `HTTP/1.1 ${status} ${statusText(status)}`,
    "Connection: close",
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n"));
}

function statusText(status: number): string {
  if (status === 400) return "Bad Request";
  if (status === 401) return "Unauthorized";
  if (status === 403) return "Forbidden";
  if (status === 404) return "Not Found";
  return "Internal Server Error";
}
