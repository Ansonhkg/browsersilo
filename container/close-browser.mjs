const versionResponse = await fetch("http://127.0.0.1:9222/json/version", {
  signal: AbortSignal.timeout(2_000),
});
if (!versionResponse.ok) {
  throw new Error(`CDP version endpoint returned HTTP ${versionResponse.status}.`);
}
const version = await versionResponse.json();
if (typeof version.webSocketDebuggerUrl !== "string") {
  throw new Error("CDP version response has no browser WebSocket URL.");
}

await new Promise((resolve, reject) => {
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  const timeout = setTimeout(() => {
    socket.close();
    reject(new Error("Timed out waiting for Brave to acknowledge Browser.close."));
  }, 5_000);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== 1) return;
    clearTimeout(timeout);
    socket.close();
    resolve();
  });
  socket.addEventListener("close", () => {
    clearTimeout(timeout);
    resolve();
  });
  socket.addEventListener("error", () => {
    clearTimeout(timeout);
    reject(new Error("The Brave CDP socket failed while closing the browser."));
  });
});
