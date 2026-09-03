import { startWorkerManager } from "./server.js";

const token = required("BROWSERSILO_WORKER_MANAGER_TOKEN");
const manager = await startWorkerManager({
  host: process.env["BROWSERSILO_WORKER_MANAGER_HOST"] ?? "0.0.0.0",
  port: integer("BROWSERSILO_WORKER_MANAGER_PORT", 4200),
  stdioPort: integer("BROWSERSILO_WORKER_MANAGER_STDIO_PORT", 4201),
  token,
  policy: {
    workerImage: process.env["BROWSERSILO_WORKER_IMAGE"] ?? "browsersilo/brave-worker:0.4.0",
    ...(process.env["BROWSERSILO_DATA_VOLUME"] ? { dataVolume: process.env["BROWSERSILO_DATA_VOLUME"] } : {}),
  },
});

console.log("BrowserSilo restricted worker manager is ready.");
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void manager.close().finally(() => process.exit(0)));
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
function integer(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} must be a valid port.`);
  return value;
}
