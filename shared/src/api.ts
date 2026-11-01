import type { PerMtok } from "./prices";

/** HTTP API contract between server and web UI (protocol version 1). */
export const PROTOCOL = 1;

export type Tokens = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  thinking: number;
  webSearch: number;
  webFetch: number;
};

export type Summary = {
  from: string | null;
  to: string | null;
  tokens: Tokens;
  costUsd: number;
  requests: number;
  sessions: number;
  cacheHitRatio: number | null;
  unpricedRequests: number;
  subscriptionMonthlyUsd: number | null;
};

export type Metric = "tokens" | "cost" | "requests";
export type Group = "type" | "model" | "source" | "project";
export type Bucket = "day" | "week" | "month";
export type Timeseries = {
  buckets: string[];
  series: { key: string; label: string; values: number[] }[];
};

export type SessionRow = {
  id: string;
  title: string | null;
  project: string | null;
  cwd: string | null;
  sourceKind: string | null;
  entrypoint: string | null;
  model: string | null;
  firstTs: number | null;
  lastTs: number | null;
  requests: number;
  tokens: Tokens;
  costUsd: number;
  unpricedRequests: number;
  agents: number;
};
export type SessionList = { total: number; items: SessionRow[] };

export type RequestRow = {
  id: number;
  ts: number;
  model: string | null;
  agentId: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  thinking: number;
  webSearch: number;
  speed: string | null;
  costUsd: number | null;
  unpriced: boolean;
};

export type SessionDetail = {
  session: SessionRow & { ccVersion: string | null; tag: string | null; agentName: string | null };
  requests: RequestRow[];
  agents: { agentId: string; requests: number; tokens: Tokens; costUsd: number }[];
  costStateUsd: number | null;
};

export type SourceRow = {
  id: number;
  kind: string;
  host: string | null;
  distro: string | null;
  rootPath: string;
  lastScanAt: number | null;
  enabled: boolean;
  files: number;
  filesWithErrors: number;
  errorCount: number;
  lastError: string | null;
  requests: number;
};

export type PriceRow = {
  id: string;
  modelId: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  origin: "shipped" | "local";
  perMtok: PerMtok;
};
export type Prices = {
  updated: string;
  periods: PriceRow[];
  localText: string | null;
  localError: string | null;
  localPath: string;
};

export type IngestState = {
  running: boolean;
  lastRunAt: number | null;
  lastFiles: number;
  lastErrors: number;
};
export type Status = {
  version: string;
  protocol: number;
  schemaVersion: number;
  startedAt: number;
  dbPath: string;
  ingest: IngestState;
  pricesHash: string | null;
  unpricedModels: string[];
  requests: number;
};

export type ApiError = { error: string; message: string; errors?: string[] };

/** One rate-limit window as the mod reports it (`session.measure`'s `rateLimits`). */
export type PlanWindowReading = { kind: string; percentUsed: number; resetsAt?: string };
export type PlanSnapshotBody = { windows: PlanWindowReading[]; sessionCostUsd?: number };
export type IngestTriggerBody = { sessionId: string };
export type PlanSnapshotPoint = {
  ts: number;
  kind: string;
  percentUsed: number;
  resetsAt: number | null;
};
export type PlanSnapshots = { points: PlanSnapshotPoint[] };
export type PlanWindow = {
  kind: string;
  /** null for kinds without a known length (`spend_limit`). */
  startMs: number | null;
  resetsAt: number;
  current: boolean;
  peakPercent: number;
  /** ts of the stored reading holding the peak (latest such). */
  peakTs: number;
  /** [start, min(resetsAt, now)) */
  tokens: number;
  costUsd: number;
  /** [start, peakTs]: usage after the last reading can't inflate the per-1 % figures. */
  tokensAtPeak: number;
  costAtPeak: number;
  usdPerPercent: number | null;
  tokensPerPercent: number | null;
  lowSignal: boolean;
};
export type PlanWindows = { current: PlanWindow[]; past: PlanWindow[] };
/** `server.json`: how the mod finds the server (SPEC §11.3). */
export type ConnectionFile = {
  url: string;
  protocol: number;
  start?: string[];
  serverLocation?: string;
};
