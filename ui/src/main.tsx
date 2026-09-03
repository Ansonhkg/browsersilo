import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import {
  Alert,
  Button,
  Input,
  Label,
  Spinner,
  TextField,
} from "@heroui/react";
import { DashboardShell } from "./dashboard-shell";
import {
  Activity,
  Archive,
  Blocks,
  Bot,
  Box,
  CircleGauge,
  FileKey,
  KeyRound,
  Moon,
  Network,
  Settings,
  ShieldCheck,
  Sun,
  Users,
  Video,
  Download,
  Save,
  X,
  Eye,
  Hand,
  Copy,
  Maximize2,
} from "lucide-react";
import {
  downloadArtifact,
  createLiveToken,
  fetchSnapshot,
  updateArtifactRetention,
  updateAdapterSettings,
  updatePool,
} from "./api";
import type {
  AdminSnapshot,
  AuditEvent,
  BrowserLease,
  BrowserProfile,
  BrowserWorker,
  ArtifactMetadata,
} from "./types";
import "./styles.css";

type Theme = "dark" | "light";

interface SessionContextValue {
  token: string;
  setToken(token: string): void;
  theme: Theme;
  setTheme(theme: Theme): void;
}

const SessionContext = createContext<SessionContextValue | null>(null);
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

const navigation = [
  { to: "/", label: "Overview", icon: CircleGauge },
  { to: "/workers", label: "Workers", icon: Box },
  { to: "/profiles", label: "Profiles", icon: Users },
  { to: "/leases", label: "Leases", icon: KeyRound },
  { to: "/captures", label: "Captures", icon: Archive },
  { to: "/recordings", label: "Recordings", icon: Video },
  { to: "/policies", label: "Policies", icon: ShieldCheck },
  { to: "/adapters", label: "Adapters", icon: Blocks },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

const rootRoute = createRootRoute({ component: RootScreen });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: OverviewPage,
});
const workersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workers",
  component: WorkersPage,
});
const profilesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/profiles",
  component: ProfilesPage,
});
const leasesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/leases",
  component: LeasesPage,
});
const capturesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/captures",
  component: CapturesPage,
});
const recordingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/recordings",
  component: RecordingsPage,
});
const policiesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/policies",
  component: PoliciesPage,
});
const adaptersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/adapters",
  component: AdaptersPage,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  workersRoute,
  profilesRoute,
  leasesRoute,
  capturesRoute,
  recordingsRoute,
  policiesRoute,
  adaptersRoute,
  settingsRoute,
]);
const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function RootScreen() {
  const [token, updateToken] = useState(
    () => window.sessionStorage.getItem("browsersilo-admin-token") ?? "",
  );
  const [theme, updateTheme] = useState<Theme>(() => {
    const stored = window.localStorage.getItem("browsersilo-theme");
    return stored === "light" ? "light" : "dark";
  });

  const setToken = (next: string) => {
    window.sessionStorage.setItem("browsersilo-admin-token", next);
    updateToken(next);
    void queryClient.invalidateQueries();
  };
  const setTheme = (next: Theme) => {
    window.localStorage.setItem("browsersilo-theme", next);
    updateTheme(next);
  };

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.dataset["theme"] = theme;
  }, [theme]);

  const context = useMemo(
    () => ({ token, setToken, theme, setTheme }),
    [token, theme],
  );

  return (
    <SessionContext.Provider value={context}>
      {token ? <FleetShell /> : <ConnectScreen />}
    </SessionContext.Provider>
  );
}

function FleetShell() {
  const routerInstance = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { theme, setTheme } = useSession();
  return (
    <DashboardShell
      brand={<Brand />}
      navigation={navigation}
      pathname={pathname}
      navigate={(href) => void routerInstance.navigate({ to: href })}
      theme={theme}
      setTheme={setTheme}
    >
      <Outlet />
    </DashboardShell>
  );
}

function ConnectScreen() {
  const { setToken, theme, setTheme } = useSession();
  const [value, setValue] = useState("");
  return (
    <main className="grid min-h-dvh place-items-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center justify-between">
          <Brand expanded />
          <Button
            isIconOnly
            aria-label={`Use ${theme === "dark" ? "light" : "dark"} mode`}
            variant="ghost"
            onPress={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Sun /> : <Moon />}
          </Button>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Connect to the control plane</h1>
        <p className="mt-2 text-sm text-muted">Enter the Admin API token for this BrowserSilo installation.</p>
        <form
          className="mt-6 flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (value.trim()) setToken(value.trim());
          }}
        >
          <TextField value={value} onChange={setValue} name="admin-token" type="password" fullWidth>
            <Label>Admin token</Label>
            <Input autoFocus placeholder="Enter admin token" />
          </TextField>
          <Button type="submit" variant="primary">Connect</Button>
        </form>
      </div>
    </main>
  );
}

function OverviewPage() {
  const query = useSnapshot();
  if (query.isLoading) return <LoadingPage />;
  if (query.error || !query.data) return <ErrorPage message={query.error?.message ?? "Snapshot unavailable."} />;
  const snapshot = query.data;
  const destroyed = snapshot.overview.workers["destroyed"] ?? 0;
  const ready = snapshot.overview.workers["ready"] ?? 0;
  return (
    <Page title="Overview" description="Live browser capacity, identities, leases, and lifecycle evidence.">
      <div className="bs-masonry">
        <Metric label="Active leases" value={snapshot.overview.activeLeases} detail="One private worker per lease" />
        <Metric label="Clean reserve" value={ready} detail="Never assigned to an agent" />
        <Metric label="Profiles" value={snapshot.overview.profiles} detail="Durable encrypted identities" />
        <Metric label="Destroyed" value={destroyed} detail="Used workers never return" />
        <section className="bs-wide">
          <SectionHeading title="Workers" detail={`${snapshot.overview.adapter} adapter`} />
          <WorkerTable workers={snapshot.workers.slice(-8)} />
        </section>
        <section className="bs-side">
          <SectionHeading title="Audit trail" detail="Latest first" />
          <AuditList audits={snapshot.audits.slice(0, 8)} />
        </section>
        {snapshot.overview.limitations.length > 0 ? (
          <section className="bs-full">
            <SectionHeading title="Runtime limitations" detail="Must be resolved before production tenancy" />
            <ul className="mt-4 grid gap-2 text-sm text-muted md:grid-cols-2">
              {snapshot.overview.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
            </ul>
          </section>
        ) : null}
      </div>
    </Page>
  );
}

function WorkersPage() {
  const query = useSnapshot();
  return <ResourceQueryPage query={query} title="Workers" description="Disposable Brave runtimes and their lifecycle states">{(data) => <WorkerTable workers={data.workers} />}</ResourceQueryPage>;
}

function ProfilesPage() {
  const query = useSnapshot();
  return <ResourceQueryPage query={query} title="Profiles" description="Owner-scoped encrypted browser identities">{(data) => <ProfileTable profiles={data.profiles} />}</ResourceQueryPage>;
}

function LeasesPage() {
  const query = useSnapshot();
  return (
    <ResourceQueryPage query={query} title="Live browsers" description="Watch active agents, or take over input temporarily when human help is needed.">
      {(data) => (
        <div className="grid gap-5">
          <LiveBrowserViewer leases={data.leases.filter((lease) => lease.state === "active")} />
          <LeaseTable leases={data.leases} />
        </div>
      )}
    </ResourceQueryPage>
  );
}

function LiveBrowserViewer({ leases }: { leases: BrowserLease[] }) {
  const { token } = useSession();
  const [browserId, setBrowserId] = useState(leases[0]?.id ?? "");
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [state, setState] = useState("Disconnected");
  const [role, setRole] = useState<"observe" | "takeover">("observe");
  const socketRef = useRef<WebSocket | null>(null);
  const frameUrlRef = useRef<string | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => {
    socketRef.current?.close();
    if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
  }, []);

  const connect = async (nextRole: "observe" | "takeover") => {
    if (!browserId) return;
    socketRef.current?.close();
    setState("Connecting…");
    const credential = await createLiveToken(token, browserId, nextRole);
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${scheme}://${window.location.host}/v1/browsers/${encodeURIComponent(browserId)}/live?token=${encodeURIComponent(credential.token)}`,
      "browsersilo.v1",
    );
    socket.binaryType = "blob";
    socketRef.current = socket;
    setRole(nextRole);
    let takeoverRequested = false;
    const requestTakeover = () => {
      if (nextRole === "takeover" && socket.readyState === WebSocket.OPEN && !takeoverRequested) {
        takeoverRequested = true;
        socket.send(JSON.stringify({ type: "takeover.request" }));
      }
    };
    socket.addEventListener("open", () => {
      setState(nextRole === "observe" ? "Watching live" : "Requesting human control…");
      requestTakeover();
    });
    socket.addEventListener("message", (event) => {
      if (event.data instanceof Blob) {
        const next = URL.createObjectURL(event.data);
        if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
        frameUrlRef.current = next;
        setFrameUrl(next);
        setState((current) => nextRole === "observe"
          ? "Watching live"
          : current === "Connecting…" ? "Requesting human control…" : current);
        return;
      }
      const message = JSON.parse(String(event.data)) as { type?: string };
      if (message.type === "browser.ready") {
        setState(nextRole === "observe" ? "Watching live" : "Requesting human control…");
        requestTakeover();
      }
      if (message.type === "takeover.started") setState("Human control active — agent paused");
      if (message.type === "takeover.ended") setState("Control returned — agent must refresh");
      if (message.type === "error") setState("Live operation was rejected");
    });
    socket.addEventListener("close", () => setState("Disconnected"));
  };

  const takeOver = () => {
    if (role !== "takeover" || socketRef.current?.readyState !== WebSocket.OPEN) {
      void connect("takeover");
      return;
    }
    socketRef.current.send(JSON.stringify({ type: "takeover.request" }));
  };
  const returnControl = () => socketRef.current?.send(JSON.stringify({ type: "takeover.release" }));
  const humanControlActive = state === "Human control active — agent paused";

  if (leases.length === 0) {
    return <div className="bs-live-empty"><Eye aria-hidden="true" /><span>No browser is active right now.</span></div>;
  }
  return (
    <section className="bs-live-panel">
      <div className="bs-live-toolbar">
        <div className="bs-live-status">
          <p className="text-sm font-semibold">Browser view</p>
          <p className="text-xs text-muted">{state}</p>
        </div>
        <select value={browserId} onChange={(event) => setBrowserId(event.target.value)} aria-label="Active browser">
          {leases.map((lease) => <option key={lease.id} value={lease.id}>{lease.id}</option>)}
        </select>
        <div className="bs-live-actions">
          <Button size="sm" variant="secondary" onPress={() => void connect("observe")}><Eye /> Watch</Button>
          <Button size="sm" variant={humanControlActive ? "secondary" : "primary"} onPress={takeOver}><Hand /> Take over</Button>
          <Button size="sm" variant={humanControlActive ? "primary" : "secondary"} onPress={returnControl}>Return control</Button>
        </div>
      </div>
      <div className="bs-live-stage" ref={stageRef}>
        {frameUrl ? (
          <Button
            className="bs-live-expand"
            isIconOnly
            size="sm"
            variant="secondary"
            aria-label="Open browser view fullscreen"
            onPress={() => void stageRef.current?.requestFullscreen()}
          >
            <Maximize2 aria-hidden="true" />
          </Button>
        ) : null}
        {frameUrl ? <img src={frameUrl} alt="Live Brave browser" /> : <p>Connect to watch this browser live.</p>}
      </div>
    </section>
  );
}

function CapturesPage() {
  const query = useSnapshot();
  return (
    <ResourceQueryPage
      query={query}
      title="Captures"
      description="Encrypted HAR, screenshot, trace, PDF, diff, and comprehensive Domain Capture evidence"
    >
      {(data) => (
        <ArtifactTable
          artifacts={data.artifacts.filter((artifact) => artifact.kind !== "recording")}
          empty="No capture artifacts yet. Agents can call browser_domain_capture or the HAR, PDF, trace, screenshot, and diff tools."
        />
      )}
    </ResourceQueryPage>
  );
}

function RecordingsPage() {
  const query = useSnapshot();
  return (
    <ResourceQueryPage
      query={query}
      title="Recordings"
      description="Owner-scoped WebM recordings captured from real headed Brave sessions"
    >
      {(data) => (
        <ArtifactTable
          artifacts={data.artifacts.filter((artifact) => artifact.kind === "recording")}
          empty="No recordings yet. Start and stop agent_browser_record to save an encrypted WebM artifact."
        />
      )}
    </ResourceQueryPage>
  );
}

function PoliciesPage() {
  const query = useSnapshot();
  return (
    <ResourceQueryPage query={query} title="Policies" description="Current capacity and runtime isolation policy">
      {(data) => <PolicyEditor snapshot={data} />}
    </ResourceQueryPage>
  );
}

function AdaptersPage() {
  const query = useSnapshot();
  return (
    <ResourceQueryPage query={query} title="Adapters" description="Runtime, persistence, capture, and key-management integrations">
      {(data) => {
        const browserMode = data.overview.mode === "browser";
        return (
        <div className="bs-masonry">
          <section className="bs-wide">
            <SectionHeading title="Active worker adapter" detail={browserMode ? "Browser mode" : "Foundation mode"} />
            <div className="mt-5 flex items-center gap-3"><Blocks className="text-accent" /><strong>{data.overview.adapter}</strong></div>
            <p className="mt-3 text-sm text-muted">
              {browserMode
                ? "Sandboxed Brave, private in-container MCP control, internal worker networks, and a policy-enforcing egress sidecar."
                : "In-memory lifecycle adapter for control-plane development and tests. It does not launch a browser or provide production isolation."}
            </p>
          </section>
          <section className="bs-side">
            <SectionHeading title="Persistence adapter" detail={browserMode ? "Envelope encrypted" : "Development state"} />
            <div className="mt-5 flex items-center gap-3"><FileKey className="text-accent" /><strong>{browserMode ? "BSLP2 + BSAR1" : "Local JSON"}</strong></div>
            <p className="mt-3 text-sm text-muted">
              {browserMode
                ? "Streaming profile archives and tenant-owned encrypted artifacts use independent data keys."
                : "Durable control state is local, while browser profiles and capture artifacts are unavailable until browser mode is active."}
            </p>
          </section>
          <section className="bs-full">
            <SectionHeading title="Operator contract" detail="Restart-gated adapter selection" />
            <p className="mt-4 text-sm text-muted">Capacity, tenant quotas, queues, and artifact retention update live. Worker and KMS adapter changes are deliberately restart-gated so active leases cannot silently change isolation or key custody.</p>
          </section>
          <AdapterEditor snapshot={data} />
        </div>
      );}}
    </ResourceQueryPage>
  );
}

function AdapterEditor({ snapshot }: { snapshot: AdminSnapshot }) {
  const { token } = useSession();
  const configured = snapshot.adapters.desired;
  const [workerAdapter, setWorkerAdapter] = useState<string>(configured.workerAdapter);
  const [workerImage, setWorkerImage] = useState(configured.workerImage);
  const [kmsProvider, setKmsProvider] = useState<string>(configured.kmsProvider);
  const [awsKmsKeyId, setAwsKmsKeyId] = useState(configured.awsKmsKeyId ?? "");
  const [seccompProfile, setSeccompProfile] = useState(configured.seccompProfile);
  const [memoryMiB, setMemoryMiB] = useState(String(configured.workerMemoryBytes / 1024 / 1024));
  const [workerCpus, setWorkerCpus] = useState(String(configured.workerCpus));
  const [pidsLimit, setPidsLimit] = useState(String(configured.workerPidsLimit));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await updateAdapterSettings(token, {
        workerAdapter: workerAdapter.trim() as "memory" | "docker",
        workerImage: workerImage.trim(),
        kmsProvider: kmsProvider.trim() as "local" | "aws-kms",
        awsKmsKeyId: awsKmsKeyId.trim() || null,
        seccompProfile: seccompProfile.trim(),
        workerMemoryBytes: Number(memoryMiB) * 1024 * 1024,
        workerCpus: Number(workerCpus),
        workerPidsLimit: Number(pidsLimit),
      });
      await queryClient.invalidateQueries({ queryKey: ["admin-snapshot", token] });
      setMessage("Adapter configuration saved. Restart BrowserSilo to activate it.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Adapter update failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="bs-full">
      <SectionHeading
        title="Restart-gated adapter controls"
        detail={snapshot.adapters.restartRequired ? "Restart required" : "Effective configuration"}
      />
      {snapshot.adapters.environmentOverrides.length > 0 ? (
        <Alert className="mt-4" status="warning">
          <Alert.Content>
            <Alert.Title>Environment overrides are active</Alert.Title>
            <Alert.Description>{snapshot.adapters.environmentOverrides.join(", ")} take precedence after restart.</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      <form className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <TextField value={workerAdapter} onChange={setWorkerAdapter} fullWidth><Label>Worker adapter</Label><Input /></TextField>
        <TextField value={workerImage} onChange={setWorkerImage} fullWidth><Label>Worker image</Label><Input /></TextField>
        <TextField value={kmsProvider} onChange={setKmsProvider} fullWidth><Label>KMS provider</Label><Input /></TextField>
        <TextField value={awsKmsKeyId} onChange={setAwsKmsKeyId} fullWidth><Label>AWS KMS key id</Label><Input /></TextField>
        <TextField className="md:col-span-2" value={seccompProfile} onChange={setSeccompProfile} fullWidth><Label>Seccomp profile</Label><Input /></TextField>
        <TextField value={memoryMiB} onChange={setMemoryMiB} type="number" fullWidth><Label>Worker memory MiB</Label><Input min="128" /></TextField>
        <TextField value={workerCpus} onChange={setWorkerCpus} type="number" fullWidth><Label>Worker CPUs</Label><Input min="0.1" step="0.1" /></TextField>
        <TextField value={pidsLimit} onChange={setPidsLimit} type="number" fullWidth><Label>Worker PID limit</Label><Input min="64" /></TextField>
        <div className="flex items-center gap-3 md:col-span-2 xl:col-span-4">
          <Button type="submit" variant="primary" isPending={saving}><Save aria-hidden="true" /> Save adapter configuration</Button>
          {message ? <p className="text-sm text-muted" role="status">{message}</p> : null}
        </div>
      </form>
    </section>
  );
}

function SettingsPage() {
  const { token, setToken, theme, setTheme } = useSession();
  const [nextToken, setNextToken] = useState(token);
  return (
    <Page title="Settings" description="Local control-plane preferences and connection credentials.">
      <div className="bs-masonry">
        <section className="bs-wide">
          <SectionHeading title="Admin connection" detail="Stored in session storage" />
          <form className="mt-5 flex max-w-xl gap-3" onSubmit={(event) => { event.preventDefault(); setToken(nextToken.trim()); }}>
            <TextField value={nextToken} onChange={setNextToken} type="password" fullWidth>
              <Label>Admin token</Label>
              <Input />
            </TextField>
            <Button type="submit" variant="primary">Save</Button>
            <Button type="button" variant="secondary" onPress={() => setToken("")}>Disconnect</Button>
          </form>
        </section>
        <section className="bs-side">
          <SectionHeading title="Appearance" detail="Persisted locally" />
          <div className="mt-5 flex gap-2">
            <Button variant={theme === "dark" ? "primary" : "secondary"} onPress={() => setTheme("dark")}><Moon />Dark</Button>
            <Button variant={theme === "light" ? "primary" : "secondary"} onPress={() => setTheme("light")}><Sun />Light</Button>
          </div>
        </section>
      </div>
    </Page>
  );
}

function PolicyEditor({ snapshot }: { snapshot: AdminSnapshot }) {
  const { token } = useSession();
  const [reserve, setReserve] = useState(String(snapshot.overview.pool.warmShellReserve));
  const [maximum, setMaximum] = useState(String(snapshot.overview.pool.maxActiveWorkers));
  const [tenantMaximum, setTenantMaximum] = useState(
    String(snapshot.overview.pool.maxActiveWorkersPerTenant ?? snapshot.overview.pool.maxActiveWorkers),
  );
  const [queueDepth, setQueueDepth] = useState(
    String(snapshot.overview.pool.maxQueueDepth ?? 0),
  );
  const [retentionDays, setRetentionDays] = useState(
    String(Math.round(snapshot.artifactRetentionSeconds / 86_400)),
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const updates: Array<Promise<void>> = [
        updatePool(token, {
          warmShellReserve: Number(reserve),
          maxActiveWorkers: Number(maximum),
          maxActiveWorkersPerTenant: Number(tenantMaximum),
          maxQueueDepth: Number(queueDepth),
        }),
      ];
      if (snapshot.adapters.effective.workerAdapter === "docker") {
        updates.push(updateArtifactRetention(token, Number(retentionDays) * 86_400));
      }
      await Promise.all(updates);
      await queryClient.invalidateQueries({ queryKey: ["admin-snapshot", token] });
      setMessage(
        snapshot.adapters.effective.workerAdapter === "docker"
          ? "Policy changes are active."
          : "Capacity policy is active. Artifact retention activates with the Docker adapter.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Policy update failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bs-masonry">
      <Metric label="Queued admissions" value={snapshot.overview.admission.queued} detail={`Limit ${snapshot.overview.admission.maxQueueDepth}`} />
      <Metric label="Active workers" value={snapshot.overview.activeLeases} detail={`Global limit ${snapshot.overview.pool.maxActiveWorkers}`} />
      <Metric label="Artifacts" value={snapshot.artifacts.length} detail={formatBytes(snapshot.telemetry.accounting.artifactBytes)} />
      <Metric label="HTTP errors" value={snapshot.telemetry.errors} detail={`${snapshot.telemetry.averageDurationMs} ms average`} />
      <section className="bs-full">
        <SectionHeading title="Live policy controls" detail="Applied without restarting active leases" />
        <form
          className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <PolicyNumber label="Clean reserve" value={reserve} onChange={setReserve} />
          <PolicyNumber label="Global worker limit" value={maximum} onChange={setMaximum} />
          <PolicyNumber label="Per-tenant limit" value={tenantMaximum} onChange={setTenantMaximum} />
          <PolicyNumber label="Admission queue" value={queueDepth} onChange={setQueueDepth} />
          <PolicyNumber
            label="Retention days"
            value={retentionDays}
            onChange={setRetentionDays}
            isDisabled={snapshot.adapters.effective.workerAdapter !== "docker"}
          />
          <div className="flex items-center gap-3 md:col-span-2 xl:col-span-5">
            <Button type="submit" variant="primary" isPending={saving}>
              <Save aria-hidden="true" /> Save policy
            </Button>
            {message ? <p className="text-sm text-muted" role="status">{message}</p> : null}
          </div>
        </form>
      </section>
      <section className="bs-full">
        <SectionHeading title="Fixed isolation guarantees" detail="Cannot be weakened per lease" />
        <ul className="mt-4 grid gap-2 text-sm text-muted md:grid-cols-2">
          <li>Private, loopback, link-local, metadata, and special-use destinations are denied.</li>
          <li>Every lease may narrow public egress with its own domain allowlist.</li>
          <li>Used workers are destroyed and never returned to the clean reserve.</li>
          <li>Artifacts and browser profiles use independently wrapped data keys.</li>
        </ul>
      </section>
    </div>
  );
}

function PolicyNumber({
  label,
  value,
  onChange,
  isDisabled = false,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  isDisabled?: boolean;
}) {
  return (
    <TextField value={value} onChange={onChange} type="number" isDisabled={isDisabled} fullWidth>
      <Label>{label}</Label>
      <Input min="0" inputMode="numeric" />
    </TextField>
  );
}

function ArtifactTable({
  artifacts,
  empty,
}: {
  artifacts: ArtifactMetadata[];
  empty: string;
}) {
  const { token } = useSession();
  return (
    <DataTable
      headers={["Artifact", "Kind", "Name", "Size", "Created", "Export"]}
      rows={artifacts.map((artifact) => [
        <CodeValue value={artifact.id} />,
        <Status value={artifact.kind} />,
        artifact.name,
        formatBytes(artifact.size),
        formatTime(artifact.createdAt),
        <Button
          size="sm"
          variant="secondary"
          aria-label={`Export ${artifact.name}`}
          onPress={() => void downloadArtifact(token, artifact.id, artifact.name)}
        >
          <Download aria-hidden="true" /> Export
        </Button>,
      ])}
      empty={empty}
    />
  );
}

function ResourceQueryPage({ query, title, description, children }: { query: ReturnType<typeof useSnapshot>; title: string; description: string; children(data: AdminSnapshot): ReactNode }) {
  if (query.isLoading) return <LoadingPage />;
  if (query.error || !query.data) return <ErrorPage message={query.error?.message ?? "Snapshot unavailable."} />;
  return <Page title={title} description={description}>{children(query.data)}</Page>;
}

function Page({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <div className="bs-page"><header className="mb-6"><h1 className="text-2xl font-semibold tracking-tight">{title}</h1><p className="mt-1 text-sm text-muted">{description}</p></header>{children}</div>;
}

function LoadingPage() {
  return <div className="grid min-h-72 place-items-center"><Spinner aria-label="Loading control-plane data" /></div>;
}

function ErrorPage({ message }: { message: string }) {
  const { setToken } = useSession();
  return <div className="bs-page"><Alert status="danger"><Alert.Content><Alert.Title>Control-plane request failed</Alert.Title><Alert.Description>{message}</Alert.Description></Alert.Content><Button variant="secondary" onPress={() => setToken("")}>Reconnect</Button></Alert></div>;
}

function Metric({ label, value, detail }: { label: string; value: number; detail: string }) {
  return <section className="bs-kpi"><p className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</p><p className="mt-3 text-3xl font-semibold tabular-nums">{value}</p><p className="mt-2 text-xs text-muted">{detail}</p></section>;
}

function SectionHeading({ title, detail }: { title: string; detail: string }) {
  return <div className="flex items-center justify-between gap-4"><h2 className="font-semibold">{title}</h2><p className="text-xs text-muted">{detail}</p></div>;
}

function WorkerTable({ workers }: { workers: BrowserWorker[] }) {
  return <DataTable headers={["Worker", "State", "Adapter", "Lease", "Brave"]} rows={workers.map((worker) => [<CodeValue value={worker.id} />, <Status value={worker.state} />, worker.adapter, <CodeValue value={worker.leaseId} />, worker.braveVersion ?? "Not started"])} empty="No workers found." />;
}

function ProfileTable({ profiles }: { profiles: BrowserProfile[] }) {
  return <DataTable headers={["Profile", "Name", "State", "Version", "Updated"]} rows={profiles.map((profile) => [<CodeValue value={profile.id} />, profile.name, <Status value={profile.status} />, profile.version, formatTime(profile.updatedAt)])} empty="No profiles found." />;
}

function LeaseTable({ leases }: { leases: BrowserLease[] }) {
  return <DataTable headers={["Lease", "Profile", "Worker", "State", "Fence", "Expires"]} rows={leases.map((lease) => [<CodeValue value={lease.id} />, <CodeValue value={lease.profileId} />, <CodeValue value={lease.workerId} />, <Status value={lease.state} />, lease.fencingToken, formatTime(lease.expiresAt)])} empty="No leases found." />;
}

function DataTable({ headers, rows, empty }: { headers: string[]; rows: ReactNode[][]; empty: string }) {
  if (rows.length === 0) return <p className="py-12 text-center text-sm text-muted">{empty}</p>;
  return <div className="bs-table-wrap mt-4"><table className="bs-table"><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} data-label={headers[cellIndex]}>{cell}</td>)}</tr>)}</tbody></table></div>;
}

function AuditList({ audits }: { audits: AuditEvent[] }) {
  if (audits.length === 0) return <p className="py-12 text-center text-sm text-muted">No audit events.</p>;
  return <ol className="mt-4 grid gap-1">{audits.map((audit) => <li key={audit.id} className="rounded-xl px-3 py-2 transition-colors hover:bg-default"><p className="text-sm font-medium">{audit.action}</p><p className="mt-1 truncate text-xs text-muted">{shortId(audit.resourceId)} · {formatTime(audit.occurredAt)}</p></li>)}</ol>;
}

function Status({ value }: { value: string }) {
  return <span className="bs-status" data-active={["active", "ready", "leased"].includes(value)}>{value}</span>;
}

function CodeValue({ value }: { value: string | null }) {
  if (!value) return <code className="text-xs text-muted">None</code>;
  return (
    <button className="bs-code-value" type="button" title={`Copy ${value}`} onClick={() => void navigator.clipboard.writeText(value)}>
      <code>{shortId(value)}</code>
      <Copy aria-hidden="true" />
      <span className="sr-only">Copy full identifier</span>
    </button>
  );
}

function BrowserSiloMark() {
  return (
    <svg aria-label="BrowserSilo logo" className="size-9" viewBox="0 0 40 40" role="img">
      <rect x="2" y="2" width="36" height="36" rx="11" fill="#b9f36d" />
      <g fill="none" stroke="#0a0b0a" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3">
        <path d="M16 9h-3.5A3.5 3.5 0 0 0 9 12.5V16" />
        <path d="M24 9h3.5a3.5 3.5 0 0 1 3.5 3.5V16" />
        <path d="M16 31h-3.5A3.5 3.5 0 0 1 9 27.5V24" />
        <path d="M24 31h3.5a3.5 3.5 0 0 0 3.5-3.5V24" />
      </g>
      <path
        d="M25 13.5c-1.25-1.15-3-1.75-5.05-1.75-3.1 0-5.2 1.45-5.2 3.65 0 2.05 1.65 3 5.35 4 3.55.95 5.15 1.9 5.15 4.1 0 2.4-2.15 4-5.45 4-2.35 0-4.45-.75-5.85-2.2"
        fill="none"
        stroke="#0a0b0a"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="3.2"
      />
    </svg>
  );
}

function Brand({ expanded = false }: { expanded?: boolean }) {
  const devMode = new URLSearchParams(window.location.search).get("dev") === "true";
  const description = "One continuous S runs through four independent shell segments. The unbroken line is durable encrypted browser identity; the detached corners are disposable isolated execution.";
  return (
    <div className="flex items-center gap-3 px-1">
      <div className="bs-svg-wrap" tabIndex={devMode ? 0 : -1}>
        <BrowserSiloMark />
        {devMode ? <div className="bs-svg-tooltip" role="tooltip"><p className="text-xs text-muted">{description}</p><Button className="mt-2" size="sm" variant="secondary" onPress={() => void navigator.clipboard.writeText(description)}>Copy direction</Button></div> : null}
      </div>
      <div className={expanded ? "block" : "bs-brand-copy"}>
        <strong className="block text-sm">BrowserSilo</strong>
        <p className="text-xs text-muted">Control plane</p>
      </div>
    </div>
  );
}

function useSnapshot() {
  const { token } = useSession();
  return useQuery({
    queryKey: ["admin-snapshot", token],
    queryFn: () => Effect.runPromise(fetchSnapshot(token)),
    refetchInterval: 2_500,
  });
}

function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("BrowserSilo session context is missing.");
  return value;
}

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 16)}…` : value;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "medium" }).format(new Date(value));
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
