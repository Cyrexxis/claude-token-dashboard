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
/** Every token the model read or wrote (thinking is already inside output). */
export const totalTokens = (t: Tokens): number =>
  t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;

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

export const METRICS = ["tokens", "cost", "requests"] as const;
export type Metric = (typeof METRICS)[number];
/** Groups the daily rollups can split by (`/timeseries`). */
export const ROLLUP_GROUPS = ["type", "model", "source", "project"] as const;
export type RollupGroup = (typeof ROLLUP_GROUPS)[number];
/** Request-level series (`/plan/timeseries`) can also split by agent. */
export const GROUPS = [...ROLLUP_GROUPS, "agent"] as const;
export type Group = (typeof GROUPS)[number];
export const GROUP_LABEL: Record<Group, string> = {
  type: "Token type",
  model: "Model",
  source: "Source",
  project: "Project",
  agent: "Agent",
};
export const BUCKETS = ["day", "week", "month"] as const;
export type Bucket = (typeof BUCKETS)[number];

export type SourceKind = "wsl" | "linux" | "windows";

/** Plan kinds with a known window length. Readings may carry other kinds (e.g. `spend_limit`), so wire types keep `kind: string`. */
export const TIMED_PLAN_KINDS = ["five_hour", "seven_day"] as const;
export type TimedPlanKind = (typeof TIMED_PLAN_KINDS)[number];
export const isTimedPlanKind = (k: string): k is TimedPlanKind =>
  (TIMED_PLAN_KINDS as readonly string[]).includes(k);

/** Server-sent events and their payloads. */
export type UsageUpdated = { sessionIds: string[]; from: number; to: number };
export type IngestStatus = { running: boolean; files: number; errors: number };
export type PricesUpdated = { hash: string };
export const LIVE_EVENTS = [
  "usage.updated",
  "prices.updated",
  "ingest.status",
  "plan.snapshot",
] as const;
export type LiveEvent = (typeof LIVE_EVENTS)[number];
export type LiveEventPayloads = {
  "usage.updated": UsageUpdated;
  "prices.updated": PricesUpdated;
  "ingest.status": IngestStatus;
  "plan.snapshot": PlanSnapshotPoint;
};

/** The message of anything thrown; a non-Error is stringified. */
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export type Timeseries = {
  buckets: string[];
  series: { key: string; label: string; values: number[] }[];
};

export type SessionRow = {
  id: string;
  title: string | null;
  project: string | null;
  /** Folder name of the project, with parent folders added only to tell same-named projects apart. */
  projectLabel: string | null;
  cwd: string | null;
  sourceKind: SourceKind | null;
  entrypoint: string | null;
  model: string | null;
  firstTs: number | null;
  lastTs: number | null;
  requests: number;
  tokens: Tokens;
  costUsd: number;
  unpricedRequests: number;
  agents: number;
  /** Estimated plan % of the whole session, per window kind (session list and detail only); null without a rated window. */
  planPercent?: { five_hour: number | null; seven_day: number | null };
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
  /** `name` is the sub-agent's task description (or type) when Claude Code recorded one. */
  agents: {
    agentId: string;
    name: string | null;
    requests: number;
    tokens: Tokens;
    costUsd: number;
  }[];
  costStateUsd: number | null;
};

export type SourceRow = {
  id: number;
  kind: SourceKind;
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
  /** When this value was last confirmed unchanged (readings are stored only on change); >= ts. */
  seenTs: number;
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
  /** Plan % used outside Claude Code on this machine, a lower bound; only when the feature is on.
   *  `estimated` (null when its switch is off) is the extra from intervals with a Claude Code pause. */
  other?: { certain: number; estimated: number | null };
  /** Spans with Claude Code requests: each active local day of a weekly window (clipped to it), or first → last request of a 5-hour one. */
  activity: [number, number][];
};
export type PlanWindows = { current: PlanWindow[]; past: PlanWindow[] };
export type Settings = { otherProducts: boolean; otherEstimate: boolean };
/** `server.json`: how the mod finds the server (SPEC §11.3). */
export type ConnectionFile = {
  url: string;
  protocol: number;
  start?: string[];
  serverLocation?: string;
};
