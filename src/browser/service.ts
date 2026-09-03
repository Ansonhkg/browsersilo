import { BrowserSiloError } from "../core/errors.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { EncryptedArtifactStore, ArtifactKind, ArtifactMetadata } from "../artifacts/encrypted-artifact-store.js";
import type { BrowserLease, Principal } from "../core/model.js";
import type {
  BrowserAutomationPort,
  BrowserScreenshot,
  BrowserSnapshot,
  BrowserTab,
  BrowserToolResult,
} from "../core/ports.js";
import type { BrowserSiloCore } from "../core/service.js";

export class BrowserAutomationService {
  readonly #core: BrowserSiloCore;
  readonly #automation: BrowserAutomationPort;
  readonly #artifacts: EncryptedArtifactStore | null;
  readonly #recordings = new Map<string, { workerId: string; path: string; stopped: boolean }>();
  readonly #domainCaptures = new Map<string, {
    workerId: string;
    domain: string;
    startedAt: string;
    redactSecrets: boolean;
    includeTrace: boolean;
    includeVideo: boolean;
  }>();

  constructor(
    core: BrowserSiloCore,
    automation: BrowserAutomationPort,
    artifacts?: EncryptedArtifactStore,
  ) {
    this.#core = core;
    this.#automation = automation;
    this.#artifacts = artifacts ?? null;
  }

  async navigate(
    principal: Principal,
    leaseId: string,
    fencingToken: number,
    url: string,
  ): Promise<{ url: string; title: string }> {
    validateNavigationUrl(url);
    const workerId = await this.#authorizedWorker(
      principal,
      leaseId,
      fencingToken,
    );
    return this.#automation.navigate(workerId, url);
  }

  async snapshot(
    principal: Principal,
    leaseId: string,
    fencingToken: number,
  ): Promise<BrowserSnapshot> {
    return this.#automation.snapshot(
      await this.#authorizedWorker(principal, leaseId, fencingToken),
    );
  }

  async screenshot(
    principal: Principal,
    leaseId: string,
    fencingToken: number,
    options?: { fullPage?: boolean },
  ): Promise<BrowserScreenshot> {
    return this.#automation.screenshot(
      await this.#authorizedWorker(principal, leaseId, fencingToken),
      options,
    );
  }

  async click(
    principal: Principal,
    leaseId: string,
    fencingToken: number,
    selector: string,
  ): Promise<void> {
    validateSelector(selector);
    await this.#automation.click(
      await this.#authorizedWorker(principal, leaseId, fencingToken),
      selector,
    );
  }

  async type(
    principal: Principal,
    leaseId: string,
    fencingToken: number,
    selector: string,
    text: string,
  ): Promise<void> {
    validateSelector(selector);
    if (text.length > 20_000) {
      throw new BrowserSiloError(
        "INVALID_REQUEST",
        "Browser input text cannot exceed 20,000 characters.",
        400,
      );
    }
    await this.#automation.type(
      await this.#authorizedWorker(principal, leaseId, fencingToken),
      selector,
      text,
    );
  }

  async evaluate(
    principal: Principal,
    leaseId: string,
    fencingToken: number,
    expression: string,
  ): Promise<unknown> {
    if (expression.length < 1 || expression.length > 20_000) {
      throw new BrowserSiloError(
        "INVALID_REQUEST",
        "The CDP expression must be between 1 and 20,000 characters.",
        400,
      );
    }
    return this.#automation.evaluate(
      await this.#authorizedWorker(principal, leaseId, fencingToken),
      expression,
    );
  }

  async tabs(
    principal: Principal,
    leaseId: string,
    fencingToken: number,
  ): Promise<BrowserTab[]> {
    return this.#automation.tabs(
      await this.#authorizedWorker(principal, leaseId, fencingToken),
    );
  }

  async finalizeLease(
    principal: Principal,
    leaseId: string,
    fencingToken: number,
  ): Promise<void> {
    const lease = await this.#authorizedLease(
      principal,
      leaseId,
      fencingToken,
      new Set(["active", "releasing"]),
    );
    if (this.#domainCaptures.has(leaseId)) {
      await this.#stopDomainCaptureForLease(principal, lease);
      return;
    }
    if (this.#recordings.has(leaseId)) {
      await this.#agentToolForLease(principal, lease, "agent_browser_record_stop", {});
    }
  }

  async captureDomain(
    principal: Principal,
    leaseId: string,
    fencingToken: number,
    url: string,
    options: { redactSecrets?: boolean; includeTrace?: boolean; includeVideo?: boolean } = {},
  ): Promise<{
    artifact: ArtifactMetadata;
    harArtifact: ArtifactMetadata | null;
    traceArtifact: ArtifactMetadata | null;
    recordingArtifact: ArtifactMetadata | null;
    screenshotArtifact: ArtifactMetadata;
    url: string;
    title: string;
  }> {
    validateNavigationUrl(url);
    const captureUrl = new URL(url);
    await this.startDomainCapture(principal, leaseId, fencingToken, captureUrl.hostname, options);
    try {
      await this.#automation.navigate(
        (await this.#authorizedLease(principal, leaseId, fencingToken)).workerId,
        url,
      );
      await this.#automation.agentTool(
        (await this.#authorizedLease(principal, leaseId, fencingToken)).workerId,
        "agent_browser_wait_for_load",
        { state: "networkidle", waitTimeoutMs: 30_000 },
      ).catch(() => undefined);
      return await this.stopDomainCapture(principal, leaseId, fencingToken);
    } catch (error) {
      await this.stopDomainCapture(principal, leaseId, fencingToken).catch(() => undefined);
      throw error;
    }
  }

  async startDomainCapture(
    principal: Principal,
    leaseId: string,
    fencingToken: number,
    domain: string,
    options: { redactSecrets?: boolean; includeTrace?: boolean; includeVideo?: boolean } = {},
  ): Promise<{ active: true; domain: string; startedAt: string; includeTrace: boolean; includeVideo: boolean }> {
    const lease = await this.#authorizedLease(principal, leaseId, fencingToken);
    if (this.#domainCaptures.has(leaseId)) {
      throw new BrowserSiloError("INVALID_REQUEST", "A Domain Capture is already active for this lease.", 409);
    }
    const normalizedDomain = normalizeCaptureDomain(domain);
    const capture = {
      workerId: lease.workerId,
      domain: normalizedDomain,
      startedAt: new Date().toISOString(),
      redactSecrets: options.redactSecrets !== false,
      includeTrace: options.includeTrace !== false,
      includeVideo: options.includeVideo === true,
    };
    await this.#automation.agentTool(lease.workerId, "agent_browser_network_har_start", {});
    try {
      if (capture.includeTrace) {
        await this.#automation.agentTool(lease.workerId, "agent_browser_trace_start", {});
      }
      if (capture.includeVideo && !capture.includeTrace) {
        await this.agentTool(
          principal,
          leaseId,
          fencingToken,
          "agent_browser_record_start",
          {},
        );
      }
      this.#domainCaptures.set(leaseId, capture);
      return {
        active: true,
        domain: capture.domain,
        startedAt: capture.startedAt,
        includeTrace: capture.includeTrace,
        includeVideo: capture.includeVideo,
      };
    } catch (error) {
      await this.agentTool(
        principal, leaseId, fencingToken, "agent_browser_network_har_stop", {},
      ).catch(() => undefined);
      if (capture.includeTrace) {
        await this.agentTool(
          principal, leaseId, fencingToken, "agent_browser_trace_stop", {},
        ).catch(() => undefined);
      }
      if (capture.includeVideo) {
        await this.agentTool(
          principal, leaseId, fencingToken, "agent_browser_record_stop", {},
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  async stopDomainCapture(
    principal: Principal,
    leaseId: string,
    fencingToken: number,
  ): Promise<{
    artifact: ArtifactMetadata;
    harArtifact: ArtifactMetadata | null;
    traceArtifact: ArtifactMetadata | null;
    recordingArtifact: ArtifactMetadata | null;
    screenshotArtifact: ArtifactMetadata;
    url: string;
    title: string;
  }> {
    const lease = await this.#authorizedLease(principal, leaseId, fencingToken);
    return this.#stopDomainCaptureForLease(principal, lease);
  }

  async #stopDomainCaptureForLease(
    principal: Principal,
    lease: BrowserLease,
  ): Promise<{
    artifact: ArtifactMetadata;
    harArtifact: ArtifactMetadata | null;
    traceArtifact: ArtifactMetadata | null;
    recordingArtifact: ArtifactMetadata | null;
    screenshotArtifact: ArtifactMetadata;
    url: string;
    title: string;
  }> {
    const leaseId = lease.id;
    const capture = this.#domainCaptures.get(leaseId);
    if (!capture || capture.workerId !== lease.workerId) {
      throw new BrowserSiloError("INVALID_REQUEST", "No Domain Capture is active for this lease.", 409);
    }
    let harStopped = false;
    let traceStopped = !capture.includeTrace;
    let recordingStopped = !capture.includeVideo;
    try {
      const [snapshot, screenshot, html, cookies, localStorage, sessionStorage, requests, consoleLog, errors] =
        await Promise.all([
          this.#automation.snapshot(lease.workerId),
          this.#automation.screenshot(lease.workerId),
          this.#automation.agentTool(lease.workerId, "agent_browser_get_html", { selector: "html" }),
          this.#automation.agentTool(lease.workerId, "agent_browser_cookies_get", {}),
          this.#automation.agentTool(lease.workerId, "agent_browser_storage_get", { storageType: "local" }),
          this.#automation.agentTool(lease.workerId, "agent_browser_storage_get", { storageType: "session" }),
          this.#automation.agentTool(lease.workerId, "agent_browser_network_requests", {}),
          this.#automation.agentTool(lease.workerId, "agent_browser_console", {}),
          this.#automation.agentTool(lease.workerId, "agent_browser_errors", {}),
        ]);
      assertCapturedDomain(snapshot.url, capture.domain);
      const harResult = await this.#agentToolForLease(
        principal, lease, "agent_browser_network_har_stop", {},
      );
      harStopped = true;
      const traceResult = capture.includeTrace
        ? await this.#agentToolForLease(principal, lease, "agent_browser_trace_stop", {})
        : null;
      traceStopped = true;
      let recordingResult: BrowserToolResult | null = null;
      if (capture.includeVideo) {
        if (!this.#recordings.has(leaseId)) {
          await this.#agentToolForLease(principal, lease, "agent_browser_record_start", {});
          await delay(1_200);
        }
        recordingResult = await this.#agentToolForLease(
          principal,
          lease,
          "agent_browser_record_stop",
          {},
        );
      }
      recordingStopped = true;
      let harArtifact = resultArtifact(harResult);
      if (capture.redactSecrets && harArtifact) {
        harArtifact = await this.#redactHarArtifact(principal, lease, capture.domain, harArtifact);
      }
      const traceArtifact = traceResult ? resultArtifact(traceResult) : null;
      const recordingArtifact = recordingResult ? resultArtifact(recordingResult) : null;
      const screenshotArtifact = await this.#artifactStore().putBuffer(
        {
          principal,
          leaseId,
          profileId: lease.profileId,
          kind: "screenshot",
          name: "domain-capture.png",
          mimeType: screenshot.mimeType,
          labels: { domain: capture.domain },
        },
        Buffer.from(screenshot.data, "base64"),
      );
      const rawCapture = {
        schemaVersion: 2,
        domain: capture.domain,
        startedAt: capture.startedAt,
        capturedAt: new Date().toISOString(),
        finalUrl: snapshot.url,
        title: snapshot.title,
        snapshot,
        html,
        cookies,
        localStorage,
        sessionStorage,
        requests,
        console: consoleLog,
        errors,
        artifacts: {
          har: harArtifact?.id ?? null,
          trace: traceArtifact?.id ?? null,
          recording: recordingArtifact?.id ?? null,
          screenshot: screenshotArtifact.id,
        },
      };
      const manifest = capture.redactSecrets ? redactCapture(rawCapture) : rawCapture;
      const artifact = await this.#artifactStore().putBuffer(
        {
          principal,
          leaseId,
          profileId: lease.profileId,
          kind: "domain-capture",
          name: `${safeDomainFileName(capture.domain)}-capture.json`,
          mimeType: "application/json",
          labels: {
            domain: capture.domain,
            redaction: capture.redactSecrets ? "secrets" : "none",
            scope: "session",
          },
        },
        Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
      );
      return {
        artifact,
        harArtifact,
        traceArtifact,
        recordingArtifact,
        screenshotArtifact,
        url: snapshot.url,
        title: snapshot.title,
      };
    } catch (error) {
      await Promise.allSettled([
        ...(!harStopped
          ? [this.#agentToolForLease(principal, lease, "agent_browser_network_har_stop", {})]
          : []),
        ...(!traceStopped
          ? [this.#agentToolForLease(principal, lease, "agent_browser_trace_stop", {})]
          : []),
        ...(!recordingStopped
          ? [this.#agentToolForLease(principal, lease, "agent_browser_record_stop", {})]
          : []),
      ]);
      throw error;
    } finally {
      this.#domainCaptures.delete(leaseId);
    }
  }

  async agentTool(
    principal: Principal,
    leaseId: string,
    fencingToken: number,
    toolName: string,
    arguments_: Record<string, unknown>,
  ): Promise<BrowserToolResult> {
    if (!/^agent_browser_[a-z0-9_]+$/.test(toolName)) {
      throw new BrowserSiloError(
        "INVALID_REQUEST",
        "The parity tool name is invalid.",
        400,
      );
    }
    const lease = await this.#authorizedLease(principal, leaseId, fencingToken);
    return this.#agentToolForLease(principal, lease, toolName, arguments_);
  }

  async #agentToolForLease(
    principal: Principal,
    lease: BrowserLease,
    toolName: string,
    arguments_: Record<string, unknown>,
  ): Promise<BrowserToolResult> {
    const leaseId = lease.id;
    const workerId = lease.workerId;
    if (toolName === "agent_browser_upload") {
      return this.#uploadArtifacts(principal, lease, arguments_);
    }
    if (
      toolName === "agent_browser_state_load" ||
      toolName === "agent_browser_state_show" ||
      toolName === "agent_browser_cookies_set_curl"
    ) {
      return this.#toolWithInputArtifact(principal, lease, toolName, arguments_);
    }
    if (toolName === "agent_browser_diff_screenshot") {
      return this.#diffScreenshot(principal, lease, arguments_);
    }
    if (toolName === "agent_browser_record_start") {
      if (this.#recordings.has(leaseId)) {
        throw new BrowserSiloError("INVALID_REQUEST", "A recording is already active for this lease.", 409);
      }
      const path = await this.#automation.prepareFile(workerId, "recording.webm");
      try {
        const result = await this.#automation.agentTool(workerId, toolName, {
          ...arguments_,
          path,
        });
        this.#recordings.set(leaseId, { workerId, path, stopped: false });
        return result;
      } catch (error) {
        await this.#automation.removeFile(workerId, path).catch(() => undefined);
        throw error;
      }
    }
    if (toolName === "agent_browser_record_restart") {
      const previous = this.#recordings.get(leaseId);
      if (!previous) {
        throw new BrowserSiloError("INVALID_REQUEST", "No recording is active for this lease.", 409);
      }
      const path = await this.#automation.prepareFile(workerId, "recording.webm");
      let result: BrowserToolResult;
      try {
        result = await this.#automation.agentTool(workerId, toolName, {
          ...arguments_,
          path,
        });
      } catch (error) {
        await this.#automation.removeFile(workerId, path).catch(() => undefined);
        throw error;
      }
      this.#recordings.set(leaseId, { workerId, path, stopped: false });
      const artifact = await this.#collectArtifact(
        principal,
        lease,
        previous.path,
        "recording",
        "recording-segment.webm",
        "video/webm",
      );
      return withArtifact(result, artifact);
    }
    if (toolName === "agent_browser_record_stop") {
      const recording = this.#recordings.get(leaseId);
      if (!recording) {
        throw new BrowserSiloError("INVALID_REQUEST", "No recording is active for this lease.", 409);
      }
      const result = recording.stopped
        ? { content: [{ type: "text", text: "Recording already stopped; retrying artifact collection." }] }
        : await this.#automation.agentTool(workerId, toolName, arguments_);
      recording.stopped = true;
      const artifact = await this.#collectArtifact(
        principal,
        lease,
        recording.path,
        "recording",
        "recording.webm",
        "video/webm",
      );
      this.#recordings.delete(leaseId);
      return withArtifact(result, artifact);
    }
    const output = outputTool(toolName);
    if (output) {
      const path = await this.#automation.prepareFile(workerId, output.name);
      let result: BrowserToolResult;
      try {
        result = await this.#automation.agentTool(workerId, toolName, {
          ...arguments_,
          [output.argument]: path,
        });
      } catch (error) {
        await this.#automation.removeFile(workerId, path).catch(() => undefined);
        throw error;
      }
      const artifact = await this.#collectArtifact(
        principal,
        lease,
        path,
        output.kind,
        output.name,
        output.mimeType,
      );
      return withArtifact(result, artifact);
    }
    return this.#automation.agentTool(workerId, toolName, arguments_);
  }

  async #uploadArtifacts(
    principal: Principal,
    lease: BrowserLease,
    arguments_: Record<string, unknown>,
  ): Promise<BrowserToolResult> {
    const artifactIds = arguments_["artifactIds"];
    if (!Array.isArray(artifactIds) || artifactIds.length < 1 || artifactIds.length > 20) {
      throw new BrowserSiloError(
        "INVALID_REQUEST",
        "artifactIds must contain between 1 and 20 encrypted artifact ids.",
        400,
      );
    }
    const store = this.#artifactStore();
    const directory = await mkdtemp(join(tmpdir(), "browsersilo-upload-"));
    const paths: string[] = [];
    try {
      for (const [index, rawId] of artifactIds.entries()) {
        if (typeof rawId !== "string") {
          throw new BrowserSiloError("INVALID_REQUEST", "Every artifact id must be a string.", 400);
        }
        const metadata = await store.get(principal, rawId);
        const source = join(directory, `${index}-${metadata.name}`);
        await store.exportTo(principal, rawId, source);
        paths.push(await this.#automation.stageFile(lease.workerId, source, metadata.name));
      }
      const upstream: Record<string, unknown> = { ...arguments_, files: paths };
      delete upstream["artifactIds"];
      return await this.#automation.agentTool(
        lease.workerId,
        "agent_browser_upload",
        upstream,
      );
    } finally {
      await Promise.allSettled(paths.map((path) => this.#automation.removeFile(lease.workerId, path)));
      await rm(directory, { recursive: true, force: true });
    }
  }

  async #toolWithInputArtifact(
    principal: Principal,
    lease: BrowserLease,
    toolName: string,
    arguments_: Record<string, unknown>,
  ): Promise<BrowserToolResult> {
    const artifactId = arguments_["artifactId"];
    if (typeof artifactId !== "string") {
      throw new BrowserSiloError("INVALID_REQUEST", "artifactId is required.", 400);
    }
    const store = this.#artifactStore();
    const metadata = await store.get(principal, artifactId);
    const directory = await mkdtemp(join(tmpdir(), "browsersilo-input-"));
    const source = join(directory, metadata.name);
    let path: string | null = null;
    try {
      await store.exportTo(principal, artifactId, source);
      path = await this.#automation.stageFile(lease.workerId, source, metadata.name);
      const upstream = { ...arguments_, [toolName === "agent_browser_cookies_set_curl" ? "file" : "path"]: path };
      delete upstream["artifactId"];
      return await this.#automation.agentTool(lease.workerId, toolName, upstream);
    } finally {
      if (path) await this.#automation.removeFile(lease.workerId, path).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }

  async #diffScreenshot(
    principal: Principal,
    lease: BrowserLease,
    arguments_: Record<string, unknown>,
  ): Promise<BrowserToolResult> {
    const output = await this.#automation.prepareFile(lease.workerId, "diff.png");
    let baseline: string | null = null;
    const directory = await mkdtemp(join(tmpdir(), "browsesilo-diff-"));
    try {
      const upstream: Record<string, unknown> = { ...arguments_, output };
      delete upstream["baselineArtifactId"];
      const baselineArtifactId = arguments_["baselineArtifactId"];
      if (typeof baselineArtifactId === "string") {
        const metadata = await this.#artifactStore().get(principal, baselineArtifactId);
        const source = join(directory, metadata.name);
        await this.#artifactStore().exportTo(principal, baselineArtifactId, source);
        baseline = await this.#automation.stageFile(lease.workerId, source, metadata.name);
        upstream["baseline"] = baseline;
      }
      const result = await this.#automation.agentTool(
        lease.workerId,
        "agent_browser_diff_screenshot",
        upstream,
      );
      const artifact = await this.#collectArtifact(
        principal,
        lease,
        output,
        "diff",
        "diff.png",
        "image/png",
      );
      return withArtifact(result, artifact);
    } finally {
      if (baseline) await this.#automation.removeFile(lease.workerId, baseline).catch(() => undefined);
      await this.#automation.removeFile(lease.workerId, output).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }

  async #collectArtifact(
    principal: Principal,
    lease: BrowserLease,
    containerPath: string,
    kind: ArtifactKind,
    name: string,
    mimeType: string,
  ): Promise<ArtifactMetadata> {
    const directory = await mkdtemp(join(tmpdir(), "browsersilo-output-"));
    const destination = join(directory, name);
    try {
      await this.#automation.collectFile(lease.workerId, containerPath, destination);
      return await this.#artifactStore().put({
        principal,
        leaseId: lease.id,
        profileId: lease.profileId,
        kind,
        name,
        mimeType,
        sourcePath: destination,
      });
    } finally {
      await this.#automation.removeFile(lease.workerId, containerPath).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }

  async #redactHarArtifact(
    principal: Principal,
    lease: BrowserLease,
    domain: string,
    source: ArtifactMetadata,
  ): Promise<ArtifactMetadata> {
    const store = this.#artifactStore();
    let parsed: unknown;
    try {
      parsed = JSON.parse((await store.readBuffer(principal, source.id)).toString("utf8"));
    } catch {
      await store.delete(principal, source.id).catch(() => undefined);
      throw new BrowserSiloError(
        "BROWSER_COMMAND_FAILED",
        "The captured HAR could not be safely redacted.",
        502,
      );
    }
    const redacted = await store.putBuffer(
      {
        principal,
        leaseId: lease.id,
        profileId: lease.profileId,
        kind: "har",
        name: source.name,
        mimeType: source.mimeType,
        labels: { ...source.labels, domain, redaction: "secrets" },
      },
      Buffer.from(`${JSON.stringify(redactCapture(parsed), null, 2)}\n`),
    );
    await store.delete(principal, source.id);
    return redacted;
  }

  #artifactStore(): EncryptedArtifactStore {
    if (!this.#artifacts) {
      throw new BrowserSiloError(
        "FEATURE_NOT_AVAILABLE",
        "This operation requires the encrypted artifact broker.",
        501,
      );
    }
    return this.#artifacts;
  }

  async #authorizedWorker(
    principal: Principal,
    leaseId: string,
    fencingToken: number,
  ): Promise<string> {
    return (await this.#authorizedLease(principal, leaseId, fencingToken)).workerId;
  }

  async #authorizedLease(
    principal: Principal,
    leaseId: string,
    fencingToken: number,
    allowedStates: ReadonlySet<BrowserLease["state"]> = new Set(["active"]),
  ): Promise<BrowserLease> {
    const lease = await this.#core.getLease(principal, leaseId);
    if (!allowedStates.has(lease.state)) {
      throw new BrowserSiloError(
        "LEASE_NOT_ACTIVE",
        "Browser actions require an active lease.",
        409,
        { leaseId, state: lease.state },
      );
    }
    if (
      !Number.isSafeInteger(fencingToken) ||
      fencingToken !== lease.fencingToken
    ) {
      throw new BrowserSiloError(
        "STALE_FENCE",
        "The fencing token is stale or invalid.",
        409,
        { leaseId },
      );
    }
    return lease;
  }
}

function outputTool(toolName: string): {
  argument: "path";
  kind: ArtifactKind;
  name: string;
  mimeType: string;
} | null {
  const tools: Record<string, { kind: ArtifactKind; name: string; mimeType: string }> = {
    agent_browser_download: { kind: "download", name: "download.bin", mimeType: "application/octet-stream" },
    agent_browser_pdf: { kind: "pdf", name: "page.pdf", mimeType: "application/pdf" },
    agent_browser_network_har_stop: { kind: "har", name: "capture.har", mimeType: "application/json" },
    agent_browser_trace_stop: { kind: "trace", name: "trace.zip", mimeType: "application/zip" },
    agent_browser_profiler_stop: { kind: "trace", name: "profile.json", mimeType: "application/json" },
    agent_browser_state_save: { kind: "state", name: "state.json", mimeType: "application/json" },
  };
  const value = tools[toolName];
  return value ? { argument: "path", ...value } : null;
}

function withArtifact(
  result: BrowserToolResult,
  artifact: ArtifactMetadata,
): BrowserToolResult {
  return {
    ...result,
    content: [
      ...result.content,
      { type: "text", text: `Encrypted BrowserSilo artifact: ${artifact.id}` },
    ],
    structuredContent: {
      ...(result.structuredContent ?? {}),
      artifact,
    },
  };
}

function resultArtifact(result: BrowserToolResult): ArtifactMetadata | null {
  const value = result.structuredContent?.["artifact"];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ArtifactMetadata)
    : null;
}

function redactCapture<T>(value: T): T {
  return redactValue(value, "") as T;
}

function redactValue(value: unknown, key: string): unknown {
  const sensitive = /authorization|cookie|password|passwd|secret|token|api[-_]?key|session/i;
  if (sensitive.test(key) && value !== null && value !== undefined) return "[REDACTED]";
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
      .replace(/([?&](?:token|key|secret|password)=)[^&#\s]+/gi, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, key));
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const namedSecret = entries.find(([childKey, child]) =>
      childKey.toLowerCase() === "name" && typeof child === "string" && sensitive.test(child)
    );
    return Object.fromEntries(
      entries.map(([childKey, child]) => [
        childKey,
        namedSecret && childKey.toLowerCase() === "value"
          ? "[REDACTED]"
          : redactValue(child, childKey),
      ]),
    );
  }
  return value;
}

function safeDomainFileName(domain: string): string {
  return domain.replace(/[^a-zA-Z0-9.-]/g, "_").slice(0, 160) || "domain";
}

function normalizeCaptureDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^\*\./, "");
  if (
    normalized.length < 1 || normalized.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalized)
  ) {
    throw new BrowserSiloError("INVALID_REQUEST", "Domain Capture requires a valid DNS domain.", 400);
  }
  return normalized;
}

function assertCapturedDomain(url: string, domain: string): void {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    throw new BrowserSiloError("INVALID_REQUEST", "The captured page has no valid HTTP URL.", 409);
  }
  if (hostname !== domain && !hostname.endsWith(`.${domain}`)) {
    throw new BrowserSiloError(
      "FORBIDDEN",
      "The current page is outside the active Domain Capture scope.",
      403,
      { domain, hostname },
    );
  }
}

function validateNavigationUrl(value: string): void {
  if (value.length > 100_000) {
    throw new BrowserSiloError(
      "INVALID_REQUEST",
      "Navigation URL exceeds the configured limit.",
      400,
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserSiloError(
      "INVALID_REQUEST",
      "Navigation requires an absolute URL.",
      400,
    );
  }
  if (!["http:", "https:", "data:"].includes(url.protocol)) {
    throw new BrowserSiloError(
      "INVALID_REQUEST",
      "Only HTTP, HTTPS, and bounded data URLs are supported.",
      400,
    );
  }
}

function validateSelector(selector: string): void {
  if (selector.trim().length < 1 || selector.length > 2_000) {
    throw new BrowserSiloError(
      "INVALID_REQUEST",
      "CSS selector must be between 1 and 2,000 characters.",
      400,
    );
  }
}
