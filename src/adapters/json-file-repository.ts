import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { emptyRuntimeState, type RuntimeState } from "../core/model.js";
import type { RuntimeRepository } from "../core/ports.js";

export class JsonFileRuntimeRepository implements RuntimeRepository {
  readonly #path: string;
  #state: RuntimeState;
  #queue: Promise<void> = Promise.resolve();

  private constructor(path: string, state: RuntimeState) {
    this.#path = path;
    this.#state = state;
  }

  static async create(path: string): Promise<JsonFileRuntimeRepository> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let state = emptyRuntimeState();
    try {
      state = validateState(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const repository = new JsonFileRuntimeRepository(path, state);
    await repository.#persist(state);
    return repository;
  }

  async transaction<T>(
    operation: (state: RuntimeState) => T | Promise<T>,
  ): Promise<T> {
    const previous = this.#queue;
    let release!: () => void;
    this.#queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const next = structuredClone(this.#state);
      const result = await operation(next);
      await this.#persist(next);
      this.#state = next;
      return structuredClone(result);
    } finally {
      release();
    }
  }

  async snapshot(): Promise<RuntimeState> {
    await this.#queue;
    return structuredClone(this.#state);
  }

  async #persist(state: RuntimeState): Promise<void> {
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.#path);
  }
}

function validateState(value: unknown): RuntimeState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("BrowserSilo runtime state must be a JSON object.");
  }
  const state = value as Partial<RuntimeState>;
  if (state.settings === undefined) state.settings = { pool: null };
  if (
    !plainObject(state.profiles) ||
    !plainObject(state.leases) ||
    !plainObject(state.workers) ||
    !plainObject(state.profileFences) ||
    !plainObject(state.idempotencyKeys) ||
    !Array.isArray(state.audits) ||
    !plainObject(state.settings)
  ) {
    throw new Error("BrowserSilo runtime state has an invalid schema.");
  }
  return state as RuntimeState;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
