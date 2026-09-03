import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { BrowserSiloError } from "../core/errors.js";

export interface OperatorSettings {
  workerAdapter: "memory" | "docker";
  workerImage: string;
  kmsProvider: "local" | "aws-kms";
  awsKmsKeyId: string | null;
  seccompProfile: string;
  workerMemoryBytes: number;
  workerCpus: number;
  workerPidsLimit: number;
}

export class OperatorSettingsStore {
  readonly #path: string;
  #settings: OperatorSettings;

  private constructor(path: string, settings: OperatorSettings) {
    this.#path = path;
    this.#settings = settings;
  }

  static async create(path: string, defaults: OperatorSettings): Promise<OperatorSettingsStore> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let settings = structuredClone(defaults);
    try {
      settings = validateSettings(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const store = new OperatorSettingsStore(path, settings);
    await store.#persist();
    return store;
  }

  get current(): OperatorSettings {
    return structuredClone(this.#settings);
  }

  async update(input: Record<string, unknown>): Promise<OperatorSettings> {
    const allowed = new Set<keyof OperatorSettings>([
      "workerAdapter", "workerImage", "kmsProvider", "awsKmsKeyId",
      "seccompProfile", "workerMemoryBytes", "workerCpus", "workerPidsLimit",
    ]);
    for (const key of Object.keys(input)) {
      if (!allowed.has(key as keyof OperatorSettings)) {
        throw new BrowserSiloError("INVALID_REQUEST", `Unknown operator setting: ${key}.`, 400);
      }
    }
    const next = validateSettings({ ...this.#settings, ...input });
    this.#settings = next;
    await this.#persist();
    return this.current;
  }

  async #persist(): Promise<void> {
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#settings, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporary, 0o600);
    await rename(temporary, this.#path);
  }
}

function validateSettings(value: unknown): OperatorSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const item = value as Record<string, unknown>;
  if (
    !new Set(["memory", "docker"]).has(String(item["workerAdapter"])) ||
    typeof item["workerImage"] !== "string" || item["workerImage"].length < 1 || item["workerImage"].length > 500 ||
    !new Set(["local", "aws-kms"]).has(String(item["kmsProvider"])) ||
    !(item["awsKmsKeyId"] === null || typeof item["awsKmsKeyId"] === "string") ||
    typeof item["seccompProfile"] !== "string" || item["seccompProfile"].length < 1 || item["seccompProfile"].length > 2_000 ||
    !positiveInteger(item["workerMemoryBytes"], 128 * 1024 * 1024, 128 * 1024 * 1024 * 1024) ||
    typeof item["workerCpus"] !== "number" || !Number.isFinite(item["workerCpus"]) || item["workerCpus"] < 0.1 || item["workerCpus"] > 64 ||
    !positiveInteger(item["workerPidsLimit"], 64, 32_768)
  ) throw invalid();
  if (item["kmsProvider"] === "aws-kms" && !String(item["awsKmsKeyId"] ?? "").trim()) {
    throw new BrowserSiloError("INVALID_REQUEST", "AWS KMS requires a key id.", 400);
  }
  return {
    workerAdapter: item["workerAdapter"] as OperatorSettings["workerAdapter"],
    workerImage: item["workerImage"].trim(),
    kmsProvider: item["kmsProvider"] as OperatorSettings["kmsProvider"],
    awsKmsKeyId: typeof item["awsKmsKeyId"] === "string" ? item["awsKmsKeyId"].trim() || null : null,
    seccompProfile: item["seccompProfile"],
    workerMemoryBytes: item["workerMemoryBytes"] as number,
    workerCpus: item["workerCpus"],
    workerPidsLimit: item["workerPidsLimit"] as number,
  };
}

function positiveInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function invalid(): BrowserSiloError {
  return new BrowserSiloError("INVALID_REQUEST", "Operator settings are invalid.", 400);
}
