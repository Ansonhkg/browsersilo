import { BrowserSiloError } from "../core/errors.js";
import type { BrowserLease, Principal } from "../core/model.js";
import type { BrowserToolResult } from "../core/ports.js";
import type { BrowserSiloCore } from "../core/service.js";
import type { BrowserAutomationService } from "./service.js";
import {
  LiveTokenRegistry,
  RealtimeEventHub,
  TakeoverRegistry,
  type LiveRole,
} from "../realtime/service.js";

export type PublicBrowserAction =
  | { type: "navigate"; url: string }
  | { type: "snapshot" }
  | { type: "screenshot" }
  | { type: "click"; target: string }
  | { type: "type"; target: string; text: string }
  | { type: "press"; key: string }
  | { type: "scroll"; direction: "up" | "down" | "left" | "right"; amount?: number }
  | { type: "tabs" }
  | { type: "tool"; name: string; arguments?: Record<string, unknown> };

export class BrowserGatewayService {
  readonly core: BrowserSiloCore;
  readonly automation: BrowserAutomationService;
  readonly events: RealtimeEventHub;
  readonly liveTokens: LiveTokenRegistry;
  readonly takeover: TakeoverRegistry;

  constructor(
    core: BrowserSiloCore,
    automation: BrowserAutomationService,
    options: {
      events?: RealtimeEventHub;
      liveTokens?: LiveTokenRegistry;
      takeover?: TakeoverRegistry;
    } = {},
  ) {
    this.core = core;
    this.automation = automation;
    this.events = options.events ?? new RealtimeEventHub();
    this.liveTokens = options.liveTokens ?? new LiveTokenRegistry();
    this.takeover = options.takeover ?? new TakeoverRegistry();
  }

  async open(
    principal: Principal,
    input: {
      identity: string;
      allowedDomains?: string[];
      ttlSeconds?: number;
      idempotencyKey?: string;
    },
  ): Promise<Record<string, unknown>> {
    const identity = input.identity.trim();
    if (!identity || identity.length > 100) {
      throw new BrowserSiloError(
        "INVALID_REQUEST",
        "identity must contain between 1 and 100 characters.",
        400,
      );
    }
    const profiles = await this.core.listProfiles(principal);
    let profile = profiles.find((candidate) => candidate.id === identity) ??
      profiles.find((candidate) => candidate.name === identity);
    if (!profile) profile = await this.core.createProfile(principal, { name: identity });
    const lease = await this.core.acquireLease(principal, {
      profileId: profile.id,
      ...(input.allowedDomains ? { allowedDomains: input.allowedDomains } : {}),
      ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    this.events.emit(lease.id, "browser.requested", { identity: profile.name });
    this.events.emit(lease.id, "browser.ready", { identity: profile.name });
    const live = this.liveTokens.issue(principal, lease.id, "observe");
    return this.#publicBrowser(lease, profile.name, live);
  }

  async get(principal: Principal, browserId: string): Promise<Record<string, unknown>> {
    const lease = await this.#lease(principal, browserId, false);
    const profile = await this.core.getProfile(principal, lease.profileId);
    return this.#publicBrowser(lease, profile.name);
  }

  async close(principal: Principal, browserId: string): Promise<Record<string, unknown>> {
    const lease = await this.#lease(principal, browserId);
    await this.automation.finalizeLease(principal, lease.id, lease.fencingToken);
    const closed = await this.core.releaseLease(principal, lease.id, {
      fencingToken: lease.fencingToken,
    });
    this.takeover.end(browserId);
    this.liveTokens.revokeBrowser(browserId);
    this.events.emit(browserId, "browser.closed", { reason: "client" });
    return { id: browserId, status: "closed", closedAt: closed.closedAt };
  }

  async action(
    principal: Principal,
    browserId: string,
    action: PublicBrowserAction,
    options: { humanControllerId?: string } = {},
  ): Promise<unknown> {
    const lease = await this.#lease(principal, browserId);
    if (options.humanControllerId) {
      this.takeover.assertController(browserId, options.humanControllerId);
    } else {
      this.takeover.assertAgentMayAct(browserId);
    }
    try {
      const result = await this.#perform(principal, lease, action);
      this.events.emit(browserId, "action.completed", { action: action.type });
      if (action.type === "navigate") {
        const navigation = result as { url?: unknown; title?: unknown };
        this.events.emit(browserId, "page.changed", {
          url: navigation.url,
          title: navigation.title,
        });
      }
      return result;
    } catch (error) {
      this.events.emit(browserId, "action.failed", {
        action: action.type,
        code: error instanceof BrowserSiloError ? error.code : "BROWSER_COMMAND_FAILED",
      });
      throw error;
    }
  }

  async batch(
    principal: Principal,
    browserId: string,
    actions: PublicBrowserAction[],
    stopOnError = true,
  ): Promise<Array<{ ok: boolean; result?: unknown; error?: Record<string, unknown> }>> {
    if (actions.length < 1 || actions.length > 100) {
      throw new BrowserSiloError(
        "INVALID_REQUEST",
        "A batch must contain between 1 and 100 actions.",
        400,
      );
    }
    const results: Array<{ ok: boolean; result?: unknown; error?: Record<string, unknown> }> = [];
    for (const action of actions) {
      try {
        results.push({ ok: true, result: await this.action(principal, browserId, action) });
      } catch (error) {
        results.push({
          ok: false,
          error: error instanceof BrowserSiloError
            ? { code: error.code, message: error.message }
            : { code: "BROWSER_COMMAND_FAILED", message: "The browser action failed." },
        });
        if (stopOnError) break;
      }
    }
    return results;
  }

  async screenshot(principal: Principal, browserId: string, options?: { fullPage?: boolean }) {
    const lease = await this.#lease(principal, browserId);
    return this.automation.screenshot(principal, lease.id, lease.fencingToken, options);
  }

  async issueLiveToken(
    principal: Principal,
    browserId: string,
    role: LiveRole,
  ): Promise<{ token: string; role: LiveRole; expiresAt: string }> {
    await this.#lease(principal, browserId);
    return this.liveTokens.issue(principal, browserId, role);
  }

  async beginCapture(
    principal: Principal,
    browserId: string,
    input: { domain: string; redactSecrets?: boolean; includeTrace?: boolean; includeVideo?: boolean },
  ): Promise<unknown> {
    const lease = await this.#lease(principal, browserId);
    const capture = await this.automation.startDomainCapture(
      principal,
      lease.id,
      lease.fencingToken,
      input.domain,
      input,
    );
    this.events.emit(browserId, "capture.started", { domain: input.domain });
    return capture;
  }

  async endCapture(principal: Principal, browserId: string): Promise<unknown> {
    const lease = await this.#lease(principal, browserId);
    const capture = await this.automation.stopDomainCapture(
      principal,
      lease.id,
      lease.fencingToken,
    );
    this.events.emit(browserId, "capture.completed", {});
    return capture;
  }

  async input(
    principal: Principal,
    browserId: string,
    connectionId: string,
    message: Record<string, unknown>,
  ): Promise<unknown> {
    const type = message["type"];
    if (type === "input.keyboard") {
      const key = message["key"];
      if (typeof key !== "string" || key.length < 1 || key.length > 100) {
        throw new BrowserSiloError("INVALID_REQUEST", "A valid keyboard key is required.", 400);
      }
      return this.action(
        principal,
        browserId,
        { type: "press", key },
        { humanControllerId: connectionId },
      );
    }
    if (type === "input.pointer") {
      const x = message["x"];
      const y = message["y"];
      if (
        typeof x !== "number" || typeof y !== "number" ||
        !Number.isFinite(x) || !Number.isFinite(y) ||
        x < 0 || y < 0 || x > 16_384 || y > 16_384
      ) {
        throw new BrowserSiloError("INVALID_REQUEST", "Pointer coordinates are invalid.", 400);
      }
      const lease = await this.#lease(principal, browserId);
      this.takeover.assertController(browserId, connectionId);
      await this.automation.agentTool(principal, lease.id, lease.fencingToken, "agent_browser_mouse_move", { x, y });
      if (message["action"] === "click") {
        await this.automation.agentTool(principal, lease.id, lease.fencingToken, "agent_browser_mouse_down", { button: "left" });
        await this.automation.agentTool(principal, lease.id, lease.fencingToken, "agent_browser_mouse_up", { button: "left" });
      }
      return { ok: true };
    }
    throw new BrowserSiloError("INVALID_REQUEST", "The live input message type is unsupported.", 400);
  }

  principalFromLiveToken(token: string, browserId: string): { principal: Principal; role: LiveRole } {
    const record = this.liveTokens.validate(token, browserId);
    return {
      principal: {
        tenantId: record.tenantId,
        principalId: record.principalId,
        kind: record.principalKind,
      },
      role: record.role,
    };
  }

  async #perform(
    principal: Principal,
    lease: BrowserLease,
    action: PublicBrowserAction,
  ): Promise<unknown> {
    switch (action.type) {
      case "navigate":
        return this.automation.navigate(principal, lease.id, lease.fencingToken, action.url);
      case "snapshot":
        return this.automation.snapshot(principal, lease.id, lease.fencingToken);
      case "screenshot":
        return this.automation.screenshot(principal, lease.id, lease.fencingToken);
      case "click":
        await this.automation.click(principal, lease.id, lease.fencingToken, action.target);
        return { ok: true };
      case "type":
        await this.automation.type(principal, lease.id, lease.fencingToken, action.target, action.text);
        return { ok: true };
      case "press":
        return this.automation.agentTool(principal, lease.id, lease.fencingToken, "agent_browser_press", { key: action.key });
      case "scroll":
        return this.automation.agentTool(principal, lease.id, lease.fencingToken, "agent_browser_scroll", {
          direction: action.direction,
          ...(action.amount !== undefined ? { amount: action.amount } : {}),
        });
      case "tabs":
        return this.automation.tabs(principal, lease.id, lease.fencingToken);
      case "tool":
        if (!action.name.startsWith("agent_browser_")) {
          throw new BrowserSiloError("INVALID_REQUEST", "Only BrowserSilo-reviewed browser tools are accepted.", 400);
        }
        return this.automation.agentTool(
          principal,
          lease.id,
          lease.fencingToken,
          action.name,
          action.arguments ?? {},
        ) as Promise<BrowserToolResult>;
    }
  }

  async #lease(
    principal: Principal,
    browserId: string,
    requireActive = true,
  ): Promise<BrowserLease> {
    const lease = await this.core.getLease(principal, browserId);
    if (requireActive && lease.state !== "active") {
      throw new BrowserSiloError(
        "LEASE_NOT_ACTIVE",
        "This browser is no longer active.",
        409,
        { status: lease.state },
      );
    }
    return lease;
  }

  #publicBrowser(
    lease: BrowserLease,
    identity: string,
    live?: { token: string; role: LiveRole; expiresAt: string },
  ): Record<string, unknown> {
    return {
      id: lease.id,
      identity,
      status: lease.state === "active" ? "ready" : lease.state,
      expiresAt: lease.expiresAt,
      allowedDomains: [...lease.egressPolicy.allowedDomains],
      eventsUrl: `/v1/browsers/${lease.id}/events`,
      liveUrl: `/v1/browsers/${lease.id}/live`,
      ...(live ? { live } : {}),
    };
  }
}
