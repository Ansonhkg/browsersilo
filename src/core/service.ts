import { BrowserSiloError } from "./errors.js";
import type {
  AdminSnapshot,
  AuditEvent,
  BrowserLease,
  BrowserProfile,
  BrowserWorker,
  PoolConfiguration,
  Principal,
  LeaseEgressPolicy,
  RuntimeOverview,
  RuntimeState,
  WorkerState,
} from "./model.js";
import type {
  Clock,
  IdGenerator,
  RuntimeRepository,
  WorkerRuntimePort,
} from "./ports.js";

export interface BrowserSiloCoreOptions {
  repository: RuntimeRepository;
  workerRuntime: WorkerRuntimePort;
  clock: Clock;
  ids: IdGenerator;
  pool: PoolConfiguration;
  beforeLeaseDestroy?: (lease: BrowserLease) => Promise<void>;
}

export interface CreateProfileInput {
  name: string;
}

export interface AcquireLeaseInput {
  profileId: string;
  ttlSeconds?: number;
  idempotencyKey?: string;
  allowedDomains?: string[];
}

export interface FencedLeaseInput {
  fencingToken: number;
  ttlSeconds?: number;
}

const SYSTEM_ACTOR = "browsesilo-reconciler";

export class BrowserSiloCore {
  readonly #repository: RuntimeRepository;
  readonly #workerRuntime: WorkerRuntimePort;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #pool: PoolConfiguration;
  readonly #beforeLeaseDestroy: ((lease: BrowserLease) => Promise<void>) | undefined;
  readonly #admissionWaiters: Array<() => void> = [];
  #pendingAdmissions = 0;

  constructor(options: BrowserSiloCoreOptions) {
    this.#repository = options.repository;
    this.#workerRuntime = options.workerRuntime;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#pool = { ...options.pool };
    this.#beforeLeaseDestroy = options.beforeLeaseDestroy;
    this.#validatePool();
  }

  async initialize(): Promise<void> {
    await this.#repository.transaction(async (state) => {
      if (state.settings.pool) {
        const configured = { ...this.#pool, ...state.settings.pool };
        const previous = { ...this.#pool };
        Object.assign(this.#pool, configured);
        try {
          this.#validatePool();
        } catch (error) {
          Object.assign(this.#pool, previous);
          throw error;
        }
      }
      this.#recoverInterruptedState(state);
      await this.#replenishWarmShells(state);
    });
  }

  capabilities(): Record<string, unknown> {
    const runtime = this.#workerRuntime.capabilities();
    return {
      apiVersion: "v1",
      product: "BrowserSilo",
      mode: runtime.mode,
      profiles: {
        durableModel: true,
        persistence: runtime.profilePersistence,
      },
      leases: { exclusive: true, fencing: true, renewal: true },
      workers: { disposable: true, adapter: runtime.adapter },
      directCdp: false,
      nativeCdp: runtime.nativeCdp,
      browserActions: runtime.browserActions,
      headedBrave: runtime.headedBrave,
      recording: runtime.browserActions,
      liveStream: runtime.browserActions,
      domainCapture: runtime.browserActions,
    };
  }

  async createProfile(
    principal: Principal,
    input: CreateProfileInput,
  ): Promise<BrowserProfile> {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 100) {
      throw new BrowserSiloError(
        "INVALID_REQUEST",
        "Profile name must be between 1 and 100 characters.",
        400,
      );
    }

    return this.#repository.transaction((state) => {
      const now = this.#now();
      const profile: BrowserProfile = {
        id: this.#ids.next("profile"),
        tenantId: principal.tenantId,
        ownerId: principal.principalId,
        name,
        version: 0,
        status: "ready",
        activeLeaseId: null,
        createdAt: now,
        updatedAt: now,
      };
      state.profiles[profile.id] = profile;
      this.#audit(state, principal, "profile.created", "profile", profile.id, {
        name,
      });
      return profile;
    });
  }

  async listProfiles(principal: Principal): Promise<BrowserProfile[]> {
    const state = await this.#repository.snapshot();
    return Object.values(state.profiles)
      .filter(
        (profile) =>
          profile.tenantId === principal.tenantId &&
          profile.ownerId === principal.principalId,
      )
      .sort(byCreatedAt);
  }

  async getProfile(
    principal: Principal,
    profileId: string,
  ): Promise<BrowserProfile> {
    const state = await this.#repository.snapshot();
    return this.#ownedProfile(state, principal, profileId);
  }

  async assertProfileIdle(
    principal: Principal,
    profileId: string,
  ): Promise<BrowserProfile> {
    const profile = await this.getProfile(principal, profileId);
    if (profile.activeLeaseId || profile.status === "leased") {
      throw new BrowserSiloError(
        "PROFILE_LEASE_CONFLICT",
        "The browser profile must be idle for this operation.",
        409,
        { profileId, activeLeaseId: profile.activeLeaseId },
      );
    }
    return profile;
  }

  async deleteProfile(principal: Principal, profileId: string): Promise<void> {
    await this.#repository.transaction((state) => {
      const profile = this.#ownedProfile(state, principal, profileId);
      if (profile.activeLeaseId || profile.status === "leased") {
        throw new BrowserSiloError(
          "PROFILE_LEASE_CONFLICT",
          "An active browser profile cannot be deleted.",
          409,
          { profileId, activeLeaseId: profile.activeLeaseId },
        );
      }
      delete state.profiles[profileId];
      delete state.profileFences[profileId];
      for (const [key, leaseId] of Object.entries(state.idempotencyKeys)) {
        if (state.leases[leaseId]?.profileId === profileId) delete state.idempotencyKeys[key];
      }
      this.#audit(state, principal, "profile.deleted", "profile", profileId, {
        cryptoErased: true,
      });
    });
  }

  async acquireLease(
    principal: Principal,
    input: AcquireLeaseInput,
  ): Promise<BrowserLease> {
    const queueDepth = this.#pool.maxQueueDepth ?? 0;
    const timeoutMs = this.#pool.admissionTimeoutMs ?? 0;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        return await this.#acquireLeaseNow(principal, input);
      } catch (error) {
        if (
          !(error instanceof BrowserSiloError) ||
          error.code !== "CAPACITY_EXHAUSTED" ||
          queueDepth === 0 ||
          timeoutMs === 0
        ) throw error;
        if (this.#pendingAdmissions >= queueDepth) {
          throw new BrowserSiloError(
            "CAPACITY_EXHAUSTED",
            "The admission queue is full.",
            429,
            { maxQueueDepth: queueDepth },
          );
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new BrowserSiloError(
            "CAPACITY_EXHAUSTED",
            "Timed out waiting for browser capacity.",
            429,
          );
        }
        await this.#waitForCapacity(remaining);
      }
    }
  }

  async #acquireLeaseNow(
    principal: Principal,
    input: AcquireLeaseInput,
  ): Promise<BrowserLease> {
    const ttlSeconds = this.#leaseTtl(input.ttlSeconds);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);

    const reserved = await this.#repository.transaction(async (state) => {
      const profile = this.#ownedProfile(state, principal, input.profileId);
      const scopedKey = idempotencyKey
        ? `${principal.tenantId}:${principal.principalId}:${idempotencyKey}`
        : null;

      if (scopedKey) {
        const previousLeaseId = state.idempotencyKeys[scopedKey];
        if (previousLeaseId) {
          const previous = state.leases[previousLeaseId];
          if (!previous) {
            throw new BrowserSiloError(
              "INVALID_REQUEST",
              "The idempotency record is inconsistent.",
              500,
            );
          }
          if (previous.profileId !== profile.id) {
            throw new BrowserSiloError(
              "IDEMPOTENCY_CONFLICT",
              "This idempotency key was already used for another profile.",
              409,
            );
          }
          return { lease: previous, replay: true };
        }
      }

      if (profile.activeLeaseId) {
        throw new BrowserSiloError(
          "PROFILE_LEASE_CONFLICT",
          "The browser profile already has an active lease.",
          409,
          { profileId: profile.id, activeLeaseId: profile.activeLeaseId },
        );
      }

      const activeWorkers = Object.values(state.workers).filter(
        (worker) => new Set(["claimed", "active", "draining"]).has(worker.state),
      ).length;
      const activeTenantWorkers = Object.values(state.leases).filter(
        (lease) =>
          lease.tenantId === principal.tenantId &&
          new Set(["provisioning", "active"]).has(lease.state),
      ).length;
      const tenantLimit = this.#pool.maxActiveWorkersPerTenant ?? this.#pool.maxActiveWorkers;
      if (activeTenantWorkers >= tenantLimit) {
        throw new BrowserSiloError(
          "CAPACITY_EXHAUSTED",
          "The tenant's active browser quota has been reached.",
          429,
          { maxActiveWorkersPerTenant: tenantLimit },
        );
      }
      if (activeWorkers >= this.#pool.maxActiveWorkers) {
        throw new BrowserSiloError(
          "CAPACITY_EXHAUSTED",
          "The active worker limit has been reached.",
          429,
          { maxActiveWorkers: this.#pool.maxActiveWorkers },
        );
      }

      await this.#replenishWarmShells(state);
      const worker = Object.values(state.workers).find(
        (candidate) => candidate.state === "ready" && !candidate.everLeased,
      );
      if (!worker) {
        throw new BrowserSiloError(
          "CAPACITY_EXHAUSTED",
          "No clean worker is ready.",
          429,
        );
      }

      const now = this.#clock.now();
      const leaseId = this.#ids.next("lease");
      const fencingToken = (state.profileFences[profile.id] ?? 0) + 1;
      const lease: BrowserLease = {
        id: leaseId,
        tenantId: principal.tenantId,
        principalId: principal.principalId,
        profileId: profile.id,
        workerId: worker.id,
        state: "provisioning",
        fencingToken,
        acquiredAt: now.toISOString(),
        expiresAt: addSeconds(now, ttlSeconds).toISOString(),
        closedAt: null,
        closeReason: null,
        idempotencyKey,
        cdpEndpoint: null,
        egressPolicy: normalizeEgressPolicy(input.allowedDomains),
      };

      worker.state = "claimed";
      worker.leaseId = lease.id;
      worker.profileId = profile.id;
      worker.everLeased = true;
      profile.status = "leased";
      profile.activeLeaseId = lease.id;
      profile.updatedAt = now.toISOString();
      state.profileFences[profile.id] = fencingToken;
      state.leases[lease.id] = lease;
      if (scopedKey) state.idempotencyKeys[scopedKey] = lease.id;

      this.#audit(state, principal, "lease.provisioning", "lease", lease.id, {
        profileId: profile.id,
        workerId: worker.id,
        fencingToken,
      });
      return { lease, replay: false };
    });
    if (reserved.replay) return reserved.lease;

    const lease = reserved.lease;
    try {
      const activated = await this.#workerRuntime.activate(
        lease.workerId,
        lease.id,
        lease.profileId,
        lease.egressPolicy,
      );
      return await this.#repository.transaction(async (state) => {
        const durableLease = state.leases[lease.id];
        const worker = state.workers[lease.workerId];
        const profile = state.profiles[lease.profileId];
        if (!durableLease || !worker || !profile || durableLease.state !== "provisioning") {
          throw new BrowserSiloError(
            "INVALID_REQUEST",
            "The durable lease reservation changed during activation.",
            500,
          );
        }
        if (activated) {
          if (activated.runtimeRef) worker.runtimeRef = activated.runtimeRef;
          if (activated.adapter) worker.adapter = activated.adapter;
          if (activated.braveVersion !== undefined) worker.braveVersion = activated.braveVersion;
          if (activated.cdpVersion !== undefined) worker.cdpVersion = activated.cdpVersion;
        }
        const now = this.#now();
        worker.state = "active";
        worker.activatedAt = now;
        durableLease.state = "active";
        this.#audit(state, principal, "lease.acquired", "lease", durableLease.id, {
          profileId: profile.id,
          workerId: worker.id,
          fencingToken: durableLease.fencingToken,
        });
        await this.#replenishWarmShells(state);
        return durableLease;
      });
    } catch (error) {
      await this.#workerRuntime.destroy(lease.workerId).catch(() => undefined);
      await this.#repository.transaction(async (state) => {
        const durableLease = state.leases[lease.id];
        const worker = state.workers[lease.workerId];
        const profile = state.profiles[lease.profileId];
        const failedAt = this.#now();
        if (durableLease && durableLease.state === "provisioning") {
          durableLease.state = "failed";
          durableLease.closedAt = failedAt;
          durableLease.closeReason = "worker_activation_failed";
        }
        if (worker && worker.state !== "destroyed") {
          worker.state = "destroyed";
          worker.destroyedAt = failedAt;
        }
        if (profile?.activeLeaseId === lease.id) {
          profile.status = "ready";
          profile.activeLeaseId = null;
          profile.updatedAt = failedAt;
        }
        this.#audit(state, principal, "lease.failed", "lease", lease.id, {
          profileId: lease.profileId,
          workerId: lease.workerId,
          reason: "worker_activation_failed",
        });
        await this.#replenishWarmShells(state);
      });
      this.#notifyCapacity();
      throw error;
    }
  }

  async getLease(
    principal: Principal,
    leaseId: string,
  ): Promise<BrowserLease> {
    const state = await this.#repository.snapshot();
    return this.#ownedLease(state, principal, leaseId);
  }

  async renewLease(
    principal: Principal,
    leaseId: string,
    input: FencedLeaseInput,
  ): Promise<BrowserLease> {
    const ttlSeconds = this.#leaseTtl(input.ttlSeconds);
    return this.#repository.transaction((state) => {
      const lease = this.#ownedLease(state, principal, leaseId);
      this.#assertFence(lease, input.fencingToken);
      if (lease.state !== "active") {
        throw new BrowserSiloError(
          "LEASE_NOT_ACTIVE",
          "Only an active lease can be renewed.",
          409,
          { leaseId, state: lease.state },
        );
      }
      lease.expiresAt = addSeconds(this.#clock.now(), ttlSeconds).toISOString();
      this.#audit(state, principal, "lease.renewed", "lease", lease.id, {
        fencingToken: lease.fencingToken,
        expiresAt: lease.expiresAt,
      });
      return lease;
    });
  }

  async releaseLease(
    principal: Principal,
    leaseId: string,
    input: FencedLeaseInput,
  ): Promise<BrowserLease> {
    const reservation = await this.#repository.transaction((state) => {
      const lease = this.#ownedLease(state, principal, leaseId);
      this.#assertFence(lease, input.fencingToken);
      if (lease.state === "closed") return { lease, alreadyClosed: true };
      if (lease.state !== "active") {
        throw new BrowserSiloError(
          "LEASE_NOT_ACTIVE",
          "Only an active lease can be released.",
          409,
          { leaseId, state: lease.state },
        );
      }
      const worker = state.workers[lease.workerId];
      if (!worker) {
        throw new BrowserSiloError("INVALID_REQUEST", "The lease worker is missing.", 500);
      }
      lease.state = "releasing";
      worker.state = "draining";
      this.#audit(state, principal, "lease.releasing", "lease", lease.id, {
        profileId: lease.profileId,
        workerId: lease.workerId,
      });
      return { lease, alreadyClosed: false };
    });
    if (reservation.alreadyClosed) return reservation.lease;

    try {
      await this.#workerRuntime.destroy(reservation.lease.workerId);
    } catch (error) {
      await this.#repository.transaction((state) => {
        const lease = state.leases[leaseId];
        const worker = lease ? state.workers[lease.workerId] : undefined;
        if (lease?.state === "releasing") lease.state = "active";
        if (worker?.state === "draining") worker.state = "active";
      });
      throw error;
    }

    const closed = await this.#repository.transaction(async (state) => {
      const lease = this.#ownedLease(state, principal, leaseId);
      const profile = state.profiles[lease.profileId];
      const worker = state.workers[lease.workerId];
      if (!profile || !worker || lease.state !== "releasing") {
        throw new BrowserSiloError(
          "INVALID_REQUEST",
          "The durable lease release changed while the worker was draining.",
          500,
        );
      }
      const closedAt = this.#now();
      worker.state = "destroyed";
      worker.destroyedAt = closedAt;
      profile.status = "ready";
      profile.activeLeaseId = null;
      profile.version += 1;
      profile.updatedAt = closedAt;
      lease.state = "closed";
      lease.closedAt = closedAt;
      lease.closeReason = "released";
      this.#audit(state, principal, "lease.closed", "lease", lease.id, {
        profileId: profile.id,
        workerId: worker.id,
        reason: "released",
      });
      this.#audit(state, principal, "worker.destroyed", "worker", worker.id, {
        reason: "used_worker_disposal",
        leaseId: lease.id,
      });
      await this.#replenishWarmShells(state);
      return lease;
    });
    this.#notifyCapacity();
    return closed;
  }

  async reconcile(): Promise<void> {
    const expired = await this.#repository.transaction((state) => {
      const now = this.#clock.now();
      const candidates = Object.values(state.leases).filter(
        (lease) =>
          lease.state === "active" &&
          new Date(lease.expiresAt).getTime() <= now.getTime(),
      );
      for (const lease of candidates) {
        lease.state = "releasing";
        const worker = state.workers[lease.workerId];
        if (worker) worker.state = "draining";
      }
      return candidates;
    });
    let released = 0;
    for (const candidate of expired) {
      try {
        await this.#beforeLeaseDestroy?.(candidate);
        await this.#workerRuntime.destroy(candidate.workerId);
        await this.#repository.transaction((state) => {
          const lease = state.leases[candidate.id];
          const worker = state.workers[candidate.workerId];
          const profile = state.profiles[candidate.profileId];
          if (!lease || !worker || !profile || lease.state !== "releasing") return;
          const closedAt = this.#now();
          worker.state = "destroyed";
          worker.destroyedAt = closedAt;
          profile.status = "ready";
          profile.activeLeaseId = null;
          profile.version += 1;
          profile.updatedAt = closedAt;
          lease.state = "expired";
          lease.closedAt = closedAt;
          lease.closeReason = "lease_ttl_elapsed";
          const actor = systemPrincipal(lease.tenantId);
          this.#audit(state, actor, "lease.expired", "lease", lease.id, {
            profileId: profile.id,
            workerId: worker.id,
            reason: "lease_ttl_elapsed",
          });
          this.#audit(state, actor, "worker.destroyed", "worker", worker.id, {
            reason: "used_worker_disposal",
            leaseId: lease.id,
          });
        });
        released += 1;
      } catch {
        await this.#repository.transaction((state) => {
          const lease = state.leases[candidate.id];
          const worker = state.workers[candidate.workerId];
          if (lease?.state === "releasing") lease.state = "active";
          if (worker?.state === "draining") worker.state = "active";
        });
      }
    }
    await this.#repository.transaction((state) => this.#replenishWarmShells(state));
    if (released > 0) this.#notifyCapacity();
  }

  async adminSnapshot(): Promise<AdminSnapshot> {
    const state = await this.#repository.snapshot();
    return {
      overview: this.#overview(state),
      profiles: Object.values(state.profiles).sort(byCreatedAt),
      leases: Object.values(state.leases).sort((a, b) =>
        a.acquiredAt.localeCompare(b.acquiredAt),
      ),
      workers: Object.values(state.workers).sort(byCreatedAt),
      audits: [...state.audits].sort((a, b) =>
        b.occurredAt.localeCompare(a.occurredAt),
      ),
    };
  }

  async overview(): Promise<RuntimeOverview> {
    return this.#overview(await this.#repository.snapshot());
  }

  async updatePool(input: Partial<Pick<PoolConfiguration,
    "warmShellReserve" | "maxActiveWorkers" | "maxActiveWorkersPerTenant" | "maxQueueDepth" | "admissionTimeoutMs"
  >>): Promise<PoolConfiguration> {
    const previous = { ...this.#pool };
    Object.assign(this.#pool, input);
    try {
      this.#validatePool();
    } catch (error) {
      Object.assign(this.#pool, previous);
      throw error;
    }
    await this.#repository.transaction(async (state) => {
      state.settings.pool = { ...this.#pool };
      await this.#replenishWarmShells(state);
    });
    return { ...this.#pool };
  }

  admissionSnapshot(): { queued: number; maxQueueDepth: number } {
    return {
      queued: this.#pendingAdmissions,
      maxQueueDepth: this.#pool.maxQueueDepth ?? 0,
    };
  }

  async #replenishWarmShells(state: RuntimeState): Promise<void> {
    let ready = Object.values(state.workers).filter(
      (worker) => worker.state === "ready" && !worker.everLeased,
    ).length;
    while (ready < this.#pool.warmShellReserve) {
      const workerId = this.#ids.next("worker");
      const createdAt = this.#now();
      const worker: BrowserWorker = {
        id: workerId,
        runtimeRef: "pending",
        adapter: "pending",
        state: "creating",
        leaseId: null,
        profileId: null,
        everLeased: false,
        createdAt,
        activatedAt: null,
        destroyedAt: null,
        braveVersion: null,
        cdpVersion: null,
      };
      state.workers[worker.id] = worker;
      const descriptor = await this.#workerRuntime.createWarmShell(worker.id);
      worker.runtimeRef = descriptor.runtimeRef;
      worker.adapter = descriptor.adapter;
      worker.braveVersion = descriptor.braveVersion;
      worker.cdpVersion = descriptor.cdpVersion;
      worker.state = "ready";
      this.#audit(
        state,
        systemPrincipal(null),
        "worker.ready",
        "worker",
        worker.id,
        { adapter: worker.adapter },
      );
      ready += 1;
    }
  }

  #recoverInterruptedState(state: RuntimeState): void {
    const interrupted = Object.values(state.leases).filter((lease) =>
      new Set<BrowserLease["state"]>([
        "requested",
        "queued",
        "provisioning",
        "active",
        "releasing",
      ]).has(lease.state),
    );
    if (interrupted.length === 0 && Object.values(state.workers).every(
      (worker) => worker.state === "destroyed",
    )) return;

    const recoveredAt = this.#now();
    for (const lease of interrupted) {
      const mayHaveCommittedProfile = new Set(["provisioning", "active", "releasing"]).has(lease.state);
      lease.state = "failed";
      lease.closedAt = recoveredAt;
      lease.closeReason = "control_plane_restart";
      const profile = state.profiles[lease.profileId];
      if (profile) {
        profile.status = "ready";
        profile.activeLeaseId = null;
        profile.updatedAt = recoveredAt;
        if (mayHaveCommittedProfile) profile.version += 1;
      }
      this.#audit(
        state,
        systemPrincipal(lease.tenantId),
        "lease.recovered",
        "lease",
        lease.id,
        { reason: "control_plane_restart" },
      );
    }
    for (const worker of Object.values(state.workers)) {
      if (worker.state === "destroyed") continue;
      worker.state = "destroyed";
      worker.destroyedAt = recoveredAt;
      this.#audit(
        state,
        systemPrincipal(null),
        "worker.recovered",
        "worker",
        worker.id,
        { reason: "control_plane_restart" },
      );
    }
  }

  #ownedProfile(
    state: RuntimeState,
    principal: Principal,
    profileId: string,
  ): BrowserProfile {
    const profile = state.profiles[profileId];
    if (!profile) {
      throw new BrowserSiloError("NOT_FOUND", "Browser profile not found.", 404);
    }
    if (
      profile.tenantId !== principal.tenantId ||
      profile.ownerId !== principal.principalId
    ) {
      throw new BrowserSiloError(
        "FORBIDDEN",
        "The principal cannot access this browser profile.",
        403,
      );
    }
    return profile;
  }

  #ownedLease(
    state: RuntimeState,
    principal: Principal,
    leaseId: string,
  ): BrowserLease {
    const lease = state.leases[leaseId];
    if (!lease) {
      throw new BrowserSiloError("NOT_FOUND", "Browser lease not found.", 404);
    }
    if (
      lease.tenantId !== principal.tenantId ||
      lease.principalId !== principal.principalId
    ) {
      throw new BrowserSiloError(
        "FORBIDDEN",
        "The principal cannot access this browser lease.",
        403,
      );
    }
    return lease;
  }

  #assertFence(lease: BrowserLease, provided: number): void {
    if (!Number.isSafeInteger(provided) || provided !== lease.fencingToken) {
      throw new BrowserSiloError(
        "STALE_FENCE",
        "The fencing token is stale or invalid.",
        409,
        { leaseId: lease.id },
      );
    }
  }

  #leaseTtl(requested: number | undefined): number {
    const ttl = requested ?? this.#pool.defaultLeaseTtlSeconds;
    if (
      !Number.isSafeInteger(ttl) ||
      ttl < this.#pool.minLeaseTtlSeconds ||
      ttl > this.#pool.maxLeaseTtlSeconds
    ) {
      throw new BrowserSiloError(
        "INVALID_REQUEST",
        `Lease TTL must be between ${this.#pool.minLeaseTtlSeconds} and ${this.#pool.maxLeaseTtlSeconds} seconds.`,
        400,
      );
    }
    return ttl;
  }

  #overview(state: RuntimeState): RuntimeOverview {
    const runtime = this.#workerRuntime.capabilities();
    const workerStates: WorkerState[] = [
      "creating",
      "ready",
      "claimed",
      "active",
      "draining",
      "unhealthy",
      "destroyed",
    ];
    const workers = Object.fromEntries(
      workerStates.map((workerState) => [
        workerState,
        Object.values(state.workers).filter(
          (worker) => worker.state === workerState,
        ).length,
      ]),
    ) as Record<WorkerState, number>;
    return {
      mode: runtime.mode,
      adapter: runtime.adapter,
      profiles: Object.keys(state.profiles).length,
      activeLeases: Object.values(state.leases).filter(
        (lease) => lease.state === "active",
      ).length,
      workers,
      pool: { ...this.#pool },
      limitations: [...runtime.limitations],
      admission: this.admissionSnapshot(),
    };
  }

  #audit(
    state: RuntimeState,
    actor: Principal,
    action: string,
    resourceType: AuditEvent["resourceType"],
    resourceId: string,
    details: AuditEvent["details"],
  ): void {
    state.audits.push({
      id: this.#ids.next("audit"),
      occurredAt: this.#now(),
      tenantId: actor.tenantId || null,
      actorId: actor.principalId,
      action,
      resourceType,
      resourceId,
      details,
    });
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }

  #validatePool(): void {
    const config = this.#pool;
    if (
      !Number.isSafeInteger(config.warmShellReserve) ||
      config.warmShellReserve < 0 ||
      !Number.isSafeInteger(config.maxActiveWorkers) ||
      config.maxActiveWorkers < 1 ||
      config.warmShellReserve > config.maxActiveWorkers ||
      config.minLeaseTtlSeconds < 1 ||
      config.defaultLeaseTtlSeconds < config.minLeaseTtlSeconds ||
      config.defaultLeaseTtlSeconds > config.maxLeaseTtlSeconds
      || !Number.isSafeInteger(config.maxActiveWorkersPerTenant ?? 1)
      || (config.maxActiveWorkersPerTenant ?? 1) < 1
      || (config.maxActiveWorkersPerTenant ?? config.maxActiveWorkers) > config.maxActiveWorkers
      || !Number.isSafeInteger(config.maxQueueDepth ?? 0)
      || (config.maxQueueDepth ?? 0) < 0
      || !Number.isSafeInteger(config.admissionTimeoutMs ?? 0)
      || (config.admissionTimeoutMs ?? 0) < 0
    ) {
      throw new Error("Invalid BrowserSilo pool configuration.");
    }
  }

  #waitForCapacity(timeoutMs: number): Promise<void> {
    this.#pendingAdmissions += 1;
    return new Promise((resolvePromise) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const index = this.#admissionWaiters.indexOf(done);
        if (index >= 0) this.#admissionWaiters.splice(index, 1);
        this.#pendingAdmissions -= 1;
        resolvePromise();
      };
      const timer = setTimeout(done, timeoutMs);
      this.#admissionWaiters.push(done);
    });
  }

  #notifyCapacity(): void {
    this.#admissionWaiters.shift()?.();
  }
}

function normalizeEgressPolicy(allowedDomains: string[] | undefined): LeaseEgressPolicy {
  const values = allowedDomains ?? ["*"];
  if (values.length < 1 || values.length > 100) {
    throw new BrowserSiloError(
      "INVALID_REQUEST",
      "allowedDomains must contain between 1 and 100 domain patterns.",
      400,
    );
  }
  const normalized = values.map((value) => value.trim().toLowerCase());
  if (normalized.some((value) =>
    value.length < 1 || value.length > 253 ||
    !(value === "*" || /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value))
  )) {
    throw new BrowserSiloError(
      "INVALID_REQUEST",
      "allowedDomains contains an invalid domain pattern.",
      400,
    );
  }
  return { allowedDomains: [...new Set(normalized)], blockPrivateNetworks: true };
}

function normalizeIdempotencyKey(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 200) {
    throw new BrowserSiloError(
      "INVALID_REQUEST",
      "Idempotency keys must be between 1 and 200 characters.",
      400,
    );
  }
  return normalized;
}

function addSeconds(value: Date, seconds: number): Date {
  return new Date(value.getTime() + seconds * 1_000);
}

function byCreatedAt<T extends { createdAt: string }>(a: T, b: T): number {
  return a.createdAt.localeCompare(b.createdAt);
}

function systemPrincipal(tenantId: string | null): Principal {
  return {
    tenantId: tenantId ?? "",
    principalId: SYSTEM_ACTOR,
    kind: "service",
  };
}
