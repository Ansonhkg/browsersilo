import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { LocalEncryptedProfileStore } from "../adapters/encrypted-profile-store.js";
import type {
  ArtifactKind,
  EncryptedArtifactStore,
} from "../artifacts/encrypted-artifact-store.js";
import { ARTIFACT_KINDS } from "../artifacts/encrypted-artifact-store.js";
import { BrowserSiloError } from "../core/errors.js";
import type { AdminSnapshot, PoolConfiguration, Principal } from "../core/model.js";
import type { BrowserSiloCore } from "../core/service.js";
import type { BrowserAutomationService } from "../browser/service.js";
import { serveAdminUi } from "./admin-ui.js";
import { RuntimeObservability } from "../observability/service.js";
import type { OperatorSettings, OperatorSettingsStore } from "../config/operator-settings.js";
import { BrowserGatewayService, type PublicBrowserAction } from "../browser/gateway.js";
import { attachLiveWebSocket } from "../realtime/websocket.js";
import { StreamableMcpGateway } from "../mcp/http-gateway.js";
import { browserSiloOpenApi } from "./openapi.js";

export interface ServerConfiguration {
  host: string;
  browserPort: number;
  adminPort: number;
  agentToken?: string;
  adminToken: string;
  localPrincipal?: Principal;
  agentCredentials?: AgentCredential[];
  automation?: BrowserAutomationService;
  profileStore?: LocalEncryptedProfileStore;
  artifactStore?: EncryptedArtifactStore;
  observability?: RuntimeObservability;
  operatorSettings?: OperatorSettingsStore;
  effectiveOperatorSettings?: OperatorSettings;
  gateway?: BrowserGatewayService;
  liveAllowedOrigins?: string[];
  mcpGateway?: StreamableMcpGateway;
}

export interface AgentCredential {
  tokenHash: string;
  principal: Principal;
}

export function createAgentCredential(
  token: string,
  principal: Principal,
): AgentCredential {
  if (token.length < 16) throw new Error("BrowserSilo agent tokens must be at least 16 characters.");
  return { tokenHash: tokenHash(token), principal: { ...principal } };
}

export interface RunningServers {
  browserPort: number;
  adminPort: number;
  close(): Promise<void>;
}

export async function startServers(
  core: BrowserSiloCore,
  config: ServerConfiguration,
): Promise<RunningServers> {
  const observability = config.observability ?? new RuntimeObservability();
  config.observability = observability;
  if (!config.gateway && config.automation) {
    config.gateway = new BrowserGatewayService(core, config.automation);
  }
  const browserServer = createServer((request, response) => {
    void handle(request, response, observability, () =>
      routeBrowser(core, config, request, response),
    );
  });
  const mcpGateway = new StreamableMcpGateway(() => {
    const address = browserServer.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  });
  config.mcpGateway = mcpGateway;
  const adminServer = createServer((request, response) => {
    void handle(request, response, observability, () =>
      routeAdmin(core, config, request, response),
    );
  });
  const detachBrowserLiveWebSocket = config.gateway
    ? attachLiveWebSocket(browserServer, config.gateway, {
        ...(config.liveAllowedOrigins ? { allowedOrigins: config.liveAllowedOrigins } : {}),
      })
    : () => undefined;
  const detachAdminLiveWebSocket = config.gateway
    ? attachLiveWebSocket(adminServer, config.gateway, {
        ...(config.liveAllowedOrigins ? { allowedOrigins: config.liveAllowedOrigins } : {}),
      })
    : () => undefined;

  await Promise.all([
    listen(browserServer, config.browserPort, config.host),
    listen(adminServer, config.adminPort, config.host),
  ]);

  return {
    browserPort: (browserServer.address() as AddressInfo).port,
    adminPort: (adminServer.address() as AddressInfo).port,
    async close() {
      detachBrowserLiveWebSocket();
      detachAdminLiveWebSocket();
      await mcpGateway.close();
      await Promise.all([close(browserServer), close(adminServer)]);
    },
  };
}

async function routeBrowser(
  core: BrowserSiloCore,
  config: ServerConfiguration,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://browsesilo.local");
  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, { status: "ok", plane: "browser" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/ready") {
    json(response, config.gateway ? 200 : 503, {
      status: config.gateway ? "ready" : "not-ready",
      storage: config.profileStore ? "ready" : "unavailable",
      encryption: config.profileStore ? "ready" : "unavailable",
      browserWorkers: config.gateway ? "ready" : "unavailable",
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/version") {
    json(response, 200, {
      product: "BrowserSilo",
      version: "0.4.0",
      api: "v1",
      mcp: "streamable-http",
      websocket: "browsersilo.v1",
      compatibleWorker: "0.4.x",
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/openapi.json") {
    json(response, 200, browserSiloOpenApi);
    return;
  }

  const principal = authenticateAgent(request, config);
  if (url.pathname === "/mcp" && new Set(["POST", "GET", "DELETE"]).has(request.method ?? "")) {
    await config.mcpGateway!.handle(request, response, bearerToken(request)!);
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/browsers") {
    const body = await readObject(request);
    const ttlSeconds = optionalNumber(body, "ttlSeconds");
    const allowedDomains = optionalStringArray(body, "allowedDomains");
    json(
      response,
      201,
      await requireGateway(config).open(principal, {
        identity: requiredString(body, "identity"),
        ...(allowedDomains ? { allowedDomains } : {}),
        ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
        ...(header(request, "idempotency-key")
          ? { idempotencyKey: header(request, "idempotency-key")! }
          : {}),
      }),
    );
    return;
  }

  const browserEventsMatch = url.pathname.match(/^\/v1\/browsers\/([^/]+)\/events$/);
  if (request.method === "GET" && browserEventsMatch?.[1]) {
    await streamBrowserEvents(
      requireGateway(config),
      principal,
      browserEventsMatch[1],
      request,
      response,
    );
    return;
  }

  const browserLiveTokenMatch = url.pathname.match(/^\/v1\/browsers\/([^/]+)\/live-token$/);
  if (request.method === "POST" && browserLiveTokenMatch?.[1]) {
    const body = await readObject(request);
    const role = body["role"] ?? "observe";
    if (!new Set(["observe", "assist", "takeover"]).has(String(role))) {
      throw new BrowserSiloError("INVALID_REQUEST", "The live role is invalid.", 400);
    }
    json(
      response,
      201,
      await requireGateway(config).issueLiveToken(
        principal,
        browserLiveTokenMatch[1],
        role as "observe" | "assist" | "takeover",
      ),
    );
    return;
  }

  const browserBatchMatch = url.pathname.match(/^\/v1\/browsers\/([^/]+)\/actions:batch$/);
  if (request.method === "POST" && browserBatchMatch?.[1]) {
    const body = await readObject(request);
    const actions = requiredActionArray(body, "actions");
    json(
      response,
      200,
      {
        results: await requireGateway(config).batch(
          principal,
          browserBatchMatch[1],
          actions,
          body["stopOnError"] !== false,
        ),
      },
    );
    return;
  }

  const browserActionMatch = url.pathname.match(/^\/v1\/browsers\/([^/]+)\/actions$/);
  if (request.method === "POST" && browserActionMatch?.[1]) {
    const body = await readObject(request);
    json(
      response,
      200,
      { result: await requireGateway(config).action(principal, browserActionMatch[1], publicAction(body)) },
    );
    return;
  }

  const browserSnapshotMatch = url.pathname.match(/^\/v1\/browsers\/([^/]+)\/snapshot$/);
  if (request.method === "GET" && browserSnapshotMatch?.[1]) {
    json(
      response,
      200,
      await requireGateway(config).action(principal, browserSnapshotMatch[1], { type: "snapshot" }),
    );
    return;
  }

  const browserCaptureStopMatch = url.pathname.match(/^\/v1\/browsers\/([^/]+)\/captures\/current\/stop$/);
  if (request.method === "POST" && browserCaptureStopMatch?.[1]) {
    json(response, 201, await requireGateway(config).endCapture(principal, browserCaptureStopMatch[1]));
    return;
  }

  const browserCaptureMatch = url.pathname.match(/^\/v1\/browsers\/([^/]+)\/captures$/);
  if (request.method === "POST" && browserCaptureMatch?.[1]) {
    const body = await readObject(request);
    json(
      response,
      201,
      await requireGateway(config).beginCapture(principal, browserCaptureMatch[1], {
        domain: requiredString(body, "domain"),
        redactSecrets: body["redactSecrets"] !== false,
        includeTrace: body["includeTrace"] !== false,
        includeVideo: body["includeVideo"] === true,
      }),
    );
    return;
  }

  const browserMatch = url.pathname.match(/^\/v1\/browsers\/([^/]+)$/);
  if (request.method === "GET" && browserMatch?.[1]) {
    json(response, 200, await requireGateway(config).get(principal, browserMatch[1]));
    return;
  }
  if (request.method === "DELETE" && browserMatch?.[1]) {
    json(response, 200, await requireGateway(config).close(principal, browserMatch[1]));
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/capabilities") {
    json(response, 200, core.capabilities());
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/profiles") {
    json(response, 200, { profiles: await core.listProfiles(principal) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/profiles") {
    const body = await readObject(request);
    const profile = await core.createProfile(principal, {
      name: requiredString(body, "name"),
    });
    json(response, 201, profile);
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/artifacts") {
    const store = requireArtifactStore(config);
    const kind = url.searchParams.get("kind") ?? undefined;
    const allowedKinds = new Set<string>(ARTIFACT_KINDS);
    if (kind && !allowedKinds.has(kind)) {
      throw new BrowserSiloError("INVALID_REQUEST", "Artifact kind is invalid.", 400);
    }
    json(response, 200, {
      artifacts: await store.list(principal, {
        ...(kind ? { kind: kind as ArtifactKind } : {}),
        ...(url.searchParams.get("leaseId")
          ? { leaseId: url.searchParams.get("leaseId")! }
          : {}),
        ...(url.searchParams.get("profileId")
          ? { profileId: url.searchParams.get("profileId")! }
          : {}),
        ...(url.searchParams.get("q") ? { text: url.searchParams.get("q")! } : {}),
      }),
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/artifacts") {
    const store = requireArtifactStore(config);
    const rawKind = header(request, "x-browsersilo-artifact-kind") ?? "upload";
    if (!(ARTIFACT_KINDS as readonly string[]).includes(rawKind)) {
      throw new BrowserSiloError("INVALID_REQUEST", "Artifact kind is invalid.", 400);
    }
    const kind = rawKind as ArtifactKind;
    const name = header(request, "x-browsersilo-artifact-name") ?? "upload.bin";
    const mimeType = header(request, "content-type") ?? "application/octet-stream";
    const directory = await mkdtemp(join(tmpdir(), "browsersilo-artifact-"));
    const source = join(directory, "payload");
    try {
      await streamRequestToFile(request, source, 512 * 1024 * 1024);
      json(response, 201, await store.put({
        principal,
        kind,
        name,
        mimeType,
        sourcePath: source,
      }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    return;
  }

  const artifactExportMatch = url.pathname.match(/^\/v1\/artifacts\/([^/]+)\/export$/);
  if (request.method === "GET" && artifactExportMatch?.[1]) {
    const store = requireArtifactStore(config);
    const directory = await mkdtemp(join(tmpdir(), "browsersilo-export-"));
    const destination = join(directory, "artifact");
    try {
      const artifact = await store.exportTo(principal, artifactExportMatch[1], destination);
      response.writeHead(200, {
        "content-type": artifact.mimeType,
        "content-disposition": `attachment; filename="${artifact.name.replaceAll('"', "_")}"`,
        "content-length": artifact.size,
        "cache-control": "no-store",
      });
      await pipeline(createReadStream(destination), response);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    return;
  }

  const artifactMatch = url.pathname.match(/^\/v1\/artifacts\/([^/]+)$/);
  if (request.method === "GET" && artifactMatch?.[1]) {
    json(response, 200, await requireArtifactStore(config).get(principal, artifactMatch[1]));
    return;
  }
  if (request.method === "DELETE" && artifactMatch?.[1]) {
    await requireArtifactStore(config).delete(principal, artifactMatch[1]);
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/profiles/import") {
    const store = requireProfileStore(config);
    const name = header(request, "x-browsersilo-profile-name")?.trim();
    if (!name) {
      throw new BrowserSiloError(
        "INVALID_REQUEST",
        "x-browsersilo-profile-name is required.",
        400,
      );
    }
    const profile = await core.createProfile(principal, { name });
    const directory = await mkdtemp(join(tmpdir(), "browsersilo-import-"));
    const source = join(directory, "profile.bslp");
    try {
      await streamRequestToFile(request, source, 2 * 1024 * 1024 * 1024);
      await store.importArchive(profile.id, source);
      json(response, 201, profile);
    } catch (error) {
      await store.deleteArchive(profile.id);
      await core.deleteProfile(principal, profile.id);
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    return;
  }

  const profileExportMatch = url.pathname.match(/^\/v1\/profiles\/([^/]+)\/export$/);
  if (request.method === "GET" && profileExportMatch?.[1]) {
    const profileId = profileExportMatch[1];
    await core.assertProfileIdle(principal, profileId);
    const store = requireProfileStore(config);
    const directory = await mkdtemp(join(tmpdir(), "browsersilo-export-"));
    const destination = join(directory, `${profileId}.bslp`);
    try {
      await store.exportArchive(profileId, destination);
      response.writeHead(200, {
        "content-type": "application/vnd.browsersilo.profile",
        "content-disposition": `attachment; filename="${profileId}.bslp"`,
        "cache-control": "no-store",
      });
      await pipeline(createReadStream(destination), response);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    return;
  }

  const profileRotateMatch = url.pathname.match(/^\/v1\/profiles\/([^/]+)\/rotate$/);
  if (request.method === "POST" && profileRotateMatch?.[1]) {
    await core.assertProfileIdle(principal, profileRotateMatch[1]);
    await requireProfileStore(config).rotateArchive(profileRotateMatch[1]);
    json(response, 200, { ok: true, profileId: profileRotateMatch[1] });
    return;
  }

  const profileMatch = url.pathname.match(/^\/v1\/profiles\/([^/]+)$/);
  if (request.method === "GET" && profileMatch?.[1]) {
    json(response, 200, await core.getProfile(principal, profileMatch[1]));
    return;
  }
  if (request.method === "DELETE" && profileMatch?.[1]) {
    await core.assertProfileIdle(principal, profileMatch[1]);
    await requireProfileStore(config).deleteArchive(profileMatch[1]);
    await core.deleteProfile(principal, profileMatch[1]);
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/leases") {
    const body = await readObject(request);
    const input: {
      profileId: string;
      ttlSeconds?: number;
      idempotencyKey?: string;
      allowedDomains?: string[];
    } = { profileId: requiredString(body, "profileId") };
    const ttlSeconds = optionalNumber(body, "ttlSeconds");
    if (ttlSeconds !== undefined) input.ttlSeconds = ttlSeconds;
    const idempotencyHeader = header(request, "idempotency-key");
    if (idempotencyHeader) input.idempotencyKey = idempotencyHeader;
    const allowedDomains = optionalStringArray(body, "allowedDomains");
    if (allowedDomains) input.allowedDomains = allowedDomains;
    json(response, 201, await core.acquireLease(principal, input));
    return;
  }

  const leaseMatch = url.pathname.match(/^\/v1\/leases\/([^/]+)$/);
  if (request.method === "GET" && leaseMatch?.[1]) {
    json(response, 200, await core.getLease(principal, leaseMatch[1]));
    return;
  }

  const renewMatch = url.pathname.match(/^\/v1\/leases\/([^/]+)\/renew$/);
  if (request.method === "POST" && renewMatch?.[1]) {
    const body = await readObject(request);
    const input: { fencingToken: number; ttlSeconds?: number } = {
      fencingToken: requiredNumber(body, "fencingToken"),
    };
    const ttlSeconds = optionalNumber(body, "ttlSeconds");
    if (ttlSeconds !== undefined) input.ttlSeconds = ttlSeconds;
    json(response, 200, await core.renewLease(principal, renewMatch[1], input));
    return;
  }

  const releaseMatch = url.pathname.match(/^\/v1\/leases\/([^/]+)\/release$/);
  if (request.method === "POST" && releaseMatch?.[1]) {
    const body = await readObject(request);
    const fencingToken = requiredNumber(body, "fencingToken");
    if (config.automation) {
      await config.automation.finalizeLease(principal, releaseMatch[1], fencingToken);
    }
    json(
      response,
      200,
      await core.releaseLease(principal, releaseMatch[1], {
        fencingToken,
      }),
    );
    return;
  }

  const parityToolMatch = url.pathname.match(
    /^\/v1\/leases\/([^/]+)\/tools\/(agent_browser_[a-z0-9_]+)$/,
  );
  if (request.method === "POST" && parityToolMatch?.[1] && parityToolMatch[2]) {
    const automation = requireAutomation(config);
    const body = await readObject(request);
    json(
      response,
      200,
      await automation.agentTool(
        principal,
        parityToolMatch[1],
        requiredNumber(body, "fencingToken"),
        parityToolMatch[2],
        requiredObject(body, "arguments"),
      ),
    );
    return;
  }

  const actionMatch = url.pathname.match(
    /^\/v1\/leases\/([^/]+)\/(navigate|snapshot|screenshot|click|type|evaluate|tabs)$/,
  );
  if (request.method === "POST" && actionMatch?.[1] && actionMatch[2]) {
    const automation = requireAutomation(config);
    const body = await readObject(request);
    const fencingToken = requiredNumber(body, "fencingToken");
    const leaseId = actionMatch[1];
    switch (actionMatch[2]) {
      case "navigate":
        json(
          response,
          200,
          await automation.navigate(
            principal,
            leaseId,
            fencingToken,
            requiredString(body, "url"),
          ),
        );
        return;
      case "snapshot":
        json(
          response,
          200,
          await automation.snapshot(principal, leaseId, fencingToken),
        );
        return;
      case "screenshot":
        json(
          response,
          200,
          await automation.screenshot(principal, leaseId, fencingToken),
        );
        return;
      case "click":
        await automation.click(
          principal,
          leaseId,
          fencingToken,
          requiredString(body, "selector"),
        );
        json(response, 200, { ok: true });
        return;
      case "type":
        await automation.type(
          principal,
          leaseId,
          fencingToken,
          requiredString(body, "selector"),
          requiredString(body, "text"),
        );
        json(response, 200, { ok: true });
        return;
      case "evaluate":
        json(response, 200, {
          value: await automation.evaluate(
            principal,
            leaseId,
            fencingToken,
            requiredString(body, "expression"),
          ),
        });
        return;
      case "tabs":
        json(response, 200, {
          tabs: await automation.tabs(principal, leaseId, fencingToken),
        });
        return;
    }
  }

  const captureStartMatch = url.pathname.match(/^\/v1\/leases\/([^/]+)\/capture-domain\/start$/);
  if (request.method === "POST" && captureStartMatch?.[1]) {
    const body = await readObject(request);
    json(
      response,
      201,
      await requireAutomation(config).startDomainCapture(
        principal,
        captureStartMatch[1],
        requiredNumber(body, "fencingToken"),
        requiredString(body, "domain"),
        {
          redactSecrets: body["redactSecrets"] !== false,
          includeTrace: body["includeTrace"] !== false,
          includeVideo: body["includeVideo"] === true,
        },
      ),
    );
    return;
  }

  const captureStopMatch = url.pathname.match(/^\/v1\/leases\/([^/]+)\/capture-domain\/stop$/);
  if (request.method === "POST" && captureStopMatch?.[1]) {
    const body = await readObject(request);
    json(
      response,
      201,
      await requireAutomation(config).stopDomainCapture(
        principal,
        captureStopMatch[1],
        requiredNumber(body, "fencingToken"),
      ),
    );
    return;
  }

  const captureMatch = url.pathname.match(/^\/v1\/leases\/([^/]+)\/capture-domain$/);
  if (request.method === "POST" && captureMatch?.[1]) {
    const body = await readObject(request);
    json(
      response,
      201,
      await requireAutomation(config).captureDomain(
        principal,
        captureMatch[1],
        requiredNumber(body, "fencingToken"),
        requiredString(body, "url"),
        {
          redactSecrets: body["redactSecrets"] !== false,
          includeTrace: body["includeTrace"] !== false,
          includeVideo: body["includeVideo"] === true,
        },
      ),
    );
    return;
  }

  const streamMatch = url.pathname.match(/^\/v1\/leases\/([^/]+)\/stream$/);
  if (request.method === "GET" && streamMatch?.[1]) {
    const token = Number(url.searchParams.get("fencingToken"));
    if (!Number.isSafeInteger(token) || token < 1) {
      throw new BrowserSiloError("INVALID_REQUEST", "A valid fencingToken query parameter is required.", 400);
    }
    await streamScreenshots(
      requireAutomation(config),
      principal,
      streamMatch[1],
      token,
      request,
      response,
    );
    return;
  }

  throw new BrowserSiloError("NOT_FOUND", "Browser API route not found.", 404);
}

async function streamScreenshots(
  automation: BrowserAutomationService,
  principal: Principal,
  leaseId: string,
  fencingToken: number,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  response.writeHead(200, {
    "content-type": "multipart/x-mixed-replace; boundary=browsersilo-frame",
    "cache-control": "no-store, no-cache, must-revalidate",
    connection: "close",
  });
  let closed = false;
  request.once("close", () => {
    closed = true;
  });
  while (!closed && !response.destroyed) {
    const screenshot = await automation.screenshot(principal, leaseId, fencingToken);
    const frame = Buffer.from(screenshot.data, "base64");
    response.write(
      `--browsersilo-frame\r\nContent-Type: image/png\r\nContent-Length: ${frame.length}\r\n\r\n`,
    );
    response.write(frame);
    response.write("\r\n");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  if (!response.destroyed) response.end("--browsersilo-frame--\r\n");
}

function requireAutomation(config: ServerConfiguration): BrowserAutomationService {
  if (!config.automation) {
    throw new BrowserSiloError(
      "FEATURE_NOT_AVAILABLE",
      "Browser actions require the Docker Brave worker adapter.",
      501,
    );
  }
  return config.automation;
}

function requireGateway(config: ServerConfiguration): BrowserGatewayService {
  if (!config.gateway) {
    throw new BrowserSiloError(
      "FEATURE_NOT_AVAILABLE",
      "Realtime browser sessions require the Docker Brave worker adapter.",
      501,
    );
  }
  return config.gateway;
}

async function streamBrowserEvents(
  gateway: BrowserGatewayService,
  principal: Principal,
  browserId: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  await gateway.get(principal, browserId);
  const replay = gateway.events.replay(browserId, header(request, "last-event-id"));
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-cache, must-revalidate",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.write("retry: 1000\n\n");
  for (const event of replay) writeServerEvent(response, event);
  const unsubscribe = gateway.events.subscribe(browserId, (event) => {
    writeServerEvent(response, event);
  });
  const heartbeat = setInterval(() => {
    if (!response.destroyed) response.write(`: heartbeat ${Date.now()}\n\n`);
  }, 15_000);
  await new Promise<void>((resolvePromise) => {
    request.once("close", resolvePromise);
    response.once("close", resolvePromise);
  });
  clearInterval(heartbeat);
  unsubscribe();
  if (!response.destroyed) response.end();
}

function writeServerEvent(
  response: ServerResponse,
  event: { id: string; type: string; occurredAt: string; data: Record<string, unknown> },
): void {
  response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify({ occurredAt: event.occurredAt, ...event.data })}\n\n`);
}

function requireProfileStore(config: ServerConfiguration): LocalEncryptedProfileStore {
  if (!config.profileStore) {
    throw new BrowserSiloError(
      "FEATURE_NOT_AVAILABLE",
      "Encrypted profile lifecycle operations require the Docker Brave adapter.",
      501,
    );
  }
  return config.profileStore;
}

function requireArtifactStore(config: ServerConfiguration): EncryptedArtifactStore {
  if (!config.artifactStore) {
    throw new BrowserSiloError(
      "FEATURE_NOT_AVAILABLE",
      "Encrypted artifacts require the Docker Brave adapter.",
      501,
    );
  }
  return config.artifactStore;
}

function requireOperatorSettings(config: ServerConfiguration): OperatorSettingsStore {
  if (!config.operatorSettings) {
    throw new BrowserSiloError(
      "FEATURE_NOT_AVAILABLE",
      "Persistent operator settings are unavailable in this runtime.",
      501,
    );
  }
  return config.operatorSettings;
}

async function routeAdmin(
  core: BrowserSiloCore,
  config: ServerConfiguration,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://browsesilo-admin.local");
  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, { status: "ok", plane: "admin" });
    return;
  }
  if (
    request.method === "GET" &&
    !url.pathname.startsWith("/admin/v1/") &&
    url.pathname !== "/metrics"
  ) {
    await serveAdminUi(url.pathname, response);
    return;
  }

  authenticateAdmin(request, config);
  const adminLiveMatch = url.pathname.match(/^\/admin\/v1\/browsers\/([^/]+)\/live-token$/);
  if (request.method === "POST" && adminLiveMatch?.[1]) {
    const body = await readObject(request);
    const role = String(body["role"] ?? "observe");
    if (!new Set(["observe", "assist", "takeover"]).has(role)) {
      throw new BrowserSiloError("INVALID_REQUEST", "The live role is invalid.", 400);
    }
    const lease = (await core.adminSnapshot()).leases.find((candidate) => candidate.id === adminLiveMatch[1]);
    if (!lease) throw new BrowserSiloError("NOT_FOUND", "The browser was not found.", 404);
    json(response, 201, await requireGateway(config).issueLiveToken(
      { tenantId: lease.tenantId, principalId: lease.principalId, kind: "agent" },
      lease.id,
      role as "observe" | "assist" | "takeover",
    ));
    return;
  }
  if (request.method === "GET" && url.pathname === "/metrics") {
    const snapshot = await core.adminSnapshot();
    const artifacts = config.artifactStore ? await config.artifactStore.adminList() : [];
    response.writeHead(200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(`${config.observability!.prometheus()}${runtimePrometheus(snapshot, artifacts)}`);
    return;
  }
  if (request.method === "GET" && url.pathname === "/admin/v1/overview") {
    json(response, 200, await core.overview());
    return;
  }
  if (request.method === "GET" && url.pathname === "/admin/v1/snapshot") {
    json(response, 200, await core.adminSnapshot());
    return;
  }
  if (request.method === "GET" && url.pathname === "/admin/v1/adapters") {
    const store = requireOperatorSettings(config);
    const desired = store.current;
    const effective = config.effectiveOperatorSettings ?? desired;
    json(response, 200, {
      desired,
      effective,
      restartRequired: JSON.stringify(desired) !== JSON.stringify(effective),
      environmentOverrides: [
        "BROWSERSILO_WORKER_ADAPTER", "BROWSERSILO_WORKER_IMAGE", "BROWSERSILO_KMS_PROVIDER",
        "BROWSERSILO_AWS_KMS_KEY_ID", "BROWSERSILO_SECCOMP_PROFILE",
        "BROWSERSILO_WORKER_MEMORY_BYTES", "BROWSERSILO_WORKER_CPUS", "BROWSERSILO_WORKER_PIDS_LIMIT",
      ].filter((name) => process.env[name] !== undefined),
    });
    return;
  }
  if (request.method === "PUT" && url.pathname === "/admin/v1/adapters") {
    const store = requireOperatorSettings(config);
    const desired = await store.update(await readObject(request));
    const effective = config.effectiveOperatorSettings ?? desired;
    json(response, 200, {
      desired,
      effective,
      restartRequired: JSON.stringify(desired) !== JSON.stringify(effective),
    });
    return;
  }
  if (request.method === "PUT" && url.pathname === "/admin/v1/pool") {
    const body = await readObject(request);
    const updates: Partial<Pick<PoolConfiguration,
      "warmShellReserve" | "maxActiveWorkers" | "maxActiveWorkersPerTenant" | "maxQueueDepth" | "admissionTimeoutMs"
    >> = {};
    for (const key of [
      "warmShellReserve",
      "maxActiveWorkers",
      "maxActiveWorkersPerTenant",
      "maxQueueDepth",
      "admissionTimeoutMs",
    ] as const) {
      const value = optionalNumber(body, key);
      if (value !== undefined) updates[key] = value;
    }
    json(response, 200, await core.updatePool(updates));
    return;
  }
  if (request.method === "GET" && url.pathname === "/admin/v1/artifacts") {
    const store = config.artifactStore;
    json(response, 200, {
      artifacts: store ? await store.adminList() : [],
      retentionSeconds: store ? store.defaultRetentionSeconds : 30 * 24 * 60 * 60,
      available: !!store,
    });
    return;
  }
  const adminArtifactExport = url.pathname.match(
    /^\/admin\/v1\/artifacts\/([^/]+)\/export$/,
  );
  if (request.method === "GET" && adminArtifactExport?.[1]) {
    const store = requireArtifactStore(config);
    const directory = await mkdtemp(join(tmpdir(), "browsersilo-admin-export-"));
    const destination = join(directory, "artifact");
    try {
      const artifact = await store.adminExportTo(adminArtifactExport[1], destination);
      response.writeHead(200, {
        "content-type": artifact.mimeType,
        "content-disposition": `attachment; filename="${artifact.name.replaceAll('"', "_")}"`,
        "content-length": artifact.size,
        "cache-control": "no-store",
      });
      await pipeline(createReadStream(destination), response);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/admin/v1/telemetry") {
    const snapshot = await core.adminSnapshot();
    const artifacts = config.artifactStore
      ? await config.artifactStore.adminList()
      : [];
    const now = Date.now();
    const browserSeconds = snapshot.leases.reduce((sum, lease) => {
      const end = lease.closedAt ? new Date(lease.closedAt).getTime() : now;
      return sum + Math.max(0, end - new Date(lease.acquiredAt).getTime()) / 1000;
    }, 0);
    const telemetry = config.observability!.snapshot();
    const tenantAccounting: Record<string, {
      browserSeconds: number;
      artifactBytes: number;
      profiles: number;
      leases: number;
    }> = {};
    for (const profile of snapshot.profiles) {
      const item = tenantAccounting[profile.tenantId] ??= {
        browserSeconds: 0, artifactBytes: 0, profiles: 0, leases: 0,
      };
      item.profiles += 1;
    }
    for (const lease of snapshot.leases) {
      const item = tenantAccounting[lease.tenantId] ??= {
        browserSeconds: 0, artifactBytes: 0, profiles: 0, leases: 0,
      };
      const end = lease.closedAt ? new Date(lease.closedAt).getTime() : now;
      item.browserSeconds += Math.max(0, end - new Date(lease.acquiredAt).getTime()) / 1000;
      item.leases += 1;
    }
    for (const artifact of artifacts) {
      const item = tenantAccounting[artifact.tenantId] ??= {
        browserSeconds: 0, artifactBytes: 0, profiles: 0, leases: 0,
      };
      item.artifactBytes += artifact.size;
    }
    for (const item of Object.values(tenantAccounting)) {
      item.browserSeconds = Math.round(item.browserSeconds);
    }
    json(response, 200, {
      ...telemetry,
      accounting: {
        browserSeconds: Math.round(browserSeconds),
        artifactBytes: artifacts.reduce((sum, artifact) => sum + artifact.size, 0),
        profiles: snapshot.profiles.length,
        workersCreated: snapshot.workers.length,
        tenants: tenantAccounting,
        activeWorkerCpus:
          snapshot.overview.activeLeases * (config.effectiveOperatorSettings?.workerCpus ?? 0),
        activeWorkerMemoryBytes:
          snapshot.overview.activeLeases * (config.effectiveOperatorSettings?.workerMemoryBytes ?? 0),
      },
      alerts: [
        ...(telemetry.errors > 0
          ? [{ severity: "warning", code: "HTTP_5XX", message: `${telemetry.errors} server errors recorded.` }]
          : []),
        ...(snapshot.overview.activeLeases >= snapshot.overview.pool.maxActiveWorkers
          ? [{ severity: "warning", code: "CAPACITY_FULL", message: "Active browser capacity is full." }]
          : []),
        ...(snapshot.overview.admission.queued > 0
          ? [{ severity: "warning", code: "ADMISSION_QUEUED", message: `${snapshot.overview.admission.queued} browser admissions are queued.` }]
          : []),
        ...(snapshot.workers.some((worker) => worker.state === "unhealthy")
          ? [{ severity: "critical", code: "UNHEALTHY_WORKER", message: "One or more workers are unhealthy." }]
          : []),
      ],
    });
    return;
  }
  if (request.method === "PUT" && url.pathname === "/admin/v1/artifacts/retention") {
    const store = requireArtifactStore(config);
    const body = await readObject(request);
    await store.setDefaultRetentionSeconds(requiredNumber(body, "retentionSeconds"));
    json(response, 200, { retentionSeconds: store.defaultRetentionSeconds });
    return;
  }
  if (request.method === "POST" && url.pathname === "/admin/v1/reconcile") {
    await core.reconcile();
    json(response, 200, await core.overview());
    return;
  }
  throw new BrowserSiloError("NOT_FOUND", "Admin API route not found.", 404);
}

function runtimePrometheus(
  snapshot: AdminSnapshot,
  artifacts: Array<{ size: number }>,
): string {
  const lines = [
    "# HELP browsersilo_active_leases Browser leases currently active.",
    "# TYPE browsersilo_active_leases gauge",
    `browsersilo_active_leases ${snapshot.overview.activeLeases}`,
    "# HELP browsersilo_profiles Durable browser profiles known to the control plane.",
    "# TYPE browsersilo_profiles gauge",
    `browsersilo_profiles ${snapshot.profiles.length}`,
    "# HELP browsersilo_admission_queued Browser acquisitions waiting for capacity.",
    "# TYPE browsersilo_admission_queued gauge",
    `browsersilo_admission_queued ${snapshot.overview.admission.queued}`,
    "# HELP browsersilo_artifact_bytes Plaintext bytes represented by encrypted artifacts.",
    "# TYPE browsersilo_artifact_bytes gauge",
    `browsersilo_artifact_bytes ${artifacts.reduce((sum, artifact) => sum + artifact.size, 0)}`,
    "# HELP browsersilo_workers Browser workers by durable lifecycle state.",
    "# TYPE browsersilo_workers gauge",
  ];
  for (const [state, count] of Object.entries(snapshot.overview.workers)) {
    lines.push(`browsersilo_workers{state="${state}"} ${count}`);
  }
  return `${lines.join("\n")}\n`;
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  observability: RuntimeObservability,
  operation: () => Promise<void>,
): Promise<void> {
  const pathname = new URL(request.url ?? "/", "http://browsesilo.local").pathname;
  const trace = observability.start(request.method ?? "UNKNOWN", pathname);
  response.setHeader("x-browsersilo-trace-id", trace.traceId);
  response.once("finish", () => trace.finish(response.statusCode));
  try {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    await operation();
  } catch (error) {
    if (response.headersSent) {
      response.end();
      return;
    }
    if (error instanceof BrowserSiloError) {
      json(response, error.status, {
        error: { code: error.code, message: error.message, details: error.details },
      });
      return;
    }
    console.error("Unhandled BrowserSilo request error", error);
    json(response, 500, {
      error: { code: "INTERNAL_ERROR", message: "The request failed." },
    });
  }
}

function authenticateAgent(
  request: IncomingMessage,
  config: ServerConfiguration,
): Principal {
  const presented = bearerToken(request);
  const credentials = config.agentCredentials ?? (
    config.agentToken && config.localPrincipal
      ? [{ tokenHash: tokenHash(config.agentToken), principal: config.localPrincipal }]
      : []
  );
  const presentedHash = presented ? tokenHash(presented) : "";
  const matched = credentials.find((credential) => safeEqual(
    credential.tokenHash,
    presentedHash,
  ));
  if (!matched) {
    throw new BrowserSiloError(
      "UNAUTHENTICATED",
      "A valid Browser API bearer token is required.",
      401,
    );
  }
  return { ...matched.principal };
}

function authenticateAdmin(
  request: IncomingMessage,
  config: ServerConfiguration,
): void {
  if (!safeEqual(tokenHash(bearerToken(request) ?? ""), tokenHash(config.adminToken))) {
    throw new BrowserSiloError(
      "UNAUTHENTICATED",
      "A valid Admin API bearer token is required.",
      401,
    );
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = header(request, "authorization");
  const match = authorization?.match(/^Bearer (.+)$/);
  return match?.[1] ?? null;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readObject(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 512 * 1024) {
      throw new BrowserSiloError(
        "INVALID_REQUEST",
        "Request body exceeds 512 KiB.",
        413,
      );
    }
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new BrowserSiloError(
      "INVALID_REQUEST",
      "Request body must be a JSON object.",
      400,
    );
  }
}

async function streamRequestToFile(
  request: IncomingMessage,
  destination: string,
  limit: number,
): Promise<void> {
  let total = 0;
  request.on("data", (chunk: Buffer) => {
    total += chunk.length;
    if (total > limit) request.destroy(
      new BrowserSiloError("INVALID_REQUEST", "Streamed request exceeds its configured size limit.", 413),
    );
  });
  await pipeline(request, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") {
    throw new BrowserSiloError(
      "INVALID_REQUEST",
      `${key} must be a string.`,
      400,
    );
  }
  return value;
}

function requiredNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number") {
    throw new BrowserSiloError(
      "INVALID_REQUEST",
      `${key} must be a number.`,
      400,
    );
  }
  return value;
}

function optionalStringArray(
  body: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new BrowserSiloError(
      "INVALID_REQUEST",
      `${key} must be an array of strings.`,
      400,
    );
  }
  return value as string[];
}

function requiredObject(
  body: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = body[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrowserSiloError(
      "INVALID_REQUEST",
      `${key} must be an object.`,
      400,
    );
  }
  return value as Record<string, unknown>;
}

function requiredActionArray(
  body: Record<string, unknown>,
  key: string,
): PublicBrowserAction[] {
  const value = body[key];
  if (!Array.isArray(value)) {
    throw new BrowserSiloError("INVALID_REQUEST", `${key} must be an array.`, 400);
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new BrowserSiloError("INVALID_REQUEST", "Every batch action must be an object.", 400);
    }
    return publicAction(item as Record<string, unknown>);
  });
}

function publicAction(body: Record<string, unknown>): PublicBrowserAction {
  const type = requiredString(body, "type");
  switch (type) {
    case "navigate":
      return { type, url: requiredString(body, "url") };
    case "snapshot":
    case "screenshot":
    case "tabs":
      return { type };
    case "click":
      return { type, target: requiredString(body, "target") };
    case "type":
      return {
        type,
        target: requiredString(body, "target"),
        text: requiredString(body, "text"),
      };
    case "press":
      return { type, key: requiredString(body, "key") };
    case "scroll": {
      const direction = requiredString(body, "direction");
      if (!new Set(["up", "down", "left", "right"]).has(direction)) {
        throw new BrowserSiloError("INVALID_REQUEST", "Scroll direction is invalid.", 400);
      }
      const amount = optionalNumber(body, "amount");
      return {
        type,
        direction: direction as "up" | "down" | "left" | "right",
        ...(amount !== undefined ? { amount } : {}),
      };
    }
    case "tool":
      return {
        type,
        name: requiredString(body, "name"),
        ...(body["arguments"] !== undefined
          ? { arguments: requiredObject(body, "arguments") }
          : {}),
      };
    default:
      throw new BrowserSiloError("INVALID_REQUEST", "The browser action type is unsupported.", 400);
  }
}

function optionalNumber(
  body: Record<string, unknown>,
  key: string,
): number | undefined {
  if (!(key in body)) return undefined;
  return requiredNumber(body, key);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function listen(
  server: ReturnType<typeof createServer>,
  port: number,
  host: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
