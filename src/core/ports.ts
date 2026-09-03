import type {
  LeaseEgressPolicy,
  RuntimeState,
  WorkerRuntimeCapabilities,
} from "./model.js";

export interface RuntimeRepository {
  transaction<T>(
    operation: (state: RuntimeState) => T | Promise<T>,
  ): Promise<T>;
  snapshot(): Promise<RuntimeState>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(prefix: "profile" | "lease" | "worker" | "audit"): string;
}

export interface WorkerDescriptor {
  runtimeRef: string;
  adapter: string;
  braveVersion: string | null;
  cdpVersion: string | null;
}

export interface WorkerRuntimePort {
  capabilities(): WorkerRuntimeCapabilities;
  createWarmShell(workerId: string): Promise<WorkerDescriptor>;
  activate(
    workerId: string,
    leaseId: string,
    profileId: string,
    egressPolicy: LeaseEgressPolicy,
  ): Promise<Partial<WorkerDescriptor> | void>;
  destroy(workerId: string): Promise<void>;
}

export interface BrowserTab {
  id: string;
  type: string;
  title: string;
  url: string;
}

export interface BrowserSnapshotNode {
  role: string;
  name: string;
  value: string | null;
  description: string | null;
  focused: boolean;
  disabled: boolean;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  nodes: BrowserSnapshotNode[];
  elements: BrowserSnapshotElement[];
}

export interface BrowserSnapshotElement {
  tag: string;
  selector: string | null;
  role: string | null;
  name: string | null;
  type: string | null;
  text: string;
  placeholder: string | null;
}

export interface BrowserScreenshot {
  mimeType: "image/png";
  data: string;
}

export interface BrowserToolResult {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface BrowserAutomationPort {
  navigate(workerId: string, url: string): Promise<{ url: string; title: string }>;
  snapshot(workerId: string): Promise<BrowserSnapshot>;
  screenshot(workerId: string, options?: { fullPage?: boolean }): Promise<BrowserScreenshot>;
  click(workerId: string, selector: string): Promise<void>;
  type(workerId: string, selector: string, text: string): Promise<void>;
  evaluate(workerId: string, expression: string): Promise<unknown>;
  tabs(workerId: string): Promise<BrowserTab[]>;
  agentTool(
    workerId: string,
    toolName: string,
    arguments_: Record<string, unknown>,
  ): Promise<BrowserToolResult>;
  stageFile(workerId: string, sourcePath: string, fileName: string): Promise<string>;
  prepareFile(workerId: string, fileName: string): Promise<string>;
  collectFile(workerId: string, containerPath: string, destination: string): Promise<void>;
  removeFile(workerId: string, containerPath: string): Promise<void>;
}
