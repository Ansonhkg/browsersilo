import { createHash, randomBytes, randomUUID } from "node:crypto";
import { BrowserSiloError } from "../core/errors.js";
import type { Principal } from "../core/model.js";

export type BrowserEventType =
  | "browser.requested"
  | "browser.ready"
  | "browser.closed"
  | "page.changed"
  | "action.completed"
  | "action.failed"
  | "capture.started"
  | "capture.completed"
  | "artifact.created"
  | "takeover.started"
  | "takeover.ended"
  | "warning";

export interface BrowserEvent {
  id: string;
  browserId: string;
  type: BrowserEventType;
  occurredAt: string;
  data: Record<string, unknown>;
}

type EventSubscriber = (event: BrowserEvent) => void;

export class RealtimeEventHub {
  readonly #events = new Map<string, BrowserEvent[]>();
  readonly #subscribers = new Map<string, Set<EventSubscriber>>();
  readonly #nextSequence = new Map<string, number>();
  readonly #historyLimit: number;

  constructor(historyLimit = 512) {
    this.#historyLimit = historyLimit;
  }

  emit(
    browserId: string,
    type: BrowserEventType,
    data: Record<string, unknown> = {},
  ): BrowserEvent {
    const sequence = (this.#nextSequence.get(browserId) ?? 0) + 1;
    this.#nextSequence.set(browserId, sequence);
    const event: BrowserEvent = {
      id: `${browserId}:${sequence}`,
      browserId,
      type,
      occurredAt: new Date().toISOString(),
      data: { ...data },
    };
    const history = this.#events.get(browserId) ?? [];
    history.push(event);
    if (history.length > this.#historyLimit) {
      history.splice(0, history.length - this.#historyLimit);
    }
    this.#events.set(browserId, history);
    for (const subscriber of this.#subscribers.get(browserId) ?? []) {
      subscriber(event);
    }
    return event;
  }

  replay(browserId: string, afterId?: string): BrowserEvent[] {
    const history = this.#events.get(browserId) ?? [];
    if (!afterId) return history.map(cloneEvent);
    const index = history.findIndex((event) => event.id === afterId);
    if (index >= 0) return history.slice(index + 1).map(cloneEvent);
    if (history.length > 0) {
      throw new BrowserSiloError(
        "EVENT_REPLAY_EXPIRED",
        "The requested event replay position is no longer available. Fetch current browser state before reconnecting.",
        409,
        { oldestEventId: history[0]!.id, newestEventId: history.at(-1)!.id },
      );
    }
    return [];
  }

  subscribe(browserId: string, subscriber: EventSubscriber): () => void {
    const subscribers = this.#subscribers.get(browserId) ?? new Set<EventSubscriber>();
    subscribers.add(subscriber);
    this.#subscribers.set(browserId, subscribers);
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) this.#subscribers.delete(browserId);
    };
  }
}

export type LiveRole = "observe" | "assist" | "takeover";

export interface LiveTokenRecord {
  tokenHash: string;
  browserId: string;
  tenantId: string;
  principalId: string;
  principalKind: Principal["kind"];
  role: LiveRole;
  expiresAt: number;
}

export class LiveTokenRegistry {
  readonly #tokens = new Map<string, LiveTokenRecord>();

  issue(
    principal: Principal,
    browserId: string,
    role: LiveRole = "takeover",
    ttlSeconds = 300,
  ): { token: string; role: LiveRole; expiresAt: string } {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.#tokens.set(tokenHash, {
      tokenHash,
      browserId,
      tenantId: principal.tenantId,
      principalId: principal.principalId,
      principalKind: principal.kind,
      role,
      expiresAt,
    });
    this.#prune();
    return { token, role, expiresAt: new Date(expiresAt).toISOString() };
  }

  validate(token: string, browserId: string): LiveTokenRecord {
    const record = this.#tokens.get(hashToken(token));
    if (!record || record.browserId !== browserId || record.expiresAt <= Date.now()) {
      throw new BrowserSiloError(
        "UNAUTHENTICATED",
        "The live browser credential is invalid or expired.",
        401,
      );
    }
    return { ...record };
  }

  revokeBrowser(browserId: string): void {
    for (const [key, value] of this.#tokens) {
      if (value.browserId === browserId) this.#tokens.delete(key);
    }
  }

  #prune(): void {
    const now = Date.now();
    for (const [key, value] of this.#tokens) {
      if (value.expiresAt <= now) this.#tokens.delete(key);
    }
  }
}

interface TakeoverState {
  connectionId: string;
  expiresAt: number;
}

export class TakeoverRegistry {
  readonly #states = new Map<string, TakeoverState>();

  connectionId(): string {
    return randomUUID();
  }

  begin(browserId: string, connectionId: string, ttlSeconds = 300): void {
    const current = this.#current(browserId);
    if (current && current.connectionId !== connectionId) {
      throw new BrowserSiloError(
        "TAKEOVER_CONFLICT",
        "Another controller currently owns browser input.",
        409,
      );
    }
    this.#states.set(browserId, {
      connectionId,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  end(browserId: string, connectionId?: string): boolean {
    const current = this.#current(browserId);
    if (!current || (connectionId && current.connectionId !== connectionId)) return false;
    this.#states.delete(browserId);
    return true;
  }

  assertAgentMayAct(browserId: string): void {
    if (this.#current(browserId)) {
      throw new BrowserSiloError(
        "HUMAN_TAKEOVER_ACTIVE",
        "Human control is active. Wait for control to be returned and then request a fresh snapshot.",
        409,
      );
    }
  }

  assertController(browserId: string, connectionId: string): void {
    const current = this.#current(browserId);
    if (!current || current.connectionId !== connectionId) {
      throw new BrowserSiloError(
        "FORBIDDEN",
        "This live connection does not own browser input.",
        403,
      );
    }
  }

  #current(browserId: string): TakeoverState | null {
    const current = this.#states.get(browserId);
    if (!current) return null;
    if (current.expiresAt <= Date.now()) {
      this.#states.delete(browserId);
      return null;
    }
    return current;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function cloneEvent(event: BrowserEvent): BrowserEvent {
  return { ...event, data: { ...event.data } };
}
