import { randomUUID } from "node:crypto";

export interface RequestSpan {
  traceId: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  occurredAt: string;
}

export class RuntimeObservability {
  readonly #counts = new Map<string, { method: string; route: string; status: number; count: number }>();
  readonly #durations = new Map<string, number>();
  readonly #spans: RequestSpan[] = [];
  #inFlight = 0;

  start(method: string, pathname: string): {
    traceId: string;
    finish(status: number): void;
  } {
    const started = performance.now();
    const route = normalizeRoute(pathname);
    const traceId = randomUUID();
    this.#inFlight += 1;
    return { traceId, finish: (status: number) => {
      this.#inFlight -= 1;
      const durationMs = Math.max(0, performance.now() - started);
      const key = JSON.stringify([method, route, status]);
      const current = this.#counts.get(key);
      this.#counts.set(key, {
        method,
        route,
        status,
        count: (current?.count ?? 0) + 1,
      });
      this.#durations.set(key, (this.#durations.get(key) ?? 0) + durationMs);
      this.#spans.unshift({
        traceId,
        method,
        route,
        status,
        durationMs: Math.round(durationMs * 100) / 100,
        occurredAt: new Date().toISOString(),
      });
      if (this.#spans.length > 500) this.#spans.length = 500;
    } };
  }

  snapshot(): {
    inFlight: number;
    requests: number;
    errors: number;
    averageDurationMs: number;
    spans: RequestSpan[];
  } {
    const requests = [...this.#counts.values()].reduce((sum, value) => sum + value.count, 0);
    const errors = [...this.#counts.values()]
      .filter((metric) => metric.status >= 500)
      .reduce((sum, metric) => sum + metric.count, 0);
    const duration = [...this.#durations.values()].reduce((sum, value) => sum + value, 0);
    return {
      inFlight: this.#inFlight,
      requests,
      errors,
      averageDurationMs: requests === 0 ? 0 : Math.round((duration / requests) * 100) / 100,
      spans: this.#spans.slice(0, 100),
    };
  }

  prometheus(): string {
    const lines = [
      "# HELP browsersilo_http_requests_total HTTP requests by method, route, and status.",
      "# TYPE browsersilo_http_requests_total counter",
      "# HELP browsersilo_http_request_duration_ms_sum Total HTTP request duration in milliseconds.",
      "# TYPE browsersilo_http_request_duration_ms_sum counter",
      "# HELP browsersilo_http_request_duration_ms_count HTTP requests represented by the duration sum.",
      "# TYPE browsersilo_http_request_duration_ms_count counter",
    ];
    for (const { method, route, status, count } of this.#counts.values()) {
      const key = JSON.stringify([method, route, status]);
      lines.push(
        `browsersilo_http_requests_total{method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${status}"} ${count}`,
        `browsersilo_http_request_duration_ms_sum{method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${status}"} ${this.#durations.get(key) ?? 0}`,
        `browsersilo_http_request_duration_ms_count{method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${status}"} ${count}`,
      );
    }
    lines.push(
      "# HELP browsersilo_http_in_flight HTTP requests currently being served.",
      "# TYPE browsersilo_http_in_flight gauge",
      `browsersilo_http_in_flight ${this.#inFlight}`,
    );
    return `${lines.join("\n")}\n`;
  }
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function normalizeRoute(pathname: string): string {
  return pathname
    .replace(/\/(?:profile|lease|worker|artifact)_[a-f0-9-]+/g, "/:id")
    .replace(/\/agent_browser_[a-z0-9_]+/g, "/:tool");
}
