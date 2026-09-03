import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { relative, sep } from "node:path";
import { BrowserSiloError } from "../core/errors.js";
import type { LeaseEgressPolicy, RuntimeState, WorkerRuntimeCapabilities } from "../core/model.js";
import type {
  BrowserAutomationPort,
  BrowserScreenshot,
  BrowserSnapshot,
  BrowserSnapshotElement,
  BrowserSnapshotNode,
  BrowserTab,
  BrowserToolResult,
  WorkerDescriptor,
  WorkerRuntimePort,
} from "../core/ports.js";
import { AgentBrowserBridge } from "./agent-browser-bridge.js";
import type { LocalEncryptedProfileStore } from "./encrypted-profile-store.js";
import { RemoteDockerExecutor, type DockerExecutor } from "../worker-manager/client.js";

const execFileAsync = promisify(execFile);

interface ActiveDockerWorker {
  workerId: string;
  leaseId: string;
  profileId: string;
  containerName: string;
  proxyContainerName: string;
  networkName: string;
  profileDirectory: string;
  cdpPort: number;
  stopped: boolean;
  egressPolicy: LeaseEgressPolicy;
  warm: boolean;
}

export interface DockerWorkerRuntimeOptions {
  image: string;
  profileStore: LocalEncryptedProfileStore;
  seccompProfile: string;
  memoryBytes?: number;
  cpus?: number;
  pidsLimit?: number;
  workerManagerUrl?: string;
  workerManagerToken?: string;
  workerManagerStdioPort?: number;
  profileVolumeName?: string;
  scope?: string;
}

export class DockerWorkerRuntime
  implements WorkerRuntimePort, BrowserAutomationPort
{
  readonly #image: string;
  readonly #profileStore: LocalEncryptedProfileStore;
  readonly #memoryBytes: number;
  readonly #cpus: number;
  readonly #pidsLimit: number;
  readonly #scope: string;
  readonly #seccompProfile: string;
  readonly #workers = new Map<string, ActiveDockerWorker>();
  readonly #recordings = new Map<string, string>();
  readonly #agentBrowser: AgentBrowserBridge;
  readonly #profileVolumeName: string | null;

  constructor(options: DockerWorkerRuntimeOptions) {
    this.#image = options.image;
    this.#profileStore = options.profileStore;
    this.#memoryBytes = options.memoryBytes ?? 1_073_741_824;
    this.#cpus = options.cpus ?? 1;
    this.#pidsLimit = options.pidsLimit ?? 512;
    this.#seccompProfile = options.seccompProfile;
    this.#profileVolumeName = options.profileVolumeName ?? null;
    this.#scope = options.scope && /^[a-zA-Z0-9_.-]{1,64}$/.test(options.scope)
      ? options.scope
      : createHash("sha256")
          .update(options.profileStore.dataDirectory)
          .digest("hex")
          .slice(0, 24);
    const managerUrl = options.workerManagerUrl;
    const managerToken = options.workerManagerToken;
    if (managerUrl || managerToken) {
      if (!managerUrl || !managerToken) throw new Error("Both worker-manager URL and token are required.");
      activeDockerExecutor = new RemoteDockerExecutor(managerUrl, managerToken);
      const proxy = fileURLToPath(new URL("../worker-manager/stdio-proxy.js", import.meta.url));
      this.#agentBrowser = new AgentBrowserBridge({
        workerTransport: (workerId) => ({
          command: process.execPath,
          args: [proxy],
          env: {
            BROWSERSILO_WORKER_MANAGER_URL: managerUrl,
            BROWSERSILO_WORKER_MANAGER_TOKEN: managerToken,
            BROWSERSILO_WORKER_MANAGER_STDIO_PORT: String(options.workerManagerStdioPort ?? 4201),
            BROWSERSILO_WORKER_CONTAINER: this.#worker(workerId).containerName,
          },
        }),
      });
    } else {
      activeDockerExecutor = new LocalDockerExecutor();
      this.#agentBrowser = new AgentBrowserBridge({
        workerTransport: (workerId) => ({
          command: "docker",
          args: [
            "exec", "-i", "-u", "1000", "-e", "HOME=/tmp", "-e",
            "AGENT_BROWSER_ENABLE=react-devtools", this.#worker(workerId).containerName,
            "agent-browser", "mcp", "--tools", "all",
          ],
        }),
      });
    }
  }

  async reconcileOrphans(state?: RuntimeState): Promise<number> {
    const output = await docker([
      "ps",
      "-a",
      "--filter",
      "label=browsesilo.managed=true",
      "--filter",
      `label=browsesilo.scope=${this.#scope}`,
      "--format",
      "{{.ID}}|{{.Names}}",
    ]);
    const entries = output.split("\n").map((line) => line.trim()).filter(Boolean)
      .map((line) => {
        const [id = "", name = ""] = line.split("|");
        return { id, name };
      });
    const containers: Array<{ id: string; name: string; value: Record<string, unknown> }> = [];
    for (const entry of entries) {
      const raw = await docker(["inspect", entry.id]).catch(() => null);
      if (!raw) continue;
      const inspected = JSON.parse(raw) as Array<Record<string, unknown>>;
      const container = inspected[0];
      if (container) containers.push({ ...entry, value: container });
    }
    const workers = containers.filter(({ value }) => {
      const config = value["Config"] as Record<string, unknown> | undefined;
      const labels = config?.["Labels"] as Record<string, unknown> | undefined;
      return labels?.["browsesilo.role"] !== "egress";
    });
    for (const { id: containerId, name: containerName, value: container } of workers) {
      const config = container?.["Config"] as Record<string, unknown> | undefined;
      const labels = config?.["Labels"] as Record<string, unknown> | undefined;
      const workerId = labels?.["browsesilo.worker-id"];
      const labelledProfileId = labels?.["browsesilo.profile-id"];
      const role = labels?.["browsesilo.role"];
      if (
        typeof workerId !== "string" ||
        typeof labelledProfileId !== "string" ||
        !isSafeResourceId(workerId) ||
        !isSafeResourceId(labelledProfileId)
      ) {
        await this.#removeContainer(containerId);
        continue;
      }
      const containerState = container?.["State"] as Record<string, unknown> | undefined;
      const running = containerState?.["Status"] === "running";
      const durableWorker = state?.workers?.[workerId];
      const durableLease = durableWorker?.leaseId
        ? state?.leases?.[durableWorker.leaseId]
        : undefined;
      const durableActive = !!durableWorker && !!durableLease &&
        durableWorker.everLeased &&
        new Set(["claimed", "active", "draining"]).has(durableWorker.state) &&
        new Set(["provisioning", "active", "releasing"]).has(durableLease.state) &&
        (durableLease.state !== "provisioning" || running);
      const profileId = durableActive ? durableLease.profileId : labelledProfileId;
      const record: ActiveDockerWorker = {
        workerId,
        leaseId: durableActive ? durableLease.id : String(labels?.["browsesilo.lease-id"] ?? "orphaned"),
        profileId,
        containerName: containerId,
        proxyContainerName: `${containerName}-egress`,
        networkName: typeof labels?.["browsesilo.network"] === "string"
          ? String(labels["browsesilo.network"])
          : `${containerName}-net`,
        profileDirectory: "",
        cdpPort: 9222,
        stopped: !running,
        egressPolicy: { allowedDomains: ["*"], blockPrivateNetworks: true },
        warm: !durableActive && role === "warm",
      };
      if (record.warm) {
        await this.#removeInfrastructure(record);
        await this.#profileStore.discard(workerId);
        continue;
      }
      if (running) await this.#closeBrowserAndContainer(record);
      else await this.#removeContainer(containerId);
      await this.#profileStore.commit(profileId, workerId);
    }
    for (const { id: containerId, value: container } of containers) {
      const config = container["Config"] as Record<string, unknown> | undefined;
      const labels = config?.["Labels"] as Record<string, unknown> | undefined;
      if (labels?.["browsesilo.role"] !== "egress") continue;
      await this.#removeContainer(containerId);
      const networkName = labels?.["browsesilo.network"];
      if (typeof networkName === "string" && isSafeDockerName(networkName)) {
        await docker(["network", "rm", networkName]).catch(() => undefined);
      }
    }
    const networkOutput = await docker([
      "network",
      "ls",
      "--filter",
      "label=browsesilo.managed=true",
      "--filter",
      `label=browsesilo.scope=${this.#scope}`,
      "--format",
      "{{.ID}}",
    ]);
    const networkIds = networkOutput.split("\n").map((line) => line.trim()).filter(Boolean);
    let removedNetworks = 0;
    for (const networkId of networkIds) {
      const removed = await docker(["network", "rm", networkId]).then(
        () => true,
        () => false,
      );
      if (removed) removedNetworks += 1;
    }
    return entries.length + removedNetworks;
  }

  capabilities(): WorkerRuntimeCapabilities {
    return {
      mode: "browser",
      adapter: "docker-brave-sandboxed",
      headedBrave: true,
      nativeCdp: true,
      browserActions: true,
      profilePersistence: "envelope-encrypted",
      limitations: [],
    };
  }

  async createWarmShell(workerId: string): Promise<WorkerDescriptor> {
    if (this.#workers.has(workerId)) {
      throw new Error(`Warm worker ${workerId} already exists.`);
    }
    const warmProfileId = `profile_warm_${createHash("sha256").update(workerId).digest("hex").slice(0, 16)}`;
    const profileDirectory = await this.#profileStore.materialize(warmProfileId, workerId);
    const containerName = `browsesilo-${safeContainerPart(workerId)}`;
    const record: ActiveDockerWorker = {
      workerId,
      leaseId: "unassigned",
      profileId: warmProfileId,
      containerName,
      proxyContainerName: `${containerName}-egress`,
      networkName: `${containerName}-net`,
      profileDirectory,
      cdpPort: 9222,
      stopped: true,
      egressPolicy: { allowedDomains: ["*"], blockPrivateNetworks: true },
      warm: true,
    };
    try {
      await this.#createNetwork(record);
      this.#workers.set(workerId, record);
    } catch (error) {
      await this.#removeInfrastructure(record);
      await this.#profileStore.discard(workerId);
      throw error;
    }
    return {
      runtimeRef: `docker-network-ready://${record.networkName}`,
      adapter: "docker-brave-sandboxed",
      braveVersion: null,
      cdpVersion: null,
    };
  }

  async activate(
    workerId: string,
    leaseId: string,
    profileId: string,
    egressPolicy: LeaseEgressPolicy,
  ): Promise<Partial<WorkerDescriptor>> {
    const warmRecord = this.#workers.get(workerId);
    if (warmRecord && !warmRecord.warm) {
      throw new BrowserSiloError(
        "BROWSER_START_FAILED",
        "The Docker worker identifier is already active.",
        500,
        { workerId },
      );
    }
    const profileDirectory = await this.#profileStore.materialize(
      profileId,
      workerId,
    );
    const containerName = `browsesilo-${safeContainerPart(workerId)}`;
    const record: ActiveDockerWorker = warmRecord ?? {
      workerId,
      leaseId,
      profileId,
      containerName,
      proxyContainerName: `${containerName}-egress`,
      networkName: `${containerName}-net`,
      profileDirectory,
      cdpPort: 0,
      stopped: false,
      egressPolicy,
      warm: false,
    };
    Object.assign(record, {
      leaseId,
      profileId,
      profileDirectory,
      stopped: false,
      egressPolicy,
      warm: false,
    });

    try {
      if (!warmRecord) await this.#createNetwork(record);
      await this.#startProxy(record);
      await docker(["run", "-d", ...this.#workerArguments(record)]);
      this.#workers.set(workerId, record);
      const version = await this.#waitForCdp(record);
      return {
        runtimeRef: `docker://${containerName}`,
        adapter: "docker-brave-sandboxed",
        braveVersion: stringValue(version["Browser"]),
        cdpVersion: stringValue(version["Protocol-Version"]),
      };
    } catch (error) {
      const logs = await docker(["logs", containerName]).catch(() => "");
      await this.#removeInfrastructure(record);
      this.#workers.delete(workerId);
      await this.#profileStore.discard(workerId);
      if (error instanceof BrowserSiloError) throw error;
      throw new BrowserSiloError(
        "BROWSER_START_FAILED",
        "The disposable Brave worker failed to start.",
        502,
        { workerId, cause: errorMessage(error), logs: logs.slice(-2_000) },
      );
    }
  }

  async destroy(workerId: string): Promise<void> {
    const record = this.#workers.get(workerId);
    if (!record) {
      throw new BrowserSiloError(
        "BROWSER_COMMAND_FAILED",
        "The Docker worker runtime cannot destroy an unknown active worker.",
        500,
        { workerId },
      );
    }
    if (record.warm) {
      await this.#removeInfrastructure(record);
      await this.#profileStore.discard(workerId);
      this.#workers.delete(workerId);
      return;
    }
    if (!record.stopped) {
      await this.#agentBrowser.closeWorker(workerId);
      await this.#closeBrowserAndContainer(record);
      record.stopped = true;
    }
    await this.#profileStore.commit(record.profileId, record.workerId);
    this.#workers.delete(workerId);
  }

  async shutdown(): Promise<void> {
    const workerIds = [...this.#workers.keys()];
    try {
      const outcomes = await Promise.allSettled(
        workerIds.map((workerId) => this.destroy(workerId)),
      );
      const failure = outcomes.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );
      if (failure) throw failure.reason;
    } finally {
      await this.#agentBrowser.close();
    }
  }

  async navigate(
    workerId: string,
    url: string,
  ): Promise<{ url: string; title: string }> {
    await this.agentTool(workerId, "agent_browser_open", { url });
    await this.agentTool(workerId, "agent_browser_wait_for_load", {
      state: "domcontentloaded",
      waitTimeoutMs: 30_000,
    });
    const [urlResult, titleResult] = await Promise.all([
      this.agentTool(workerId, "agent_browser_get_url", {}),
      this.agentTool(workerId, "agent_browser_get_title", {}),
    ]);
    return {
      url: String(toolData(urlResult)["url"] ?? url),
      title: String(toolData(titleResult)["title"] ?? ""),
    };
  }

  async snapshot(workerId: string): Promise<BrowserSnapshot> {
    const snapshotResult = await this.agentTool(workerId, "agent_browser_snapshot", {
      interactive: false,
      compact: false,
    });
    const data = toolData(snapshotResult);
    const refs = plainRecord(data["refs"]);
    const parsedText = parseSnapshotText(toolText(snapshotResult));
    const nodes: BrowserSnapshotNode[] = parsedText.nodes.length > 0
      ? parsedText.nodes
      : Object.values(refs).slice(0, 500).map((value) => {
          const ref = plainRecord(value);
          return {
            role: String(ref["role"] ?? "generic"),
            name: String(ref["name"] ?? ""),
            value: stringOrNull(ref["value"]),
            description: stringOrNull(ref["description"]),
            focused: ref["focused"] === true,
            disabled: ref["disabled"] === true,
          };
        });
    const elements: BrowserSnapshotElement[] = Object.keys(refs).length > 0
      ? Object.entries(refs).slice(0, 500).map(([refId, value]) => {
          const ref = plainRecord(value);
          return {
            tag: String(ref["role"] ?? "element"),
            selector: `@${refId}`,
            role: stringOrNull(ref["role"]),
            name: stringOrNull(ref["name"]),
            type: stringOrNull(ref["type"]),
            text: String(ref["name"] ?? ""),
            placeholder: stringOrNull(ref["placeholder"]),
          };
        })
      : parsedText.elements;
    const [urlResult, titleResult] = await Promise.all([
      this.agentTool(workerId, "agent_browser_get_url", {}),
      this.agentTool(workerId, "agent_browser_get_title", {}),
    ]);
    return {
      url: String(toolData(urlResult)["url"] ?? data["origin"] ?? ""),
      title: String(toolData(titleResult)["title"] ?? ""),
      nodes,
      elements,
    };
  }

  async screenshot(workerId: string, options: { fullPage?: boolean } = {}): Promise<BrowserScreenshot> {
    const result = await this.agentTool(workerId, "agent_browser_screenshot", {
      format: "png",
      fullPage: options.fullPage ?? true,
    });
    const image = result.content.find(
      (item) => item["type"] === "image" && typeof item["data"] === "string",
    );
    if (!image || typeof image["data"] !== "string") {
      throw new BrowserSiloError(
        "BROWSER_COMMAND_FAILED",
        "The private browser transport returned no screenshot.",
        502,
      );
    }
    return { mimeType: "image/png", data: image["data"] };
  }

  async click(workerId: string, selector: string): Promise<void> {
    await this.agentTool(workerId, "agent_browser_click", { selector });
  }

  async type(workerId: string, selector: string, text: string): Promise<void> {
    await this.agentTool(workerId, "agent_browser_fill", { selector, text });
  }

  async evaluate(workerId: string, expression: string): Promise<unknown> {
    const script = `(() => { const __browsersiloValue = (${expression}); return typeof __browsersiloValue === "function" ? __browsersiloValue() : __browsersiloValue; })()`;
    const data = toolData(
      await this.agentTool(workerId, "agent_browser_eval", {
        script,
      }),
    );
    return data["result"] ?? data["value"] ?? data;
  }

  async tabs(workerId: string): Promise<BrowserTab[]> {
    const data = toolData(
      await this.agentTool(workerId, "agent_browser_tab_list", {}),
    );
    const tabs = Array.isArray(data["tabs"]) ? data["tabs"] : [];
    return tabs.map((value, index) => {
      const tab = plainRecord(value);
      return {
        id: String(tab["id"] ?? index),
        type: String(tab["type"] ?? "page"),
        title: String(tab["title"] ?? ""),
        url: String(tab["url"] ?? ""),
      };
    });
  }

  async agentTool(
    workerId: string,
    toolName: string,
    arguments_: Record<string, unknown>,
  ): Promise<BrowserToolResult> {
    const worker = this.#worker(workerId);
    const targetUrl = arguments_["url"];
    if (typeof targetUrl === "string") {
      assertAllowedUrl(targetUrl, worker.egressPolicy);
    }
    if (toolName.startsWith("agent_browser_clipboard_")) {
      const location = toolData(await this.#agentBrowser.callTool(
        worker.workerId,
        worker.cdpPort,
        "agent_browser_get_url",
        {},
        worker.egressPolicy.allowedDomains,
      ));
      const origin = new URL(String(location["url"] ?? location["value"])).origin;
      await docker([
        "exec",
        "-u",
        "1000",
        worker.containerName,
        "/usr/local/bin/node",
        "/opt/browsersilo/grant-clipboard.mjs",
        origin,
      ]);
      if (toolName === "agent_browser_clipboard_read") {
        const text = await docker([
          "exec",
          "-u",
          "1000",
          "-e",
          "DISPLAY=:99",
          worker.containerName,
          "xclip",
          "-selection",
          "clipboard",
          "-out",
        ]);
        return {
          content: [{ type: "text", text }],
          structuredContent: { response: { data: { text } } },
        };
      }
    }
    if (toolName === "agent_browser_record_start") {
      return this.#startRecording(worker, arguments_);
    }
    if (toolName === "agent_browser_record_stop") {
      return this.#stopRecording(worker);
    }
    if (toolName === "agent_browser_record_restart") {
      await this.#stopRecording(worker);
      return this.#startRecording(worker, arguments_);
    }
    return this.#agentBrowser.callTool(
      worker.workerId,
      worker.cdpPort,
      toolName,
      arguments_,
      worker.egressPolicy.allowedDomains,
    );
  }

  async #startRecording(
    worker: ActiveDockerWorker,
    arguments_: Record<string, unknown>,
  ): Promise<BrowserToolResult> {
    const path = arguments_["path"];
    if (typeof path !== "string") {
      throw new BrowserSiloError("INVALID_REQUEST", "A brokered recording path is required.", 400);
    }
    assertBrokerPath(path);
    if (this.#recordings.has(worker.workerId)) {
      throw new BrowserSiloError("INVALID_REQUEST", "A recording is already active.", 409);
    }
    await docker([
      "exec",
      "-d",
      "-u",
      "1000",
      "-e",
      "DISPLAY=:99",
      worker.containerName,
      "ffmpeg",
      "-nostdin",
      "-y",
      "-f",
      "x11grab",
      "-video_size",
      "1440x900",
      "-framerate",
      "10",
      "-i",
      ":99",
      "-an",
      "-c:v",
      "libvpx",
      "-deadline",
      "realtime",
      "-cpu-used",
      "8",
      "-b:v",
      "800k",
      "-pix_fmt",
      "yuv420p",
      path,
    ]);
    this.#recordings.set(worker.workerId, path);
    await delay(300);
    return {
      content: [{ type: "text", text: "BrowserSilo screen recording started." }],
      structuredContent: { response: { data: { path, active: true } } },
    };
  }

  async #stopRecording(worker: ActiveDockerWorker): Promise<BrowserToolResult> {
    const path = this.#recordings.get(worker.workerId);
    if (!path) {
      throw new BrowserSiloError("INVALID_REQUEST", "No recording is active.", 409);
    }
    await docker([
      "exec",
      "-u",
      "1000",
      worker.containerName,
      "pkill",
      "-INT",
      "-x",
      "ffmpeg",
    ]);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const active = await docker([
        "exec",
        "-u",
        "1000",
        worker.containerName,
        "pgrep",
        "-x",
        "ffmpeg",
      ]).then(() => true, () => false);
      if (!active) break;
      await delay(50);
    }
    this.#recordings.delete(worker.workerId);
    return {
      content: [{ type: "text", text: "BrowserSilo screen recording stopped." }],
      structuredContent: { response: { data: { path, active: false } } },
    };
  }

  async stageFile(
    workerId: string,
    sourcePath: string,
    fileName: string,
  ): Promise<string> {
    const worker = this.#worker(workerId);
    const destination = await this.prepareFile(workerId, fileName);
    await dockerInputFile([
      "exec",
      "-i",
      "-u",
      "1000",
      worker.containerName,
      "dd",
      `of=${destination}`,
      "status=none",
    ], sourcePath);
    await docker(["exec", "-u", "1000", worker.containerName, "chmod", "0444", destination]);
    return destination;
  }

  async prepareFile(workerId: string, fileName: string): Promise<string> {
    const worker = this.#worker(workerId);
    const directory = `/tmp/browsersilo-broker/${randomUUID()}`;
    await docker([
      "exec",
      worker.containerName,
      "install",
      "-d",
      "-m",
      "700",
      "-o",
      "1000",
      "-g",
      "1000",
      directory,
    ]);
    return `${directory}/${safeFileName(fileName)}`;
  }

  async collectFile(
    workerId: string,
    containerPath: string,
    destination: string,
  ): Promise<void> {
    const worker = this.#worker(workerId);
    assertBrokerPath(containerPath);
    await dockerOutputFile([
      "exec",
      "-i",
      "-u",
      "1000",
      worker.containerName,
      "cat",
      containerPath,
    ], destination);
  }

  async removeFile(workerId: string, containerPath: string): Promise<void> {
    const worker = this.#worker(workerId);
    assertBrokerPath(containerPath);
    const directory = containerPath.slice(0, containerPath.lastIndexOf("/"));
    await docker(["exec", worker.containerName, "rm", "-rf", directory]);
  }

  async #createNetwork(record: ActiveDockerWorker): Promise<void> {
    await docker([
      "network",
      "create",
      "--internal",
      "--label",
      "browsesilo.managed=true",
      "--label",
      `browsesilo.scope=${this.#scope}`,
      "--label",
      `browsesilo.network=${record.networkName}`,
      record.networkName,
    ]);
  }

  async #startProxy(record: ActiveDockerWorker): Promise<void> {
    await docker([
      "run",
      "-d",
      "--name",
      record.proxyContainerName,
      "--label",
      "browsesilo.managed=true",
      "--label",
      "browsesilo.role=egress",
      "--label",
      `browsesilo.scope=${this.#scope}`,
      "--label",
      `browsesilo.network=${record.networkName}`,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges=true",
      "--memory",
      "134217728",
      "--cpus",
      "0.25",
      "--pids-limit",
      "64",
      "--network",
      "bridge",
      "-e",
      `BROWSERSILO_ALLOWED_DOMAINS=${record.egressPolicy.allowedDomains.join(",")}`,
      "--entrypoint",
      "/usr/local/bin/node",
      this.#image,
      "/opt/browsersilo/egress-proxy.mjs",
    ]);
    await docker([
      "network",
      "connect",
      "--alias",
      "egress",
      record.networkName,
      record.proxyContainerName,
    ]);
  }

  #workerArguments(record: ActiveDockerWorker): string[] {
    const profileMount = this.#profileVolumeName
      ? [
          "--mount",
          `type=volume,src=${this.#profileVolumeName},dst=/home/browser/.brave-profile,volume-subpath=${profileSubpath(this.#profileStore.dataDirectory, record.profileDirectory)}`,
        ]
      : ["-v", `${record.profileDirectory}:/home/browser/.brave-profile`];
    return [
      "--name",
      record.containerName,
      "--label",
      "browsesilo.managed=true",
      "--label",
      `browsesilo.role=${record.warm ? "warm" : "worker"}`,
      "--label",
      `browsesilo.worker-id=${record.workerId}`,
      "--label",
      `browsesilo.lease-id=${record.leaseId}`,
      "--label",
      `browsesilo.profile-id=${record.profileId}`,
      "--label",
      `browsesilo.scope=${this.#scope}`,
      "--label",
      `browsesilo.network=${record.networkName}`,
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=268435456",
      "--tmpfs",
      "/tmp/.X11-unix:rw,nosuid,nodev,mode=1777",
      "--tmpfs",
      "/home/browser/.config:rw,nosuid,nodev,size=67108864,uid=1000,gid=1000",
      "--tmpfs",
      "/home/browser/.cache:rw,nosuid,nodev,size=67108864,uid=1000,gid=1000",
      "--tmpfs",
      "/home/browser/.local:rw,nosuid,nodev,size=67108864,uid=1000,gid=1000",
      "--shm-size",
      "1g",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges=true",
      "--security-opt",
      `seccomp=${this.#seccompProfile}`,
      "--memory",
      String(this.#memoryBytes),
      "--cpus",
      String(this.#cpus),
      "--pids-limit",
      String(this.#pidsLimit),
      "--network",
      record.networkName,
      "-e",
      "BROWSERSILO_BRAVE_PROXY=http://egress:3128",
      "-e",
      "HTTP_PROXY=http://egress:3128",
      "-e",
      "HTTPS_PROXY=http://egress:3128",
      "-e",
      "NO_PROXY=127.0.0.1,localhost",
      ...profileMount,
      this.#image,
    ];
  }

  #worker(workerId: string): ActiveDockerWorker {
    const worker = this.#workers.get(workerId);
    if (!worker || worker.stopped) {
      throw new BrowserSiloError(
        "BROWSER_COMMAND_FAILED",
        "The active Docker browser worker was not found.",
        502,
        { workerId },
      );
    }
    return worker;
  }

  async #waitForCdp(
    worker: ActiveDockerWorker,
  ): Promise<Record<string, unknown>> {
    worker.cdpPort = 9222;
    let lastError: unknown;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const output = await docker([
          "exec",
          worker.containerName,
          "curl",
          "-fsS",
          "http://127.0.0.1:9222/json/version",
        ]);
        return JSON.parse(output) as Record<string, unknown>;
      } catch (error) {
        lastError = error;
      }
      const state = (await docker([
        "inspect",
        worker.containerName,
        "--format",
        "{{.State.Status}}",
      ])).trim();
      if (state !== "running") {
        const logs = await docker(["logs", worker.containerName]).catch(() => "");
        throw new Error(`Worker exited during startup. ${logs.slice(-500)}`);
      }
      await delay(200);
    }
    throw new Error(`CDP startup timed out: ${errorMessage(lastError)}`);
  }

  async #closeBrowserAndContainer(record: ActiveDockerWorker): Promise<void> {
    let exitedGracefully = false;
    try {
      await docker([
        "exec",
        "-u",
        "1000",
        record.containerName,
        "/usr/local/bin/node",
        "/opt/browsersilo/close-browser.mjs",
      ]).catch(() => "");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const state = await docker([
          "inspect",
          record.containerName,
          "--format",
          "{{.State.Status}}",
        ]).catch(() => "removed");
        if (state.trim() !== "running") {
          exitedGracefully = true;
          break;
        }
        await delay(100);
      }
    } catch {
      // Fall back to Docker's stop signal when CDP cannot close Brave cleanly.
    }

    try {
      if (!exitedGracefully) {
        await docker(["stop", "--timeout", "15", record.containerName]);
      }
    } finally {
      await this.#removeInfrastructure(record);
    }
  }

  async #removeContainer(containerName: string): Promise<void> {
    await docker(["rm", "-f", containerName]).catch(() => undefined);
  }

  async #removeInfrastructure(record: ActiveDockerWorker): Promise<void> {
    await Promise.all([
      this.#removeContainer(record.containerName),
      this.#removeContainer(record.proxyContainerName),
    ]);
    await docker(["network", "rm", record.networkName]).catch(() => undefined);
  }
}

class LocalDockerExecutor implements DockerExecutor {
  async command(args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("docker", args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(failure.stderr?.trim() || failure.message);
  }
  }

  async input(args: string[], sourcePath: string): Promise<void> {
  const child = spawn("docker", args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
  });
  const completed = new Promise<void>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(stderr.trim() || `docker exited with status ${code}.`));
    });
  });
  try {
    await Promise.all([pipeline(createReadStream(sourcePath), child.stdin), completed]);
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGTERM");
    throw error;
  }
  }

  async output(args: string[], destination: string): Promise<void> {
  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
  });
  const completed = new Promise<void>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(stderr.trim() || `docker exited with status ${code}.`));
    });
  });
  try {
    await Promise.all([
      pipeline(child.stdout, createWriteStream(destination, { mode: 0o600 })),
      completed,
    ]);
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGTERM");
    throw error;
  }
  }
}

let activeDockerExecutor: DockerExecutor = new LocalDockerExecutor();

function docker(args: string[]): Promise<string> {
  return activeDockerExecutor.command(args);
}

function dockerInputFile(args: string[], sourcePath: string): Promise<void> {
  return activeDockerExecutor.input(args, sourcePath);
}

function dockerOutputFile(args: string[], destination: string): Promise<void> {
  return activeDockerExecutor.output(args, destination);
}

function profileSubpath(dataDirectory: string, profileDirectory: string): string {
  const path = relative(dataDirectory, profileDirectory).split(sep).join("/");
  if (!/^runtime\/[a-zA-Z0-9_.-]+\/profile$/.test(path)) {
    throw new Error("The materialized profile path is outside the BrowserSilo data volume.");
  }
  return path;
}

function safeContainerPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48).toLowerCase();
}

function safeFileName(value: string): string {
  const name = value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 160);
  return name || "artifact.bin";
}

function assertBrokerPath(value: string): void {
  if (!/^\/tmp\/browsersilo-broker\/[a-f0-9-]+\/[a-zA-Z0-9_.-]+$/.test(value)) {
    throw new BrowserSiloError(
      "INVALID_REQUEST",
      "The browser artifact path is outside the broker staging area.",
      400,
    );
  }
}

function assertAllowedUrl(value: string, policy: LeaseEgressPolicy): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (!["http:", "https:"].includes(url.protocol)) return;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const allowed = policy.allowedDomains.some((pattern) => {
    if (pattern === "*") return true;
    const base = pattern.replace(/^\*\./, "");
    return host === base || host.endsWith(`.${base}`);
  });
  if (!allowed || isPrivateHost(host)) {
    throw new BrowserSiloError(
      "FORBIDDEN",
      "The destination is denied by this lease's egress policy.",
      403,
      { host },
    );
  }
}

function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return host.startsWith("fc") || host.startsWith("fd") || /^fe[89ab]/.test(host);
  }
  const a = parts[0] ?? -1;
  const b = parts[1] ?? -1;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168);
}

function isSafeResourceId(value: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(value);
}

function isSafeDockerName(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

function plainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toolData(result: BrowserToolResult): Record<string, unknown> {
  const structured = plainRecord(result.structuredContent);
  const response = plainRecord(structured["response"]);
  const data = response["data"] ?? structured["data"] ?? structured["result"];
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  if (data !== undefined) return { value: data };
  if (Object.keys(response).length > 0) return response;
  const text = toolText(result).trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const nested = record["data"] ?? record["result"];
      return nested && typeof nested === "object" && !Array.isArray(nested)
        ? nested as Record<string, unknown>
        : record;
    }
    return { value: parsed };
  } catch {
    return { value: text };
  }
}

function toolText(result: BrowserToolResult): string {
  return result.content
    .filter((item) => item["type"] === "text" && typeof item["text"] === "string")
    .map((item) => String(item["text"]))
    .join("\n");
}

function parseSnapshotText(text: string): {
  nodes: BrowserSnapshotNode[];
  elements: BrowserSnapshotElement[];
} {
  const nodes: BrowserSnapshotNode[] = [];
  const elements: BrowserSnapshotElement[] = [];
  for (const line of text.split("\n").slice(0, 1_000)) {
    const match = line.match(/^\s*-?\s*([a-zA-Z][\w-]*)(?:\s+"([^"]*)")?(.*)$/);
    if (!match) continue;
    const role = match[1]!.toLowerCase();
    const attributes = match[3] ?? "";
    const name = match[2]
      ?? attributes.match(/^:\s*(.*?)(?:\s+\[[^\]]+\])?$/)?.[1]
      ?? "";
    const ref = attributes.match(/\[ref=(e\d+)\]/)?.[1]
      ?? line.match(/@(e\d+)/)?.[1]
      ?? null;
    nodes.push({
      role,
      name,
      value: attributes.match(/value="([^"]*)"/)?.[1] ?? null,
      description: null,
      focused: /\bfocused\b/.test(attributes),
      disabled: /\bdisabled\b/.test(attributes),
    });
    if (ref) {
      elements.push({
        tag: role,
        selector: `@${ref}`,
        role,
        name: name || null,
        type: attributes.match(/type="([^"]*)"/)?.[1] ?? null,
        text: name,
        placeholder: attributes.match(/placeholder="([^"]*)"/)?.[1] ?? null,
      });
    }
  }
  return { nodes, elements };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown error";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
