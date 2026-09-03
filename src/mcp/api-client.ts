export class BrowserSiloApiClient {
  readonly #baseUrl: string;
  readonly #token: string;

  constructor(baseUrl: string, token: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#token = token;
  }

  capabilities(): Promise<unknown> {
    return this.#request("GET", "/v1/capabilities");
  }

  openBrowser(input: {
    identity: string;
    allowedDomains?: string[];
    ttlSeconds?: number;
    idempotencyKey?: string;
  }): Promise<unknown> {
    return this.#request(
      "POST",
      "/v1/browsers",
      {
        identity: input.identity,
        ...(input.allowedDomains ? { allowedDomains: input.allowedDomains } : {}),
        ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
      },
      input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : {},
    );
  }

  browserAction(browserId: string, action: Record<string, unknown>): Promise<unknown> {
    return this.#request(
      "POST",
      `/v1/browsers/${encodeURIComponent(browserId)}/actions`,
      action,
    );
  }

  closeBrowser(browserId: string): Promise<unknown> {
    return this.#request(
      "DELETE",
      `/v1/browsers/${encodeURIComponent(browserId)}`,
    );
  }

  createProfile(name: string): Promise<unknown> {
    return this.#request("POST", "/v1/profiles", { name });
  }

  listProfiles(): Promise<unknown> {
    return this.#request("GET", "/v1/profiles");
  }

  listArtifacts(kind?: string): Promise<unknown> {
    return this.#request(
      "GET",
      `/v1/artifacts${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`,
    );
  }

  async uploadArtifact(input: {
    name: string;
    mimeType: string;
    kind: string;
    dataBase64: string;
  }): Promise<unknown> {
    const response = await fetch(`${this.#baseUrl}/v1/artifacts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": input.mimeType,
        "x-browsersilo-artifact-name": input.name,
        "x-browsersilo-artifact-kind": input.kind,
      },
      body: Buffer.from(input.dataBase64, "base64"),
      signal: AbortSignal.timeout(60_000),
    });
    const payload = await response.json().catch(() => null) as {
      error?: { code?: string; message?: string };
    } | null;
    if (!response.ok) {
      throw new Error(
        `${payload?.error?.code ?? "HTTP_ERROR"}: ${payload?.error?.message ?? `BrowserSilo API returned ${response.status}`}`,
      );
    }
    return payload;
  }

  acquireLease(input: {
    profileId: string;
    ttlSeconds?: number;
    idempotencyKey?: string;
    allowedDomains?: string[];
  }): Promise<unknown> {
    const body: { profileId: string; ttlSeconds?: number; allowedDomains?: string[] } = {
      profileId: input.profileId,
    };
    if (input.ttlSeconds !== undefined) body.ttlSeconds = input.ttlSeconds;
    if (input.allowedDomains !== undefined) body.allowedDomains = input.allowedDomains;
    return this.#request("POST", "/v1/leases", body, {
      ...(input.idempotencyKey
        ? { "idempotency-key": input.idempotencyKey }
        : {}),
    });
  }

  renewLease(
    leaseId: string,
    fencingToken: number,
    ttlSeconds?: number,
  ): Promise<unknown> {
    const body: { fencingToken: number; ttlSeconds?: number } = {
      fencingToken,
    };
    if (ttlSeconds !== undefined) body.ttlSeconds = ttlSeconds;
    return this.#action(leaseId, "renew", body);
  }

  releaseLease(leaseId: string, fencingToken: number): Promise<unknown> {
    return this.#action(leaseId, "release", { fencingToken });
  }

  navigate(leaseId: string, fencingToken: number, url: string): Promise<unknown> {
    return this.#action(leaseId, "navigate", { fencingToken, url });
  }

  snapshot(leaseId: string, fencingToken: number): Promise<unknown> {
    return this.#action(leaseId, "snapshot", { fencingToken });
  }

  screenshot(
    leaseId: string,
    fencingToken: number,
  ): Promise<{ mimeType: "image/png"; data: string }> {
    return this.#action(leaseId, "screenshot", { fencingToken }) as Promise<{
      mimeType: "image/png";
      data: string;
    }>;
  }

  click(
    leaseId: string,
    fencingToken: number,
    selector: string,
  ): Promise<unknown> {
    return this.#action(leaseId, "click", { fencingToken, selector });
  }

  type(
    leaseId: string,
    fencingToken: number,
    selector: string,
    text: string,
  ): Promise<unknown> {
    return this.#action(leaseId, "type", {
      fencingToken,
      selector,
      text,
    });
  }

  evaluate(
    leaseId: string,
    fencingToken: number,
    expression: string,
  ): Promise<unknown> {
    return this.#action(leaseId, "evaluate", {
      fencingToken,
      expression,
    });
  }

  tabs(leaseId: string, fencingToken: number): Promise<unknown> {
    return this.#action(leaseId, "tabs", { fencingToken });
  }

  captureDomain(
    leaseId: string,
    fencingToken: number,
    url: string,
    redactSecrets: boolean,
    includeTrace = true,
    includeVideo = false,
  ): Promise<unknown> {
    return this.#action(leaseId, "capture-domain", {
      fencingToken,
      url,
      redactSecrets,
      includeTrace,
      includeVideo,
    });
  }

  startDomainCapture(
    leaseId: string,
    fencingToken: number,
    domain: string,
    options: { redactSecrets: boolean; includeTrace: boolean; includeVideo: boolean },
  ): Promise<unknown> {
    return this.#action(leaseId, "capture-domain/start", {
      fencingToken,
      domain,
      ...options,
    });
  }

  stopDomainCapture(leaseId: string, fencingToken: number): Promise<unknown> {
    return this.#action(leaseId, "capture-domain/stop", { fencingToken });
  }

  agentTool(
    leaseId: string,
    fencingToken: number,
    toolName: string,
    arguments_: Record<string, unknown>,
  ): Promise<unknown> {
    return this.#request(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/tools/${encodeURIComponent(toolName)}`,
      { fencingToken, arguments: arguments_ },
    );
  }

  #action(
    leaseId: string,
    action: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    return this.#request(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/${action}`,
      body,
    );
  }

  async #request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
    additionalHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body ? { "content-type": "application/json" } : {}),
        ...additionalHeaders,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    const payload = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;
    if (!response.ok) {
      throw new Error(
        `${payload?.error?.code ?? "HTTP_ERROR"}: ${payload?.error?.message ?? `BrowserSilo API returned ${response.status}`}`,
      );
    }
    return payload;
  }
}
