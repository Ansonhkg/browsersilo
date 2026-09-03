import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export interface DockerExecutor {
  command(args: string[]): Promise<string>;
  input(args: string[], sourcePath: string): Promise<void>;
  output(args: string[], destination: string): Promise<void>;
}

export class RemoteDockerExecutor implements DockerExecutor {
  readonly #baseUrl: string;
  readonly #token: string;

  constructor(baseUrl: string, token: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#token = token;
  }

  async command(args: string[]): Promise<string> {
    const response = await fetch(`${this.#baseUrl}/internal/v1/docker/command`, {
      method: "POST",
      headers: this.#headers({ "content-type": "application/json" }),
      body: JSON.stringify({ args }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw await managerError(response);
    return response.text();
  }

  async input(args: string[], sourcePath: string): Promise<void> {
    const response = await fetch(`${this.#baseUrl}/internal/v1/docker/input`, {
      method: "POST",
      headers: this.#headers({ "x-browsersilo-docker-args": encodeArgs(args) }),
      body: Readable.toWeb(createReadStream(sourcePath)) as ReadableStream,
      duplex: "half",
      signal: AbortSignal.timeout(120_000),
    } as RequestInit & { duplex: "half" });
    if (!response.ok) throw await managerError(response);
  }

  async output(args: string[], destination: string): Promise<void> {
    const response = await fetch(`${this.#baseUrl}/internal/v1/docker/output`, {
      method: "POST",
      headers: this.#headers({ "content-type": "application/json" }),
      body: JSON.stringify({ args }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw await managerError(response);
    if (!response.body) throw new Error("Worker manager returned no output stream.");
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      createWriteStream(destination, { mode: 0o600 }),
    );
  }

  #headers(additional: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${this.#token}`, ...additional };
  }
}

export function encodeArgs(args: string[]): string {
  return Buffer.from(JSON.stringify(args)).toString("base64url");
}

export function decodeArgs(value: string | undefined): string[] {
  if (!value) throw new Error("Docker arguments are required.");
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("Docker arguments are invalid.");
  }
  return parsed;
}

async function managerError(response: Response): Promise<Error> {
  const value = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return new Error(value?.error?.message ?? `Worker manager returned HTTP ${response.status}.`);
}
