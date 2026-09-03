export type PrincipalKind = "user" | "agent" | "service";

export interface Principal {
  tenantId: string;
  principalId: string;
  kind: PrincipalKind;
}

export type ProfileStatus = "ready" | "leased";

export interface BrowserProfile {
  id: string;
  tenantId: string;
  ownerId: string;
  name: string;
  version: number;
  status: ProfileStatus;
  activeLeaseId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LeaseState =
  | "requested"
  | "queued"
  | "provisioning"
  | "active"
  | "releasing"
  | "closed"
  | "expired"
  | "failed";

export interface BrowserLease {
  id: string;
  tenantId: string;
  principalId: string;
  profileId: string;
  workerId: string;
  state: LeaseState;
  fencingToken: number;
  acquiredAt: string;
  expiresAt: string;
  closedAt: string | null;
  closeReason: string | null;
  idempotencyKey: string | null;
  cdpEndpoint: null;
  egressPolicy: LeaseEgressPolicy;
}

export interface LeaseEgressPolicy {
  allowedDomains: string[];
  blockPrivateNetworks: true;
}

export type WorkerState =
  | "creating"
  | "ready"
  | "claimed"
  | "active"
  | "draining"
  | "unhealthy"
  | "destroyed";

export interface BrowserWorker {
  id: string;
  runtimeRef: string;
  adapter: string;
  state: WorkerState;
  leaseId: string | null;
  profileId: string | null;
  everLeased: boolean;
  createdAt: string;
  activatedAt: string | null;
  destroyedAt: string | null;
  braveVersion: string | null;
  cdpVersion: string | null;
}

export type AuditDetail = string | number | boolean | null;

export interface AuditEvent {
  id: string;
  occurredAt: string;
  tenantId: string | null;
  actorId: string;
  action: string;
  resourceType: "profile" | "lease" | "worker" | "pool";
  resourceId: string;
  details: Record<string, AuditDetail>;
}

export interface RuntimeState {
  profiles: Record<string, BrowserProfile>;
  leases: Record<string, BrowserLease>;
  workers: Record<string, BrowserWorker>;
  profileFences: Record<string, number>;
  idempotencyKeys: Record<string, string>;
  audits: AuditEvent[];
  settings: {
    pool: PoolConfiguration | null;
  };
}

export interface PoolConfiguration {
  warmShellReserve: number;
  maxActiveWorkers: number;
  minLeaseTtlSeconds: number;
  maxLeaseTtlSeconds: number;
  defaultLeaseTtlSeconds: number;
  maxActiveWorkersPerTenant?: number;
  maxQueueDepth?: number;
  admissionTimeoutMs?: number;
}

export interface RuntimeOverview {
  mode: "foundation" | "browser";
  adapter: string;
  profiles: number;
  activeLeases: number;
  workers: Record<WorkerState, number>;
  pool: PoolConfiguration;
  limitations: string[];
  admission: { queued: number; maxQueueDepth: number };
}

export interface WorkerRuntimeCapabilities {
  mode: "foundation" | "browser";
  adapter: string;
  headedBrave: boolean;
  nativeCdp: boolean;
  browserActions: boolean;
  profilePersistence: "memory" | "encrypted-local" | "envelope-encrypted";
  limitations: string[];
}

export interface AdminSnapshot {
  overview: RuntimeOverview;
  profiles: BrowserProfile[];
  leases: BrowserLease[];
  workers: BrowserWorker[];
  audits: AuditEvent[];
}

export function emptyRuntimeState(): RuntimeState {
  return {
    profiles: {},
    leases: {},
    workers: {},
    profileFences: {},
    idempotencyKeys: {},
    audits: [],
    settings: { pool: null },
  };
}
