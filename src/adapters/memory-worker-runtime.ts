import { BrowserSiloError } from "../core/errors.js";
import type {
  WorkerDescriptor,
  WorkerRuntimePort,
} from "../core/ports.js";
import type { WorkerRuntimeCapabilities } from "../core/model.js";

type SimulatedWorkerState = "ready" | "active" | "destroyed";

interface SimulatedWorker {
  id: string;
  state: SimulatedWorkerState;
  leaseId: string | null;
  profileId: string | null;
}

export class MemoryWorkerRuntime implements WorkerRuntimePort {
  readonly #workers = new Map<string, SimulatedWorker>();

  capabilities(): WorkerRuntimeCapabilities {
    return {
      mode: "foundation",
      adapter: "memory-worker",
      headedBrave: false,
      nativeCdp: false,
      browserActions: false,
      profilePersistence: "memory",
      limitations: [
        "The worker adapter is simulated and does not launch Brave.",
        "Control-plane state is durable JSON, but browser profile payloads are unavailable in foundation mode.",
        "Browser actions, recordings, and Domain Capture require the Docker adapter.",
      ],
    };
  }

  async createWarmShell(workerId: string): Promise<WorkerDescriptor> {
    if (this.#workers.has(workerId)) {
      throw new BrowserSiloError(
        "INVALID_REQUEST",
        "A worker with this identifier already exists.",
        500,
      );
    }
    this.#workers.set(workerId, {
      id: workerId,
      state: "ready",
      leaseId: null,
      profileId: null,
    });
    return {
      runtimeRef: `memory://${workerId}`,
      adapter: "memory-worker",
      braveVersion: null,
      cdpVersion: null,
    };
  }

  async activate(
    workerId: string,
    leaseId: string,
    profileId: string,
  ): Promise<void> {
    const worker = this.#workers.get(workerId);
    if (!worker || worker.state !== "ready") {
      throw new BrowserSiloError(
        "INVALID_REQUEST",
        "Only a clean ready worker can be activated.",
        500,
      );
    }
    worker.state = "active";
    worker.leaseId = leaseId;
    worker.profileId = profileId;
  }

  async destroy(workerId: string): Promise<void> {
    const worker = this.#workers.get(workerId);
    if (!worker) {
      throw new BrowserSiloError(
        "INVALID_REQUEST",
        "The worker runtime cannot destroy an unknown worker.",
        500,
      );
    }
    worker.state = "destroyed";
  }

  snapshot(): SimulatedWorker[] {
    return structuredClone([...this.#workers.values()]);
  }
}
