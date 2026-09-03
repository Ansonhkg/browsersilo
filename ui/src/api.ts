import { Effect } from "effect";
import type { AdminSnapshot, OperatorSettings } from "./types";

export class AdminApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
  }
}

export function fetchSnapshot(token: string): Effect.Effect<AdminSnapshot, AdminApiError> {
  return Effect.tryPromise({
    try: async () => {
      const headers = { authorization: `Bearer ${token}` };
      const [response, artifactsResponse, telemetryResponse, adaptersResponse] = await Promise.all([
        fetch("/admin/v1/snapshot", { headers, signal: AbortSignal.timeout(10_000) }),
        fetch("/admin/v1/artifacts", { headers, signal: AbortSignal.timeout(10_000) }),
        fetch("/admin/v1/telemetry", { headers, signal: AbortSignal.timeout(10_000) }),
        fetch("/admin/v1/adapters", { headers, signal: AbortSignal.timeout(10_000) }),
      ]);
      if (!response.ok || !artifactsResponse.ok || !telemetryResponse.ok || !adaptersResponse.ok) {
        const status = [response, artifactsResponse, telemetryResponse, adaptersResponse].find((item) => !item.ok)!.status;
        throw new AdminApiError(
          status,
          status === 401
            ? "The admin token is invalid."
            : `The Admin API returned ${status}.`,
        );
      }
      const snapshot = (await response.json()) as Omit<
        AdminSnapshot,
        "artifacts" | "artifactRetentionSeconds" | "telemetry" | "adapters"
      >;
      const artifactPayload = (await artifactsResponse.json()) as {
        artifacts: AdminSnapshot["artifacts"];
        retentionSeconds: number;
      };
      return {
        ...snapshot,
        artifacts: artifactPayload.artifacts,
        artifactRetentionSeconds: artifactPayload.retentionSeconds,
        telemetry: await telemetryResponse.json() as AdminSnapshot["telemetry"],
        adapters: await adaptersResponse.json() as AdminSnapshot["adapters"],
      };
    },
    catch: (error) =>
      error instanceof AdminApiError
        ? error
        : new AdminApiError(0, error instanceof Error ? error.message : "Request failed."),
  });
}

export async function updatePool(
  token: string,
  input: Record<string, number>,
): Promise<void> {
  await mutation(token, "/admin/v1/pool", input);
}

export async function updateArtifactRetention(
  token: string,
  retentionSeconds: number,
): Promise<void> {
  await mutation(token, "/admin/v1/artifacts/retention", { retentionSeconds });
}

export async function updateAdapterSettings(
  token: string,
  input: OperatorSettings,
): Promise<void> {
  await mutation(token, "/admin/v1/adapters", input as unknown as Record<string, unknown>);
}

export async function downloadArtifact(
  token: string,
  artifactId: string,
  name: string,
): Promise<void> {
  const response = await fetch(
    `/admin/v1/artifacts/${encodeURIComponent(artifactId)}/export`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new AdminApiError(response.status, "Artifact export failed.");
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function createLiveToken(
  token: string,
  browserId: string,
  role: "observe" | "takeover",
): Promise<{ token: string; role: string; expiresAt: string }> {
  const response = await fetch(`/admin/v1/browsers/${encodeURIComponent(browserId)}/live-token`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ role }),
  });
  if (!response.ok) throw new AdminApiError(response.status, "Live browser access failed.");
  return response.json() as Promise<{ token: string; role: string; expiresAt: string }>;
}

async function mutation(
  token: string,
  path: string,
  input: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(path, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as {
      error?: { message?: string };
    } | null;
    throw new AdminApiError(
      response.status,
      payload?.error?.message ?? "Control-plane update failed.",
    );
  }
}
