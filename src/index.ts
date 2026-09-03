import { JsonFileRuntimeRepository } from "./adapters/json-file-repository.js";
import { MemoryWorkerRuntime } from "./adapters/memory-worker-runtime.js";
import { DockerWorkerRuntime } from "./adapters/docker-worker-runtime.js";
import { LocalEncryptedProfileStore } from "./adapters/encrypted-profile-store.js";
import { SystemClock, UuidGenerator } from "./adapters/system.js";
import { BrowserAutomationService } from "./browser/service.js";
import { EncryptedArtifactStore } from "./artifacts/encrypted-artifact-store.js";
import { resolve } from "node:path";
import { AwsKmsKeyManagement } from "./security/key-management.js";
import type { PoolConfiguration } from "./core/model.js";
import type { WorkerRuntimePort } from "./core/ports.js";
import { BrowserSiloCore } from "./core/service.js";
import { OperatorSettingsStore, type OperatorSettings } from "./config/operator-settings.js";
import {
  createAgentCredential,
  startServers,
  type AgentCredential,
  type ServerConfiguration,
} from "./http/server.js";

const dataDirectory = resolve(
  process.env["BROWSERSILO_DATA_DIR"] ?? resolve(process.cwd(), ".data"),
);
const operatorSettings = await OperatorSettingsStore.create(
  resolve(dataDirectory, "control-plane", "operator-settings.json"),
  {
    workerAdapter: "memory",
    workerImage: "browsersilo/brave-worker:0.4.0",
    kmsProvider: "local",
    awsKmsKeyId: null,
    seccompProfile: resolve(process.cwd(), "container", "brave-seccomp.json"),
    workerMemoryBytes: 1_073_741_824,
    workerCpus: 1,
    workerPidsLimit: 512,
  },
);
const desiredOperator = operatorSettings.current;
const effectiveOperator: OperatorSettings = {
  workerAdapter: (process.env["BROWSERSILO_WORKER_ADAPTER"] ?? desiredOperator.workerAdapter) as OperatorSettings["workerAdapter"],
  workerImage: process.env["BROWSERSILO_WORKER_IMAGE"] ?? desiredOperator.workerImage,
  kmsProvider: (process.env["BROWSERSILO_KMS_PROVIDER"] ?? desiredOperator.kmsProvider) as OperatorSettings["kmsProvider"],
  awsKmsKeyId: process.env["BROWSERSILO_AWS_KMS_KEY_ID"] ?? desiredOperator.awsKmsKeyId,
  seccompProfile: process.env["BROWSERSILO_SECCOMP_PROFILE"] ?? desiredOperator.seccompProfile,
  workerMemoryBytes: integerEnvironment("BROWSERSILO_WORKER_MEMORY_BYTES", desiredOperator.workerMemoryBytes),
  workerCpus: numberEnvironment("BROWSERSILO_WORKER_CPUS", desiredOperator.workerCpus),
  workerPidsLimit: integerEnvironment("BROWSERSILO_WORKER_PIDS_LIMIT", desiredOperator.workerPidsLimit),
};

const pool: PoolConfiguration = {
  warmShellReserve: integerEnvironment("BROWSERSILO_WARM_SHELLS", 1),
  maxActiveWorkers: integerEnvironment("BROWSERSILO_MAX_ACTIVE", 4),
  minLeaseTtlSeconds: 10,
  maxLeaseTtlSeconds: 86_400,
  defaultLeaseTtlSeconds: 900,
  maxActiveWorkersPerTenant: integerEnvironment("BROWSERSILO_MAX_ACTIVE_PER_TENANT", 2),
  maxQueueDepth: integerEnvironment("BROWSERSILO_MAX_QUEUE", 32),
  admissionTimeoutMs: integerEnvironment("BROWSERSILO_ADMISSION_TIMEOUT_MS", 30_000),
};

const runtimeRepository = await JsonFileRuntimeRepository.create(
  resolve(dataDirectory, "control-plane", "runtime.json"),
);

const adapter = effectiveOperator.workerAdapter;
let workerRuntime: WorkerRuntimePort;
let dockerRuntime: DockerWorkerRuntime | null = null;
let encryptedProfileStore: LocalEncryptedProfileStore | null = null;
let artifactStore: EncryptedArtifactStore | null = null;
if (adapter === "docker") {
  if (!/:0\.4(?:\.|$)/.test(effectiveOperator.workerImage)) {
    throw new Error("BrowserSilo 0.4 requires a compatible 0.4.x Brave worker image.");
  }
  const kmsProvider = effectiveOperator.kmsProvider;
  if (!new Set(["local", "aws-kms"]).has(kmsProvider)) {
    throw new Error("BROWSERSILO_KMS_PROVIDER must be local or aws-kms.");
  }
  const keyManagement =
    kmsProvider === "aws-kms"
      ? new AwsKmsKeyManagement({
          keyId: effectiveOperator.awsKmsKeyId ?? requiredEnvironment("BROWSERSILO_AWS_KMS_KEY_ID"),
          ...(process.env["AWS_REGION"]
            ? { region: process.env["AWS_REGION"] }
            : {}),
          ...(process.env["BROWSERSILO_AWS_KMS_ENDPOINT"]
            ? { endpoint: process.env["BROWSERSILO_AWS_KMS_ENDPOINT"] }
            : {}),
        })
      : undefined;
  const profileStore = await LocalEncryptedProfileStore.create({
    dataDirectory,
    ...(keyManagement ? { keyManagement } : {}),
    ...(process.env["BROWSERSILO_DATA_KEY"]
      ? { keyBase64: process.env["BROWSERSILO_DATA_KEY"] }
      : {}),
  });
  encryptedProfileStore = profileStore;
  artifactStore = await EncryptedArtifactStore.create(
    resolve(profileStore.dataDirectory, "artifacts"),
    profileStore.keyManagement,
  );
  dockerRuntime = new DockerWorkerRuntime({
    image: effectiveOperator.workerImage,
    profileStore,
    seccompProfile: effectiveOperator.seccompProfile,
    memoryBytes: effectiveOperator.workerMemoryBytes,
    cpus: effectiveOperator.workerCpus,
    pidsLimit: effectiveOperator.workerPidsLimit,
    ...(process.env["BROWSERSILO_RUNTIME_SCOPE"] ? { scope: process.env["BROWSERSILO_RUNTIME_SCOPE"] } : {}),
    ...(process.env["BROWSERSILO_WORKER_MANAGER_URL"]
      ? {
          workerManagerUrl: process.env["BROWSERSILO_WORKER_MANAGER_URL"],
          workerManagerToken: requiredEnvironment("BROWSERSILO_WORKER_MANAGER_TOKEN"),
          workerManagerStdioPort: integerEnvironment("BROWSERSILO_WORKER_MANAGER_STDIO_PORT", 4201),
          profileVolumeName: requiredEnvironment("BROWSERSILO_DATA_VOLUME"),
        }
      : {}),
  });
  const recoveredOrphans = await dockerRuntime.reconcileOrphans(
    await runtimeRepository.snapshot(),
  );
  if (recoveredOrphans > 0) {
    console.log(`Recovered ${recoveredOrphans} orphaned BrowserSilo worker(s).`);
  }
  workerRuntime = dockerRuntime;
} else if (adapter === "memory") {
  workerRuntime = new MemoryWorkerRuntime();
} else {
  throw new Error("BROWSERSILO_WORKER_ADAPTER must be memory or docker.");
}

let automationService: BrowserAutomationService | null = null;
const core = new BrowserSiloCore({
  repository: runtimeRepository,
  workerRuntime,
  clock: new SystemClock(),
  ids: new UuidGenerator(),
  pool,
  beforeLeaseDestroy: async (lease) => {
    if (!automationService) return;
    await automationService.finalizeLease(
      {
        tenantId: lease.tenantId,
        principalId: lease.principalId,
        kind: "service",
      },
      lease.id,
      lease.fencingToken,
    );
  },
});

await core.initialize();
const host = process.env["BROWSERSILO_HOST"] ?? "127.0.0.1";
const serverConfiguration: ServerConfiguration = {
  host,
  browserPort: integerEnvironment("BROWSERSILO_BROWSER_PORT", 4100),
  adminPort: integerEnvironment("BROWSERSILO_ADMIN_PORT", 4101),
  adminToken: process.env["BROWSERSILO_ADMIN_TOKEN"] ?? "admin-local",
  agentCredentials: agentCredentials(),
  operatorSettings,
  effectiveOperatorSettings: effectiveOperator,
};
if (dockerRuntime) {
  automationService = new BrowserAutomationService(
    core,
    dockerRuntime,
    artifactStore!,
  );
  serverConfiguration.automation = automationService;
  serverConfiguration.profileStore = encryptedProfileStore!;
  serverConfiguration.artifactStore = artifactStore!;
}
const servers = await startServers(core, serverConfiguration);

const reconciler = setInterval(() => {
  void core.reconcile().catch((error: unknown) => {
    console.error("BrowserSilo reconciliation failed", error);
  });
}, 1_000);

console.log(`BrowserSilo Browser API listening on http://${host}:${servers.browserPort}`);
console.log(`BrowserSilo Admin control plane listening on http://${host}:${servers.adminPort}`);
console.log(
  adapter === "docker"
    ? "Browser mode: sandboxed disposable Brave workers with private in-container control."
    : "Foundation mode: memory-worker adapter; Brave/CDP are not connected yet.",
);

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(reconciler);
    void (async () => {
      await servers.close();
      if (automationService) {
        const snapshot = await core.adminSnapshot();
        await Promise.allSettled(
          snapshot.leases
            .filter((lease) => lease.state === "active")
            .map((lease) => automationService!.finalizeLease(
              {
                tenantId: lease.tenantId,
                principalId: lease.principalId,
                kind: "service",
              },
              lease.id,
              lease.fencingToken,
            )),
        );
      }
      await dockerRuntime?.shutdown();
    })().finally(() => process.exit(0));
  });
}

function integerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function numberEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function agentCredentials(): AgentCredential[] {
  const encoded = process.env["BROWSERSILO_PRINCIPALS_JSON"];
  if (!encoded) {
    return [createAgentCredential(
      process.env["BROWSERSILO_AGENT_TOKEN"] ?? "agent-local-development-token",
      { tenantId: "local", principalId: "local-agent", kind: "agent" },
    )];
  }
  const parsed: unknown = JSON.parse(encoded);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("BROWSERSILO_PRINCIPALS_JSON must be a non-empty array.");
  }
  return parsed.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Each BrowserSilo principal credential must be an object.");
    }
    const item = value as Record<string, unknown>;
    const token = String(item["token"] ?? "");
    const kind = item["kind"];
    if (!new Set(["agent", "service", "user"]).has(String(kind))) {
      throw new Error("BrowserSilo principal kind must be agent, service, or user.");
    }
    return createAgentCredential(token, {
      tenantId: requiredCredentialString(item, "tenantId"),
      principalId: requiredCredentialString(item, "principalId"),
      kind: kind as "agent" | "service" | "user",
    });
  });
}

function requiredCredentialString(
  value: Record<string, unknown>,
  key: string,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new Error(`BrowserSilo credential ${key} must be a non-empty string.`);
  }
  return field;
}
