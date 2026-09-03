import { emptyRuntimeState, type RuntimeState } from "../core/model.js";
import type { RuntimeRepository } from "../core/ports.js";

export class MemoryRuntimeRepository implements RuntimeRepository {
  #state: RuntimeState;
  #tail: Promise<void> = Promise.resolve();

  constructor(initialState: RuntimeState = emptyRuntimeState()) {
    this.#state = structuredClone(initialState);
  }

  transaction<T>(
    operation: (state: RuntimeState) => T | Promise<T>,
  ): Promise<T> {
    const result = this.#tail.then(async () => {
      const candidate = structuredClone(this.#state);
      const value = await operation(candidate);
      this.#state = candidate;
      return structuredClone(value);
    });
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async snapshot(): Promise<RuntimeState> {
    await this.#tail;
    return structuredClone(this.#state);
  }
}
