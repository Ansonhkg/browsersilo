import { spawn, execFile } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { BrowserSiloError } from "../core/errors.js";
import {
  LocalKeyManagement,
  type KeyManagementPort,
} from "../security/key-management.js";

const execFileAsync = promisify(execFile);
const LEGACY_MAGIC = Buffer.from("BSLP1");
const STREAM_MAGIC = Buffer.from("BSLP2");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_LENGTH_BYTES = 4;
const MAX_HEADER_BYTES = 1024 * 1024;

interface StreamEnvelopeMetadata {
  algorithm: "aes-256-gcm";
  keyId: string;
  keyProvider: "local" | "aws-kms";
  profileId?: string;
  wrappedKey: string;
  iv: string;
  createdAt: string;
}

interface StreamEnvelope {
  metadata: StreamEnvelopeMetadata;
  header: Buffer;
  ciphertextStart: number;
  ciphertextEnd: number;
  tag: Buffer;
}

export interface LocalEncryptedProfileStoreOptions {
  dataDirectory: string;
  keyBase64?: string;
  keyManagement?: KeyManagementPort;
}

export class LocalEncryptedProfileStore {
  readonly #dataDirectory: string;
  readonly #profilesDirectory: string;
  readonly #runtimeDirectory: string;
  readonly #keys: KeyManagementPort;
  readonly #legacyKey: Buffer | null;

  private constructor(
    dataDirectory: string,
    keys: KeyManagementPort,
    legacyKey: Buffer | null,
  ) {
    this.#dataDirectory = dataDirectory;
    this.#profilesDirectory = join(dataDirectory, "profiles");
    this.#runtimeDirectory = join(dataDirectory, "runtime");
    this.#keys = keys;
    this.#legacyKey = legacyKey;
  }

  static async create(
    options: LocalEncryptedProfileStoreOptions,
  ): Promise<LocalEncryptedProfileStore> {
    const dataDirectory = resolve(options.dataDirectory);
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    await chmod(dataDirectory, 0o700);
    let legacyKey: Buffer | null = null;
    let keys = options.keyManagement;
    if (!keys) {
      legacyKey = options.keyBase64
        ? decodeKey(options.keyBase64)
        : await loadOrCreateDevelopmentKey(dataDirectory);
      keys = new LocalKeyManagement(legacyKey);
    }
    const store = new LocalEncryptedProfileStore(
      dataDirectory,
      keys,
      legacyKey,
    );
    await mkdir(store.#profilesDirectory, { recursive: true, mode: 0o700 });
    await mkdir(store.#runtimeDirectory, { recursive: true, mode: 0o700 });
    return store;
  }

  async materialize(profileId: string, workerId: string): Promise<string> {
    const runtimeProfile = this.#runtimeProfile(workerId);
    await rm(runtimeProfile, { recursive: true, force: true });
    await mkdir(runtimeProfile, { recursive: true, mode: 0o700 });
    const archivePath = this.#archivePath(profileId);
    if (!(await exists(archivePath))) return runtimeProfile;

    const temporaryTar = join(
      this.#runtimeDirectory,
      `.materialize-${randomUUID()}.tar`,
    );
    try {
      const magic = await readMagic(archivePath);
      if (magic.equals(STREAM_MAGIC)) {
        await this.#decryptStreamArchive(profileId, archivePath, temporaryTar);
      } else if (magic.equals(LEGACY_MAGIC) && this.#legacyKey) {
        const encrypted = await readFile(archivePath);
        await writeFile(
          temporaryTar,
          decryptLegacyArchive(encrypted, this.#legacyKey),
          { mode: 0o600 },
        );
      } else {
        throw invalidArchive("The encrypted browser profile has an unsupported envelope.");
      }
      const { stdout } = await execFileAsync("tar", ["-tf", temporaryTar]);
      validateTarEntries(stdout.split("\n").filter(Boolean));
      await execFileAsync("tar", ["-xf", temporaryTar, "-C", runtimeProfile]);
    } catch (error) {
      await rm(runtimeProfile, { recursive: true, force: true });
      throw normalizeArchiveError(error);
    } finally {
      await rm(temporaryTar, { force: true });
    }
    return runtimeProfile;
  }

  async commit(profileId: string, workerId: string): Promise<void> {
    const runtimeProfile = this.#runtimeProfile(workerId);
    if (!(await exists(runtimeProfile))) {
      throw new BrowserSiloError(
        "BROWSER_COMMAND_FAILED",
        "The materialized browser profile is missing during commit.",
        500,
        { profileId, workerId },
      );
    }
    await removeTransientLocks(runtimeProfile);
    const profileDirectory = join(this.#profilesDirectory, safeId(profileId));
    await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
    const temporaryArchive = join(
      profileDirectory,
      `.profile-${randomUUID()}.enc`,
    );
    let committed = false;
    try {
      await this.#encryptStreamArchive(
        profileId,
        runtimeProfile,
        temporaryArchive,
      );
      await rename(temporaryArchive, this.#archivePath(profileId));
      await chmod(this.#archivePath(profileId), 0o600);
      committed = true;
    } finally {
      await rm(temporaryArchive, { force: true });
      if (committed) {
        await rm(runtimeProfile, { recursive: true, force: true });
      }
    }
  }

  async discard(workerId: string): Promise<void> {
    await rm(this.#runtimeProfile(workerId), { recursive: true, force: true });
  }

  async archiveExists(profileId: string): Promise<boolean> {
    return exists(this.#archivePath(profileId));
  }

  async exportArchive(profileId: string, destination: string): Promise<void> {
    const source = this.#archivePath(profileId);
    if (!(await exists(source))) {
      throw new BrowserSiloError(
        "NOT_FOUND",
        "The browser profile has no committed archive.",
        404,
        { profileId },
      );
    }
    await copyFile(source, destination);
    await chmod(destination, 0o600);
  }

  async importArchive(profileId: string, source: string): Promise<void> {
    if (!(await exists(source))) {
      throw new BrowserSiloError("NOT_FOUND", "The profile import was not found.", 404);
    }
    const magic = await readMagic(source);
    if (!magic.equals(STREAM_MAGIC)) {
      throw invalidArchive("Only streaming BSLP2 profile exports can be imported.");
    }
    const envelope = await readStreamEnvelope(source);
    const sourceProfileId = envelope.metadata.profileId ?? profileId;
    safeId(sourceProfileId);
    const importWorker = `import_${randomUUID().replaceAll("-", "")}`;
    const runtimeProfile = this.#runtimeProfile(importWorker);
    const temporaryTar = join(this.#runtimeDirectory, `.import-${randomUUID()}.tar`);
    try {
      await mkdir(runtimeProfile, { recursive: true, mode: 0o700 });
      await this.#decryptStreamArchive(sourceProfileId, source, temporaryTar);
      const { stdout } = await execFileAsync("tar", ["-tf", temporaryTar]);
      validateTarEntries(stdout.split("\n").filter(Boolean));
      await execFileAsync("tar", ["-xf", temporaryTar, "-C", runtimeProfile]);
      await this.commit(profileId, importWorker);
    } finally {
      await rm(temporaryTar, { force: true });
      await rm(join(this.#runtimeDirectory, importWorker), {
        recursive: true,
        force: true,
      });
    }
  }

  async rotateArchive(profileId: string): Promise<void> {
    if (!(await this.archiveExists(profileId))) return;
    const rotationWorker = `rotate_${randomUUID().replaceAll("-", "")}`;
    try {
      await this.materialize(profileId, rotationWorker);
      await this.commit(profileId, rotationWorker);
    } finally {
      await rm(join(this.#runtimeDirectory, rotationWorker), {
        recursive: true,
        force: true,
      });
    }
  }

  async pruneArchives(retainProfileIds: Set<string>): Promise<string[]> {
    const removed: string[] = [];
    for (const profileId of await readdir(this.#profilesDirectory)) {
      if (!/^[a-zA-Z0-9_-]+$/.test(profileId) || retainProfileIds.has(profileId)) continue;
      await this.deleteArchive(profileId);
      removed.push(profileId);
    }
    return removed;
  }

  async deleteArchive(profileId: string): Promise<void> {
    await rm(join(this.#profilesDirectory, safeId(profileId)), {
      recursive: true,
      force: true,
    });
  }

  get dataDirectory(): string {
    return this.#dataDirectory;
  }

  get keyProvider(): string {
    return this.#keys.provider;
  }

  get keyManagement(): KeyManagementPort {
    return this.#keys;
  }

  async #encryptStreamArchive(
    profileId: string,
    runtimeProfile: string,
    destination: string,
  ): Promise<void> {
    const context = { profileId, purpose: "browser-profile" as const };
    const dataKey = await this.#keys.generateDataKey(context);
    const iv = randomBytes(IV_BYTES);
    const metadata: StreamEnvelopeMetadata = {
      algorithm: "aes-256-gcm",
      keyId: dataKey.keyId,
      keyProvider: this.#keys.provider,
      profileId,
      wrappedKey: dataKey.wrapped.toString("base64"),
      iv: iv.toString("base64"),
      createdAt: new Date().toISOString(),
    };
    const header = encodeHeader(metadata);
    await writeFile(destination, header, { mode: 0o600, flag: "wx" });
    const cipher = createCipheriv("aes-256-gcm", dataKey.plaintext, iv);
    cipher.setAAD(STREAM_MAGIC);
    const tar = spawn("tar", ["-cf", "-", "-C", runtimeProfile, "."], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await Promise.all([
        pipeline(
          tar.stdout,
          cipher,
          createWriteStream(destination, { flags: "a", mode: 0o600 }),
        ),
        waitForProcess(tar, "tar profile archive"),
      ]);
      await appendFile(destination, cipher.getAuthTag());
    } finally {
      dataKey.plaintext.fill(0);
    }
  }

  async #decryptStreamArchive(
    profileId: string,
    archivePath: string,
    destinationTar: string,
  ): Promise<void> {
    const envelope = await readStreamEnvelope(archivePath);
    const dataKey = await this.#keys.unwrapDataKey(
      Buffer.from(envelope.metadata.wrappedKey, "base64"),
      envelope.metadata.keyId,
      { profileId, purpose: "browser-profile" },
    );
    const iv = Buffer.from(envelope.metadata.iv, "base64");
    if (iv.length !== IV_BYTES) throw invalidArchive("Profile IV is invalid.");
    const decipher = createDecipheriv("aes-256-gcm", dataKey, iv);
    decipher.setAAD(STREAM_MAGIC);
    decipher.setAuthTag(envelope.tag);
    try {
      await pipeline(
        createReadStream(archivePath, {
          start: envelope.ciphertextStart,
          end: envelope.ciphertextEnd,
        }),
        decipher,
        createWriteStream(destinationTar, { flags: "wx", mode: 0o600 }),
      );
    } finally {
      dataKey.fill(0);
    }
  }

  #runtimeProfile(workerId: string): string {
    return join(this.#runtimeDirectory, safeId(workerId), "profile");
  }

  #archivePath(profileId: string): string {
    return join(this.#profilesDirectory, safeId(profileId), "profile.enc");
  }
}

function encodeHeader(metadata: StreamEnvelopeMetadata): Buffer {
  const encoded = Buffer.from(JSON.stringify(metadata));
  if (encoded.length > MAX_HEADER_BYTES) throw new Error("Profile header is too large.");
  const length = Buffer.alloc(HEADER_LENGTH_BYTES);
  length.writeUInt32BE(encoded.length);
  return Buffer.concat([STREAM_MAGIC, length, encoded]);
}

async function readStreamEnvelope(path: string): Promise<StreamEnvelope> {
  const handle = await open(path, "r");
  try {
    const prefix = Buffer.alloc(STREAM_MAGIC.length + HEADER_LENGTH_BYTES);
    await handle.read(prefix, 0, prefix.length, 0);
    if (!prefix.subarray(0, STREAM_MAGIC.length).equals(STREAM_MAGIC)) {
      throw invalidArchive("Profile stream envelope is invalid.");
    }
    const metadataLength = prefix.readUInt32BE(STREAM_MAGIC.length);
    if (metadataLength < 2 || metadataLength > MAX_HEADER_BYTES) {
      throw invalidArchive("Profile stream header length is invalid.");
    }
    const metadataBytes = Buffer.alloc(metadataLength);
    await handle.read(metadataBytes, 0, metadataLength, prefix.length);
    const metadata = validateMetadata(
      JSON.parse(metadataBytes.toString("utf8")) as unknown,
    );
    const size = (await handle.stat()).size;
    const ciphertextStart = prefix.length + metadataLength;
    const ciphertextEnd = size - TAG_BYTES - 1;
    if (ciphertextEnd < ciphertextStart) {
      throw invalidArchive("Profile ciphertext is missing.");
    }
    const tag = Buffer.alloc(TAG_BYTES);
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
    return {
      metadata,
      header: Buffer.concat([prefix, metadataBytes]),
      ciphertextStart,
      ciphertextEnd,
      tag,
    };
  } catch (error) {
    throw normalizeArchiveError(error);
  } finally {
    await handle.close();
  }
}

function validateMetadata(value: unknown): StreamEnvelopeMetadata {
  if (!value || typeof value !== "object") throw invalidArchive("Profile metadata is invalid.");
  const metadata = value as Record<string, unknown>;
  if (
    metadata["algorithm"] !== "aes-256-gcm" ||
    typeof metadata["keyId"] !== "string" ||
    !["local", "aws-kms"].includes(String(metadata["keyProvider"])) ||
    typeof metadata["wrappedKey"] !== "string" ||
    typeof metadata["iv"] !== "string" ||
    typeof metadata["createdAt"] !== "string"
  ) {
    throw invalidArchive("Profile metadata fields are invalid.");
  }
  if (metadata["profileId"] !== undefined && typeof metadata["profileId"] !== "string") {
    throw invalidArchive("Profile metadata identity is invalid.");
  }
  return metadata as unknown as StreamEnvelopeMetadata;
}

function decryptLegacyArchive(payload: Buffer, key: Buffer): Buffer {
  const minimum = LEGACY_MAGIC.length + IV_BYTES + TAG_BYTES;
  if (
    payload.length < minimum ||
    !payload.subarray(0, LEGACY_MAGIC.length).equals(LEGACY_MAGIC)
  ) {
    throw invalidArchive("The legacy profile has an invalid envelope.");
  }
  const ivStart = LEGACY_MAGIC.length;
  const tagStart = ivStart + IV_BYTES;
  const ciphertextStart = tagStart + TAG_BYTES;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    payload.subarray(ivStart, tagStart),
  );
  decipher.setAuthTag(payload.subarray(tagStart, ciphertextStart));
  return Buffer.concat([
    decipher.update(payload.subarray(ciphertextStart)),
    decipher.final(),
  ]);
}

async function readMagic(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const magic = Buffer.alloc(STREAM_MAGIC.length);
    await handle.read(magic, 0, magic.length, 0);
    return magic;
  } finally {
    await handle.close();
  }
}

async function waitForProcess(
  process: ReturnType<typeof spawn>,
  description: string,
): Promise<void> {
  let stderr = "";
  process.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
  });
  await new Promise<void>((resolvePromise, reject) => {
    process.once("error", reject);
    process.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${description} failed (${code ?? signal}): ${stderr}`));
    });
  });
}

async function loadOrCreateDevelopmentKey(dataDirectory: string): Promise<Buffer> {
  const keyPath = join(dataDirectory, "dev-master.key");
  try {
    return decodeKey((await readFile(keyPath, "utf8")).trim());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const key = randomBytes(32);
  try {
    await writeFile(keyPath, key.toString("base64"), {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return decodeKey((await readFile(keyPath, "utf8")).trim());
  }
  await chmod(keyPath, 0o600);
  return key;
}

function decodeKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("BROWSERSILO_DATA_KEY must be a base64-encoded 32-byte key.");
  }
  return key;
}

function validateTarEntries(entries: string[]): void {
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    const parts = normalized.split("/");
    if (
      normalized.startsWith("/") ||
      parts.includes("..") ||
      normalized.includes(`..${sep}`)
    ) {
      throw invalidArchive("The encrypted profile contains an unsafe archive path.");
    }
  }
}

async function removeTransientLocks(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    if (name.startsWith("Singleton")) {
      await rm(join(directory, name), { recursive: true, force: true });
    }
  }
}

function safeId(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error("Unsafe BrowserSilo resource identifier.");
  }
  return value;
}

function invalidArchive(message: string): BrowserSiloError {
  return new BrowserSiloError("BROWSER_COMMAND_FAILED", message, 500);
}

function normalizeArchiveError(error: unknown): BrowserSiloError {
  if (error instanceof BrowserSiloError) return error;
  return new BrowserSiloError(
    "BROWSER_COMMAND_FAILED",
    "The encrypted browser profile failed authentication or extraction.",
    500,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
