const SAFE_CONTAINER = /^(?:[a-f0-9]{12,64}|browsesilo-[a-z0-9_.-]{1,96})$/;
const SAFE_NETWORK = /^(?:[a-f0-9]{12,64}|browsesilo-[a-z0-9_.-]{1,96}-net)$/;
const SAFE_VOLUME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export interface WorkerManagerPolicy {
  workerImage: string;
  dataVolume?: string;
}

export function assertApprovedDockerArguments(
  args: string[],
  policy: WorkerManagerPolicy,
  streamMode: "none" | "input" | "output" = "none",
): void {
  if (args.length < 1 || args.length > 160 || args.some((value) => value.length > 4096 || value.includes("\0"))) {
    throw new Error("The Docker operation is outside the worker-manager policy.");
  }
  const operation = args[0];
  if (operation === "ps") return assertPs(args);
  if (operation === "inspect") return assertTargets(args.slice(1), SAFE_CONTAINER);
  if (operation === "logs") return assertTargets(args.slice(1), SAFE_CONTAINER);
  if (operation === "top") return assertTargets([args[1] ?? ""], SAFE_CONTAINER);
  if (operation === "stop") return assertStop(args);
  if (operation === "rm") return assertRemove(args);
  if (operation === "network") return assertNetwork(args);
  if (operation === "run") return assertRun(args, policy);
  if (operation === "exec") return assertExec(args, streamMode);
  throw new Error(`Docker operation ${String(operation)} is not approved.`);
}

function assertPs(args: string[]): void {
  const joined = args.join(" ");
  if (!args.includes("-a") || !joined.includes("label=browsesilo.managed=true")) {
    throw new Error("Container discovery must be limited to BrowserSilo-managed resources.");
  }
}

function assertTargets(targets: string[], pattern: RegExp): void {
  if (!targets.some((value) => pattern.test(value))) {
    throw new Error("The Docker target is not a BrowserSilo-managed resource.");
  }
}

function assertStop(args: string[]): void {
  const target = args.at(-1) ?? "";
  if (!SAFE_CONTAINER.test(target) || args.some((value) => value === "--time=0" || value === "--timeout=0")) {
    throw new Error("The requested stop operation is not approved.");
  }
}

function assertRemove(args: string[]): void {
  assertTargets(args.slice(1), SAFE_CONTAINER);
  if (args.some((value) => value === "-v" || value === "--volumes")) {
    throw new Error("Worker-manager container removal cannot delete volumes.");
  }
}

function assertNetwork(args: string[]): void {
  const action = args[1];
  if (!action || !new Set(["create", "connect", "rm", "ls"]).has(action)) {
    throw new Error("The network operation is not approved.");
  }
  if (action === "ls") {
    const joined = args.join(" ");
    if (!joined.includes("label=browsesilo.managed=true")) throw new Error("Network discovery must be label-scoped.");
    return;
  }
  const candidates = action === "connect" ? [args.at(-2) ?? "", args.at(-1) ?? ""] : [args.at(-1) ?? ""];
  if (candidates.some((value, index) => index === 0 && action === "connect" ? !SAFE_NETWORK.test(value) : !/^(?:[a-f0-9]{12,64}|browsesilo-[a-z0-9_.-]{1,110}(?:-net|-egress)?)$/.test(value))) {
    throw new Error("The network target is not BrowserSilo-managed.");
  }
  if (args.includes("--internal") && action !== "create") throw new Error("Invalid internal network operation.");
}

function assertRun(args: string[], policy: WorkerManagerPolicy): void {
  const forbidden = new Set([
    "--privileged", "--pid=host", "--network=host", "--ipc=host", "--uts=host",
    "--cap-add", "--device", "-p", "--publish", "-P", "--publish-all",
  ]);
  if (args.some((value) => forbidden.has(value) || value.startsWith("--cap-add=") || value.startsWith("--device="))) {
    throw new Error("The worker-manager rejected a privileged Docker option.");
  }
  if (args.some((value) => value.startsWith("--privileged=") || value.startsWith("--pid=host") ||
    value.startsWith("--ipc=host") || value.startsWith("--uts=host"))) {
    throw new Error("The worker-manager rejected a privileged Docker option.");
  }
  if (!args.includes("--cap-drop") || !args.includes("ALL") ||
    (!args.includes("no-new-privileges:true") && !args.includes("no-new-privileges=true"))) {
    throw new Error("Workers must drop capabilities and enable no-new-privileges.");
  }
  const imageIndex = args.findIndex((value) => value === policy.workerImage);
  const tail = imageIndex >= 0 ? args.slice(imageIndex + 1) : [];
  const approvedProxyTail = tail.length === 1 && tail[0] === "/opt/browsersilo/egress-proxy.mjs" &&
    args.some((value, index) => value === "--entrypoint" && args[index + 1] === "/usr/local/bin/node");
  if (imageIndex < 1 || (tail.length > 0 && !approvedProxyTail)) {
    throw new Error("Only the configured BrowserSilo worker image is approved.");
  }
  if (args.some((value) => value.startsWith("--entrypoint=") ||
    (value === "--entrypoint" && !approvedProxyTail))) {
    throw new Error("The requested entrypoint is not approved.");
  }
  const networkValues = args.filter((_value, index) => args[index - 1] === "--network");
  if (networkValues.length !== 1 || networkValues.some((value) => value !== "bridge" && !SAFE_NETWORK.test(value))) {
    throw new Error("The worker network is not approved.");
  }
  const securityOptions = args.filter((_value, index) => args[index - 1] === "--security-opt");
  if (securityOptions.some((value) => value !== "no-new-privileges=true" &&
    value !== "no-new-privileges:true" && !/^seccomp=\/app\/container\/brave-seccomp\.json$/.test(value))) {
    throw new Error("The worker security option is not approved.");
  }
  const names = args.filter((_value, index) => args[index - 1] === "--name");
  if (names.length !== 1 || !SAFE_CONTAINER.test(names[0]!)) throw new Error("A managed worker name is required.");
  const labels = args.filter((_value, index) => args[index - 1] === "--label");
  if (!labels.includes("browsesilo.managed=true")) throw new Error("The BrowserSilo managed label is required.");
  const mounts = args.filter((_value, index) => args[index - 1] === "--mount");
  if (mounts.length > 1) throw new Error("Only the encrypted profile volume mount is approved.");
  for (const mount of mounts) {
    const values = Object.fromEntries(mount.split(",").map((part) => part.split("=", 2) as [string, string]));
    if (values["type"] !== "volume" || values["src"] !== policy.dataVolume ||
      values["dst"] !== "/home/browser/.brave-profile" ||
      !/^runtime\/[a-zA-Z0-9_.-]+\/profile$/.test(values["volume-subpath"] ?? "")) {
      throw new Error("The worker profile mount is not approved.");
    }
  }
  if (args.includes("-v") || args.includes("--volume")) throw new Error("Host bind mounts are not approved.");
  if (policy.dataVolume && !SAFE_VOLUME.test(policy.dataVolume)) throw new Error("The data volume name is invalid.");
}

function assertExec(args: string[], streamMode: "none" | "input" | "output"): void {
  const containerIndex = args.findIndex((value, index) => index > 0 && SAFE_CONTAINER.test(value));
  if (containerIndex < 1) throw new Error("A managed container target is required.");
  const command = args[containerIndex + 1];
  const allowed = new Set([
    "agent-browser", "/usr/local/bin/node", "curl", "xclip", "ffmpeg", "pkill", "pgrep",
    "chmod", "install", "dd", "cat", "mkdir", "rm", "test", "sh",
  ]);
  if (!command || !allowed.has(command)) throw new Error("The private worker command is not approved.");
  if (command === "curl") {
    const tail = args.slice(containerIndex + 1);
    if (tail.join(" ") !== "curl -fsS http://127.0.0.1:9222/json/version") {
      throw new Error("Only loopback CDP readiness checks are approved.");
    }
  }
  const brokerPath = /^\/tmp\/browsersilo-broker\/[a-f0-9-]+(?:\/[a-zA-Z0-9_.-]+)?$/;
  const commandArgs = args.slice(containerIndex + 2);
  if (command === "install") {
    const destination = commandArgs.at(-1) ?? "";
    if (!brokerPath.test(destination) || commandArgs.slice(0, -1).join(" ") !== "-d -m 700 -o 1000 -g 1000") {
      throw new Error("Only broker directory creation is approved.");
    }
  }
  if (command === "dd") {
    const output = commandArgs.find((value) => value.startsWith("of="))?.slice(3) ?? "";
    if (streamMode !== "input" || !brokerPath.test(output) || !commandArgs.includes("status=none")) {
      throw new Error("Only brokered file input is approved.");
    }
  }
  if (command === "cat" && (streamMode !== "output" || commandArgs.length !== 1 || !brokerPath.test(commandArgs[0]!))) {
    throw new Error("Only brokered file output is approved.");
  }
  if (command === "chmod" && (commandArgs[0] !== "0444" || !brokerPath.test(commandArgs[1] ?? ""))) {
    throw new Error("Only broker artifact permission changes are approved.");
  }
  if (command === "rm" && (commandArgs[0] !== "-rf" || !brokerPath.test(commandArgs[1] ?? ""))) {
    throw new Error("Only broker artifact cleanup is approved.");
  }
  if (command === "pkill" && commandArgs.join(" ") !== "-INT -x ffmpeg") {
    throw new Error("Only graceful recording shutdown is approved.");
  }
  if (command === "pgrep" && commandArgs.join(" ") !== "-x ffmpeg") {
    throw new Error("Only recording status inspection is approved.");
  }
  if (command === "sh" && !new Set(["input", "output"]).has(streamMode)) {
    throw new Error("Shell is allowed only for brokered file streaming.");
  }
  const joined = args.slice(containerIndex + 1).join(" ");
  if (joined.includes("/etc/") || joined.includes("/proc/") || joined.includes("/var/run/")) {
    throw new Error("The private worker path is not approved.");
  }
}
