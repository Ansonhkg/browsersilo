import http from "node:http";
import net from "node:net";
import dns from "node:dns/promises";

const blockedAddresses = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blockedAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
]) blockedAddresses.addSubnet(network, prefix, "ipv6");

const port = Number(process.env.BROWSERSILO_EGRESS_PORT ?? "3128");
const allowedDomains = parseDomains(process.env.BROWSERSILO_ALLOWED_DOMAINS ?? "*");

const server = http.createServer(async (request, response) => {
  try {
    const target = new URL(request.url ?? "");
    await authorize(target.hostname, Number(target.port || (target.protocol === "https:" ? 443 : 80)));
    const address = await publicAddress(target.hostname);
    const upstream = http.request(
      {
        host: address,
        port: Number(target.port || 80),
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers: { ...request.headers, host: target.host },
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.once("error", () => deny(response, 502, "Upstream connection failed."));
    request.pipe(upstream);
  } catch (error) {
    console.error("BrowserSilo egress HTTP denied:", error instanceof Error ? error.message : error);
    deny(response, 403, error instanceof Error ? error.message : "Egress denied.");
  }
});

server.on("connect", async (request, clientSocket, head) => {
  try {
    const { host, port: targetPort } = connectTarget(request.url ?? "");
    await authorize(host, targetPort);
    const address = await publicAddress(host);
    const upstream = net.connect({ host: address, port: targetPort });
    upstream.once("connect", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.once("error", () => clientSocket.destroy());
  } catch (error) {
    console.error("BrowserSilo egress CONNECT denied:", error instanceof Error ? error.message : error);
    clientSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  }
});

server.listen(port, "0.0.0.0");

function parseDomains(value) {
  const domains = value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  return domains.length > 0 ? domains : ["*"];
}

async function authorize(host, targetPort) {
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    throw new Error("Invalid destination port.");
  }
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!allowedDomains.some((pattern) => domainMatches(normalized, pattern))) {
    throw new Error("Destination domain is not allowed by this lease.");
  }
  await publicAddress(normalized);
}

async function publicAddress(host) {
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error("Private and special-use networks are blocked.");
    return host;
  }
  const answers = await dns.lookup(host, { all: true, verbatim: true });
  const publicAnswers = answers.filter((answer) => !isPrivateAddress(answer.address));
  if (publicAnswers.length === 0 || publicAnswers.length !== answers.length) {
    throw new Error("DNS resolution includes a private or special-use address.");
  }
  return publicAnswers[0].address;
}

function domainMatches(host, pattern) {
  if (pattern === "*") return true;
  const normalized = pattern.replace(/^https?:\/\//, "").split("/")[0].replace(/^\*\./, "");
  return host === normalized || host.endsWith(`.${normalized}`);
}

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 0) return true;
  if (family === 6 && /^::ffff:/i.test(address)) return true;
  return blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

function connectTarget(value) {
  const index = value.lastIndexOf(":");
  if (index < 1) throw new Error("CONNECT target is invalid.");
  return {
    host: value.slice(0, index).replace(/^\[|\]$/g, ""),
    port: Number(value.slice(index + 1)),
  };
}

function deny(response, status, message) {
  if (response.headersSent) return response.destroy();
  response.writeHead(status, { "content-type": "text/plain", "cache-control": "no-store" });
  response.end(message);
}
