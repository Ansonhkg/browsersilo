import { connect } from "node:net";

const url = new URL(required("BROWSERSILO_WORKER_MANAGER_URL"));
const token = required("BROWSERSILO_WORKER_MANAGER_TOKEN");
const containerName = required("BROWSERSILO_WORKER_CONTAINER");
const port = Number(process.env["BROWSERSILO_WORKER_MANAGER_STDIO_PORT"] ?? "4201");
const socket = connect({ host: url.hostname, port }, () => {
  socket.write(`${JSON.stringify({ token, containerName })}\n`);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.on("error", (error) => {
  console.error(`BrowserSilo worker transport failed: ${error.message}`);
  process.exitCode = 1;
});
socket.on("close", () => process.exit());

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
