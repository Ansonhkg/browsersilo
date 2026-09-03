const origin = process.argv[2];
if (!origin || new URL(origin).origin !== origin) {
  throw new Error("A normalized page origin is required for clipboard permission.");
}

const [versionResponse, targetsResponse] = await Promise.all([
  fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(2_000) }),
  fetch("http://127.0.0.1:9222/json/list", { signal: AbortSignal.timeout(2_000) }),
]);
if (!versionResponse.ok || !targetsResponse.ok) {
  throw new Error("CDP discovery failed while preparing clipboard access.");
}
const version = await versionResponse.json();
const targets = await targetsResponse.json();
if (typeof version.webSocketDebuggerUrl !== "string") {
  throw new Error("CDP version response has no browser WebSocket URL.");
}
const page = Array.isArray(targets)
  ? targets.find((target) => target?.type === "page" && typeof target.webSocketDebuggerUrl === "string")
  : null;
if (!page) throw new Error("CDP discovery found no page target.");

await cdpCommand(version.webSocketDebuggerUrl, "Browser.grantPermissions", {
  permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  origin,
});
await cdpCommand(page.webSocketDebuggerUrl, "Page.bringToFront", {});
await cdpCommand(page.webSocketDebuggerUrl, "Runtime.evaluate", {
  expression: "window.focus()",
  returnByValue: true,
});

function cdpCommand(url, method, params) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out running ${method}.`));
    }, 5_000);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method, params }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timeout);
      socket.close();
      if (message.error) reject(new Error(String(message.error.message ?? `${method} failed.`)));
      else resolve(message.result);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(`The CDP socket failed while running ${method}.`));
    });
  });
}
