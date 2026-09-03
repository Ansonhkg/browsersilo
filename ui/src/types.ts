export interface BrowserProfile {
  id: string;
  tenantId: string;
  ownerId: string;
  name: string;
  version: number;
  status: "ready" | "leased";
  activeLeaseId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserLease {
  id: string;
  profileId: string;
  workerId: string;
  state: string;
  fencingToken: number;
  acquiredAt: string;
  expiresAt: string;
  closedAt: string | null;
}

export interface BrowserWorker {
  id: string;
  runtimeRef: string;
  adapter: string;
  state: string;
  leaseId: string | null;
  profileId: string | null;
  everLeased: boolean;
  createdAt: string;
  braveVersion: string | null;
  cdpVersion: string | null;
}

export interface AuditEvent {
  id: string;
  occurredAt: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
}

export interface RuntimeOverview {
  mode: "foundation" | "browser";
  adapter: string;
  profiles: number;
  activeLeases: number;
  workers: Record<string, number>;
  pool: {
    warmShellReserve: number;
    maxActiveWorkers: number;
    maxActiveWorkersPerTenant?: number;
    maxQueueDepth?: number;
    admissionTimeoutMs?: number;
  };
  limitations: string[];
  admission: { queued: number; maxQueueDepth: number };
}

export interface ArtifactMetadata {
  id: string;
  tenantId: string;
  ownerId: string;
  leaseId: string | null;
  profileId: string | null;
  kind: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: string;
  expiresAt: string | null;
  labels: Record<string, string>;
}

export interface TelemetrySnapshot {
  inFlight: number;
  requests: number;
  errors: number;
  averageDurationMs: number;
  accounting: {
    browserSeconds: number;
    artifactBytes: number;
    profiles: number;
    workersCreated: number;
  };
  alerts: Array<{ severity: string; code: string; message: string }>;
}

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

export interface AdapterConfiguration {
  desired: OperatorSettings;
  effective: OperatorSettings;
  restartRequired: boolean;
  environmentOverrides: string[];
}

export interface AdminSnapshot {
  overview: RuntimeOverview;
  profiles: BrowserProfile[];
  leases: BrowserLease[];
  workers: BrowserWorker[];
  audits: AuditEvent[];
  artifacts: ArtifactMetadata[];
  artifactRetentionSeconds: number;
  telemetry: TelemetrySnapshot;
  adapters: AdapterConfiguration;
}
