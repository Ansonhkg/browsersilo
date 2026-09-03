import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  open,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { BrowserSiloError } from "../core/errors.js";
import type { Principal } from "../core/model.js";
import type { KeyManagementPort } from "../security/key-management.js";

const MAGIC = Buffer.from("BSAR1");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const LENGTH_BYTES = 4;
const MAX_HEADER_BYTES = 1024 * 1024;

export type ArtifactKind =
  | "upload"
  | "download"
  | "screenshot"
  | "pdf"
  | "har"
  | "trace"
  | "profile"
  | "recording"
  | "state"
  | "diff"
  | "domain-capture"
  | "console"
  | "network"
  | "other";

export const ARTIFACT_KINDS = [
  "upload", "download", "screenshot", "pdf", "har", "trace", "profile",
  "recording", "state", "diff", "domain-capture", "console", "network", "other",
] as const satisfies readonly ArtifactKind[];

export interface ArtifactMetadata {
  id: string;
  tenantId: string;
  ownerId: string;
  leaseId: string | null;
  profileId: string | null;
  kind: ArtifactKind;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: string;
  expiresAt: string | null;
  labels: Record<string, string>;
}

interface EnvelopeHeader {
  algorithm: "aes-256-gcm";
  artifactId: string;
  keyId: string;
  wrappedKey: string;
  iv: string;
}

export interface PutArtifactInput {
  principal: Principal;
  leaseId?: string | null;
  profileId?: string | null;
  kind: ArtifactKind;
  name: string;
  mimeType: string;
  sourcePath: string;
  retentionSeconds?: number | null;
  labels?: Record<string, string>;
}

export class EncryptedArtifactStore {
  readonly #directory: string;
  readonly #keys: KeyManagementPort;
  #defaultRetentionSeconds = 30 * 24 * 60 * 60;

  private constructor(directory: string, keys: KeyManagementPort) {
    this.#directory = directory;
    this.#keys = keys;
  }

  static async create(
    directory: string,
    keys: KeyManagementPort,
  ): Promise<EncryptedArtifactStore> {
    const resolved = resolve(directory);
    await mkdir(resolved, { recursive: true, mode: 0o700 });
    await chmod(resolved, 0o700);
    const store = new EncryptedArtifactStore(resolved, keys);
    try {
      const settings: unknown = JSON.parse(
        await readFile(join(resolved, "settings.json"), "utf8"),
      );
      if (
        settings && typeof settings === "object" && !Array.isArray(settings) &&
        Number.isSafeInteger((settings as Record<string, unknown>)["defaultRetentionSeconds"])
      ) {
        store.#setDefaultRetentionSeconds(
          Number((settings as Record<string, unknown>)["defaultRetentionSeconds"]),
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return store;
  }

  async put(input: PutArtifactInput): Promise<ArtifactMetadata> {
    const id = `artifact_${randomUUID()}`;
    const artifactDirectory = this.#artifactDirectory(id);
    await mkdir(artifactDirectory, { recursive: false, mode: 0o700 });
    const temporary = join(artifactDirectory, ".payload.enc.tmp");
    const destination = join(artifactDirectory, "payload.enc");
    const context = { profileId: id, purpose: "artifact" as const };
    const dataKey = await this.#keys.generateDataKey(context);
    const iv = randomBytes(IV_BYTES);
    const header: EnvelopeHeader = {
      algorithm: "aes-256-gcm",
      artifactId: id,
      keyId: dataKey.keyId,
      wrappedKey: dataKey.wrapped.toString("base64"),
      iv: iv.toString("base64"),
    };
    const encodedHeader = Buffer.from(JSON.stringify(header));
    if (encodedHeader.length > MAX_HEADER_BYTES) throw new Error("Artifact header is too large.");
    const headerLength = Buffer.alloc(LENGTH_BYTES);
    headerLength.writeUInt32BE(encodedHeader.length);
    await writeFile(temporary, Buffer.concat([MAGIC, headerLength, encodedHeader]), {
      mode: 0o600,
      flag: "wx",
    });
    const cipher = createCipheriv("aes-256-gcm", dataKey.plaintext, iv);
    cipher.setAAD(MAGIC);
    const hash = createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        createReadStream(input.sourcePath),
        meter,
        cipher,
        createWriteStream(temporary, { flags: "a", mode: 0o600 }),
      );
      await new Promise<void>((resolvePromise, reject) => {
        const stream = createWriteStream(temporary, { flags: "a", mode: 0o600 });
        stream.once("error", reject);
        stream.end(cipher.getAuthTag(), resolvePromise);
      });
      await rename(temporary, destination);
      const now = new Date();
      const retention = input.retentionSeconds === undefined
        ? this.#defaultRetentionSeconds
        : input.retentionSeconds;
      const metadata: ArtifactMetadata = {
        id,
        tenantId: input.principal.tenantId,
        ownerId: input.principal.principalId,
        leaseId: input.leaseId ?? null,
        profileId: input.profileId ?? null,
        kind: input.kind,
        name: safeName(input.name),
        mimeType: safeMime(input.mimeType),
        size,
        sha256: hash.digest("hex"),
        createdAt: now.toISOString(),
        expiresAt:
          retention === null || retention === undefined
            ? null
            : new Date(now.getTime() + retention * 1000).toISOString(),
        labels: cleanLabels(input.labels ?? {}),
      };
      await writeFile(
        join(artifactDirectory, "metadata.json"),
        `${JSON.stringify(metadata, null, 2)}\n`,
        { mode: 0o600, flag: "wx" },
      );
      return metadata;
    } catch (error) {
      await rm(artifactDirectory, { recursive: true, force: true });
      throw error;
    } finally {
      dataKey.plaintext.fill(0);
    }
  }

  async putBuffer(
    input: Omit<PutArtifactInput, "sourcePath">,
    data: Buffer,
  ): Promise<ArtifactMetadata> {
    const staging = join(this.#directory, `.upload-${randomUUID()}`);
    try {
      await writeFile(staging, data, { mode: 0o600, flag: "wx" });
      return await this.put({ ...input, sourcePath: staging });
    } finally {
      await rm(staging, { force: true });
    }
  }

  async list(
    principal: Principal,
    query: { kind?: ArtifactKind; leaseId?: string; profileId?: string; text?: string } = {},
  ): Promise<ArtifactMetadata[]> {
    await this.pruneExpired();
    const metadata = await this.#allMetadata();
    const text = query.text?.trim().toLowerCase();
    return metadata
      .filter((artifact) =>
        artifact.tenantId === principal.tenantId &&
        artifact.ownerId === principal.principalId &&
        (!query.kind || artifact.kind === query.kind) &&
        (!query.leaseId || artifact.leaseId === query.leaseId) &&
        (!query.profileId || artifact.profileId === query.profileId) &&
        (!text || `${artifact.name} ${artifact.kind} ${Object.values(artifact.labels).join(" ")}`.toLowerCase().includes(text)),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async adminList(): Promise<ArtifactMetadata[]> {
    await this.pruneExpired();
    return (await this.#allMetadata()).sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  }

  async setDefaultRetentionSeconds(value: number): Promise<void> {
    this.#setDefaultRetentionSeconds(value);
    const temporary = join(this.#directory, `.settings-${randomUUID()}.tmp`);
    await writeFile(
      temporary,
      `${JSON.stringify({ defaultRetentionSeconds: value }, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    await rename(temporary, join(this.#directory, "settings.json"));
  }

  #setDefaultRetentionSeconds(value: number): void {
    if (!Number.isSafeInteger(value) || value < 60 || value > 365 * 24 * 60 * 60) {
      throw new BrowserSiloError(
        "INVALID_REQUEST",
        "Artifact retention must be between 60 seconds and 365 days.",
        400,
      );
    }
    this.#defaultRetentionSeconds = value;
  }

  get defaultRetentionSeconds(): number {
    return this.#defaultRetentionSeconds;
  }

  async get(principal: Principal, artifactId: string): Promise<ArtifactMetadata> {
    const metadata = await this.#readMetadata(artifactId);
    if (
      metadata.tenantId !== principal.tenantId ||
      metadata.ownerId !== principal.principalId
    ) {
      throw new BrowserSiloError("NOT_FOUND", "Artifact not found.", 404);
    }
    return metadata;
  }

  async exportTo(
    principal: Principal,
    artifactId: string,
    destination: string,
  ): Promise<ArtifactMetadata> {
    const metadata = await this.get(principal, artifactId);
    const envelope = await this.#envelope(artifactId);
    const dataKey = await this.#keys.unwrapDataKey(
      Buffer.from(envelope.header.wrappedKey, "base64"),
      envelope.header.keyId,
      { profileId: artifactId, purpose: "artifact" },
    );
    const decipher = createDecipheriv(
      "aes-256-gcm",
      dataKey,
      Buffer.from(envelope.header.iv, "base64"),
    );
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(envelope.tag);
    try {
      await pipeline(
        createReadStream(join(this.#artifactDirectory(artifactId), "payload.enc"), {
          start: envelope.ciphertextStart,
          end: envelope.ciphertextEnd,
        }),
        decipher,
        createWriteStream(destination, { mode: 0o600, flags: "wx" }),
      );
      return metadata;
    } finally {
      dataKey.fill(0);
    }
  }

  async adminExportTo(
    artifactId: string,
    destination: string,
  ): Promise<ArtifactMetadata> {
    const metadata = await this.#readMetadata(artifactId);
    return this.exportTo(
      {
        tenantId: metadata.tenantId,
        principalId: metadata.ownerId,
        kind: "service",
      },
      artifactId,
      destination,
    );
  }

  async readBuffer(principal: Principal, artifactId: string): Promise<Buffer> {
    const staging = join(this.#directory, `.read-${randomUUID()}`);
    try {
      await this.exportTo(principal, artifactId, staging);
      return await readFile(staging);
    } finally {
      await rm(staging, { force: true });
    }
  }

  async delete(principal: Principal, artifactId: string): Promise<void> {
    await this.get(principal, artifactId);
    await rm(this.#artifactDirectory(artifactId), { recursive: true, force: true });
  }

  async pruneExpired(now = new Date()): Promise<string[]> {
    const removed: string[] = [];
    for (const metadata of await this.#allMetadata()) {
      if (metadata.expiresAt && new Date(metadata.expiresAt) <= now) {
        await rm(this.#artifactDirectory(metadata.id), { recursive: true, force: true });
        removed.push(metadata.id);
      }
    }
    return removed;
  }

  async #allMetadata(): Promise<ArtifactMetadata[]> {
    const entries = await readdir(this.#directory, { withFileTypes: true });
    const values = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("artifact_"))
        .map((entry) => this.#readMetadata(entry.name).catch(() => null)),
    );
    return values.filter((value): value is ArtifactMetadata => value !== null);
  }

  async #readMetadata(artifactId: string): Promise<ArtifactMetadata> {
    safeId(artifactId);
    try {
      const value: unknown = JSON.parse(
        await readFile(join(this.#artifactDirectory(artifactId), "metadata.json"), "utf8"),
      );
      return validateMetadata(value, artifactId);
    } catch (error) {
      if (error instanceof BrowserSiloError) throw error;
      throw new BrowserSiloError("NOT_FOUND", "Artifact not found.", 404, { artifactId });
    }
  }

  async #envelope(artifactId: string): Promise<{
    header: EnvelopeHeader;
    ciphertextStart: number;
    ciphertextEnd: number;
    tag: Buffer;
  }> {
    const path = join(this.#artifactDirectory(artifactId), "payload.enc");
    const handle = await open(path, "r");
    try {
      const prefix = Buffer.alloc(MAGIC.length + LENGTH_BYTES);
      const prefixRead = await handle.read(prefix, 0, prefix.length, 0);
      if (prefixRead.bytesRead !== prefix.length || !prefix.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw invalidArtifact();
      }
      const headerLength = prefix.readUInt32BE(MAGIC.length);
      if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) throw invalidArtifact();
      const headerStart = MAGIC.length + LENGTH_BYTES;
      const encodedHeader = Buffer.alloc(headerLength);
      const headerRead = await handle.read(encodedHeader, 0, headerLength, headerStart);
      if (headerRead.bytesRead !== headerLength) throw invalidArtifact();
      const header = JSON.parse(encodedHeader.toString("utf8")) as EnvelopeHeader;
      if (
        header.algorithm !== "aes-256-gcm" ||
        header.artifactId !== artifactId ||
        typeof header.keyId !== "string" ||
        typeof header.wrappedKey !== "string" ||
        typeof header.iv !== "string"
      ) throw invalidArtifact();
      const fileSize = (await handle.stat()).size;
      const ciphertextStart = headerStart + headerLength;
      const ciphertextEnd = fileSize - TAG_BYTES - 1;
      if (ciphertextEnd < ciphertextStart) throw invalidArtifact();
      const tag = Buffer.alloc(TAG_BYTES);
      const tagRead = await handle.read(tag, 0, TAG_BYTES, fileSize - TAG_BYTES);
      if (tagRead.bytesRead !== TAG_BYTES) throw invalidArtifact();
      return { header, ciphertextStart, ciphertextEnd, tag };
    } finally {
      await handle.close();
    }
  }

  #artifactDirectory(artifactId: string): string {
    return join(this.#directory, safeId(artifactId));
  }
}

function validateMetadata(value: unknown, artifactId: string): ArtifactMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidArtifact();
  const item = value as Record<string, unknown>;
  if (
    item["id"] !== artifactId ||
    typeof item["tenantId"] !== "string" ||
    typeof item["ownerId"] !== "string" ||
    typeof item["kind"] !== "string" ||
    typeof item["name"] !== "string" ||
    typeof item["mimeType"] !== "string" ||
    typeof item["size"] !== "number" ||
    typeof item["sha256"] !== "string" ||
    typeof item["createdAt"] !== "string"
  ) throw invalidArtifact();
  return item as unknown as ArtifactMetadata;
}

function safeId(value: string): string {
  if (!/^artifact_[a-f0-9-]+$/.test(value)) {
    throw new BrowserSiloError("INVALID_REQUEST", "Artifact id is invalid.", 400);
  }
  return value;
}

function safeName(value: string): string {
  const name = value.replace(/[\u0000-\u001f/\\]/g, "_").trim().slice(0, 240);
  return name || "artifact.bin";
}

function safeMime(value: string): string {
  return /^[\w.+-]+\/[\w.+-]+$/.test(value) ? value : "application/octet-stream";
}

function cleanLabels(labels: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(labels)
      .slice(0, 32)
      .map(([key, value]) => [key.slice(0, 64), value.slice(0, 256)]),
  );
}

function invalidArtifact(): BrowserSiloError {
  return new BrowserSiloError("INVALID_REQUEST", "Encrypted artifact is invalid or tampered.", 400);
}
