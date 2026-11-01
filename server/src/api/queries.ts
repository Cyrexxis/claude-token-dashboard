import type { Database } from "bun:sqlite";
import {
  type Bucket,
  type Group,
  type IngestState,
  type Metric,
  PROTOCOL,
  type PriceRow,
  type Prices,
  type RequestRow,
  type SessionDetail,
  type SessionList,
  type SessionRow,
  type SourceRow,
  type Status,
  type Summary,
  type Timeseries,
  type Tokens,
} from "@td/shared";
import shippedPrices from "../../../prices/prices.json";
import { SCHEMA_VERSION } from "../db/database";
import { SERVER_VERSION } from "../version";

/** Server-local days `YYYY-MM-DD`, inclusive; null = unbounded. */
export type Range = { from: string | null; to: string | null };

export class BadRequest extends Error {}

const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toDate = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
};

const MIN_DAY = "1970-01-01";
const MAX_DAY = "2100-12-31";

function parseDay(name: string, v: string | undefined): string | null {
  if (v === undefined || v === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || localDay(toDate(v)) !== v)
    throw new BadRequest(`${name} must be a date YYYY-MM-DD`);
  // Bounds the bucket list: an unbounded range lets one GET build millions of buckets.
  if (v < MIN_DAY || v > MAX_DAY) throw new BadRequest(`${name} must be between 1970 and 2100`);
  return v;
}

export function parseRange(q: { from?: string; to?: string }): Range {
  const r = { from: parseDay("from", q.from), to: parseDay("to", q.to) };
  if (r.from && r.to && r.from > r.to) throw new BadRequest("from is after to");
  return r;
}

/** Local midnight of `from`; local midnight after `to` (exclusive). */
export function dayBoundsMs(r: Range): { fromMs: number | null; toMs: number | null } {
  const next = (day: string) => {
    const d = toDate(day);
    d.setDate(d.getDate() + 1);
    return d.getTime();
  };
  return { fromMs: r.from ? toDate(r.from).getTime() : null, toMs: r.to ? next(r.to) : null };
}

const DAY_WHERE = "($from IS NULL OR day >= $from) AND ($to IS NULL OR day <= $to)";
const TS_WHERE = "($fromMs IS NULL OR ts >= $fromMs) AND ($toMs IS NULL OR ts < $toMs)";
const TOKEN_COLS = `TOTAL(input) input, TOTAL(output) output, TOTAL(cache_read) cacheRead,
  TOTAL(cache_write_5m) cacheWrite5m, TOTAL(cache_write_1h) cacheWrite1h, TOTAL(thinking) thinking,
  TOTAL(web_search) webSearch, TOTAL(web_fetch) webFetch`;

export function getSummary(db: Database, r: Range, subscriptionMonthlyUsd: number | null): Summary {
  const roll = db
    .query<Tokens & { costUsd: number; requests: number }, [Range]>(
      `SELECT ${TOKEN_COLS}, TOTAL(cost_usd) costUsd, TOTAL(request_count) requests
       FROM daily_rollups WHERE ${DAY_WHERE}`,
    )
    .get(r) as Tokens & { costUsd: number; requests: number };
  const req = db
    .query<{ sessions: number; unpriced: number }, [ReturnType<typeof dayBoundsMs>]>(
      `SELECT COUNT(DISTINCT session_id) sessions, TOTAL(unpriced) unpriced FROM requests WHERE ${TS_WHERE}`,
    )
    .get(dayBoundsMs(r)) as { sessions: number; unpriced: number };
  const { costUsd, requests, ...tokens } = roll;
  const cacheBase = tokens.input + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h;
  return {
    from: r.from,
    to: r.to,
    tokens,
    costUsd,
    requests,
    sessions: req.sessions,
    cacheHitRatio: cacheBase ? tokens.cacheRead / cacheBase : null,
    unpricedRequests: req.unpriced,
    subscriptionMonthlyUsd,
  };
}

const VALUE: Record<Metric, string> = {
  tokens: "input + output + cache_read + cache_write_5m + cache_write_1h", // thinking is inside output
  cost: "cost_usd",
  requests: "request_count",
};
// [key, label, token column, cost column]; web search has a cost but no tokens.
const TYPE_SERIES = [
  ["input", "Input", "input", "cost_input"],
  ["output", "Output", "output", "cost_output"],
  ["cacheRead", "Cache read", "cache_read", "cost_cache_read"],
  ["cacheWrite5m", "Cache write 5m", "cache_write_5m", "cost_cache_write_5m"],
  ["cacheWrite1h", "Cache write 1h", "cache_write_1h", "cost_cache_write_1h"],
  ["webSearch", "Web search", null, "cost_web_search"],
] as const;
const GROUP_KEY: Record<Exclude<Group, "type">, string> = {
  model: "COALESCE(model, 'unknown')",
  source: "COALESCE(CAST(source_id AS TEXT), '')",
  project: "project",
};
const TOP = 8;

function bucketOf(day: string, bucket: Bucket): string {
  if (bucket === "day") return day;
  if (bucket === "month") return `${day.slice(0, 7)}-01`;
  const d = toDate(day);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
  return localDay(d);
}

function bucketList(from: string, to: string, bucket: Bucket): string[] {
  const out: string[] = [];
  for (const d = toDate(from); localDay(d) <= to; d.setDate(d.getDate() + 1)) {
    const b = bucketOf(localDay(d), bucket);
    if (out.at(-1) !== b) out.push(b);
  }
  return out;
}

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;

function labels(db: Database, group: Exclude<Group, "type">, keys: string[]): Map<string, string> {
  const m = new Map(keys.map((k) => [k, k]));
  if (group === "source") {
    const rows = db
      .query<{ id: string; kind: string; host: string | null }, []>(
        "SELECT CAST(id AS TEXT) id, kind, host FROM sources",
      )
      .all();
    for (const s of rows) if (m.has(s.id)) m.set(s.id, `${s.kind} · ${s.host ?? "?"}`);
    if (m.has("")) m.set("", "unknown");
  }
  if (group === "project") {
    const rows = db
      .query<{ project: string; cwd: string }, []>(
        "SELECT project, cwd FROM sessions WHERE project IS NOT NULL AND cwd IS NOT NULL ORDER BY last_ts",
      )
      .all();
    for (const s of rows) if (m.has(s.project)) m.set(s.project, basename(s.cwd)); // latest wins
    if (m.has("")) m.set("", "(none)");
  }
  return m;
}

/** Where series rows come from: `table` is a FROM clause (with its WHERE), `key` the bucket expression. */
type SeriesSource = {
  table: string;
  key: string;
  params: Record<string, string | number | null>;
  at: (key: string | number) => number | undefined;
};

function buildSeries(
  db: Database,
  metric: Metric,
  group: Group,
  buckets: string[],
  src: SeriesSource,
): Timeseries["series"] {
  if (group === "type" && metric === "requests")
    throw new BadRequest("group=type is only available for metric=tokens or cost");
  if (group === "type") {
    const types = TYPE_SERIES.flatMap(([key, label, tokenCol, costCol]) => {
      const col = metric === "cost" ? costCol : tokenCol;
      return col ? [{ key, label, col }] : [];
    });
    const rows = db
      .query<Record<string, number> & { b: string | number }, [SeriesSource["params"]]>(
        `SELECT ${src.key} b, ${types.map((t) => `TOTAL(${t.col}) ${t.key}`).join(", ")}
         FROM ${src.table} GROUP BY b`,
      )
      .all(src.params);
    const series = types.map(({ key, label }) => ({
      key,
      label,
      values: buckets.map(() => 0),
    }));
    for (const row of rows) {
      const i = src.at(row.b);
      if (i !== undefined) for (const s of series) s.values[i] += row[s.key];
    }
    // Web search only shows up when something was searched.
    return series.filter((s) => s.key !== "webSearch" || s.values.some(Boolean));
  }

  const rows = db
    .query<{ b: string | number; k: string; v: number }, [SeriesSource["params"]]>(
      `SELECT ${src.key} b, ${GROUP_KEY[group]} k, TOTAL(${VALUE[metric]}) v
       FROM ${src.table} GROUP BY b, k`,
    )
    .all(src.params);
  const byKey = new Map<string, number[]>();
  for (const row of rows) {
    const i = src.at(row.b);
    if (i === undefined) continue;
    const values = byKey.get(row.k) ?? buckets.map(() => 0);
    byKey.set(row.k, values);
    values[i] += row.v;
  }
  const total = (v: number[]) => v.reduce((a, b) => a + b, 0);
  const ranked = [...byKey].sort((a, b) => total(b[1]) - total(a[1]) || a[0].localeCompare(b[0]));
  const names = labels(
    db,
    group,
    ranked.map(([k]) => k),
  );
  const series = ranked
    .slice(0, TOP)
    .map(([key, values]) => ({ key, label: names.get(key) ?? key, values }));
  const rest = ranked.slice(TOP);
  if (rest.length)
    series.push({
      key: "other",
      label: "Other",
      values: buckets.map((_, i) => rest.reduce((a, [, v]) => a + v[i], 0)),
    });
  return series;
}

export function getTimeseries(
  db: Database,
  q: { metric: Metric; group: Group; bucket: Bucket } & Range,
): Timeseries {
  const earliest = db
    .query<{ day: string | null }, []>("SELECT MIN(day) day FROM daily_rollups")
    .get()?.day;
  const to = q.to ?? localDay(new Date());
  const start = earliest && earliest < MIN_DAY ? MIN_DAY : earliest; // bogus old timestamps
  const from = q.from ?? start ?? to;
  const buckets = from <= to ? bucketList(from, to, q.bucket) : [];
  const index = new Map(buckets.map((b, i) => [b, i]));
  const series = buildSeries(db, q.metric, q.group, buckets, {
    table: `daily_rollups WHERE ${DAY_WHERE}`,
    key: "day",
    params: { from: q.from, to: q.to },
    at: (day) => index.get(bucketOf(String(day), q.bucket)),
  });
  return { buckets, series };
}

const MAX_WINDOW_BUCKETS = 1000;

/**
 * Raw requests in [fromMs, toMs) in `stepMs` slots; buckets are slot starts as epoch-ms strings.
 * Reads `requests` (rollups are daily), shaped like daily_rollups so the same columns work.
 */
export function getWindowTimeseries(
  db: Database,
  q: { metric: Metric; group: Group; fromMs: number; toMs: number; stepMs: number },
): Timeseries {
  const { fromMs, toMs, stepMs } = q;
  if (![fromMs, toMs, stepMs].every(Number.isSafeInteger) || fromMs >= toMs || stepMs <= 0)
    throw new BadRequest("fromMs, toMs, stepMs must be integers with fromMs < toMs, stepMs > 0");
  const n = Math.ceil((toMs - fromMs) / stepMs);
  if (n > MAX_WINDOW_BUCKETS) throw new BadRequest(`at most ${MAX_WINDOW_BUCKETS} buckets`);
  const buckets = Array.from({ length: n }, (_, i) => String(fromMs + i * stepMs));
  const series = buildSeries(db, q.metric, q.group, buckets, {
    table: `(SELECT r.*, COALESCE(s.project, '') project, 1 request_count
      FROM requests r LEFT JOIN sessions s ON s.id = r.session_id
      WHERE r.ts >= $fromMs AND r.ts < $toMs)`,
    key: "(ts - $fromMs) / $stepMs", // integer division
    params: { fromMs, toMs, stepMs },
    at: (i) => Number(i),
  });
  return { buckets, series };
}

type SessionRecord = {
  id: string;
  title: string | null;
  project: string | null;
  cwd: string | null;
  sourceKind: string | null;
  entrypoint: string | null;
  firstTs: number | null;
  lastTs: number | null;
  ccVersion: string | null;
  tag: string | null;
  agentName: string | null;
};
const SESSION_SELECT = `SELECT s.id, COALESCE(s.title, s.ai_title) title, s.project, s.cwd, so.kind sourceKind,
  s.entrypoint, s.first_ts firstTs, s.last_ts lastTs, s.cc_version ccVersion, s.tag, s.agent_name agentName
  FROM sessions s LEFT JOIN sources so ON so.id = s.source_id`;
const SESSION_WHERE = `($fromMs IS NULL OR s.last_ts >= $fromMs) AND ($toMs IS NULL OR s.first_ts < $toMs)
  AND ($q IS NULL OR instr(lower(COALESCE(s.title, '')), $q) > 0 OR instr(lower(COALESCE(s.ai_title, '')), $q) > 0
    OR instr(lower(COALESCE(s.project, '')), $q) > 0 OR instr(lower(s.id), $q) > 0)`;

type Agg = Tokens & {
  sessionId: string;
  requests: number;
  costUsd: number;
  unpriced: number;
  agents: number;
};

/** Adds request totals and the main model to session records; aggregates only the given sessions (and only requests in `win`, if given). */
function withTotals(
  db: Database,
  records: SessionRecord[],
  win?: { fromMs: number; toMs: number },
): SessionRow[] {
  if (!records.length) return [];
  const ids = records.map((r) => r.id);
  const where = `session_id IN (${ids.map(() => "?").join(", ")})${win ? " AND ts >= ? AND ts < ?" : ""}`;
  const args = win ? [...ids, win.fromMs, win.toMs] : ids;
  const aggs = db
    .query<Agg, (string | number)[]>(
      `SELECT session_id sessionId, COUNT(*) requests, ${TOKEN_COLS}, TOTAL(cost_usd) costUsd,
         TOTAL(unpriced) unpriced, COUNT(DISTINCT agent_id) agents
       FROM requests WHERE ${where} GROUP BY session_id`,
    )
    .all(...args);
  const models = db
    .query<{ sessionId: string; model: string | null }, (string | number)[]>(
      `SELECT session_id sessionId, model FROM requests WHERE ${where}
       GROUP BY session_id, model ORDER BY TOTAL(output)`,
    )
    .all(...args);
  const byId = new Map(aggs.map((a) => [a.sessionId, a]));
  const model = new Map(models.map((m) => [m.sessionId, m.model])); // most output wins (last)
  return records.map(({ ccVersion, tag, agentName, ...r }) => {
    const a = byId.get(r.id);
    return {
      ...r,
      model: model.get(r.id) ?? null,
      requests: a?.requests ?? 0,
      tokens: {
        input: a?.input ?? 0,
        output: a?.output ?? 0,
        cacheRead: a?.cacheRead ?? 0,
        cacheWrite5m: a?.cacheWrite5m ?? 0,
        cacheWrite1h: a?.cacheWrite1h ?? 0,
        thinking: a?.thinking ?? 0,
        webSearch: a?.webSearch ?? 0,
        webFetch: a?.webFetch ?? 0,
      },
      costUsd: a?.costUsd ?? 0,
      unpricedRequests: a?.unpriced ?? 0,
      agents: a?.agents ?? 0,
    };
  });
}

export function listSessions(
  db: Database,
  q: Range & { q?: string; limit?: number; offset?: number },
): SessionList {
  const limit = q.limit ?? 50;
  const offset = q.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new BadRequest("limit must be 1-200");
  if (!Number.isInteger(offset) || offset < 0) throw new BadRequest("offset must be >= 0");
  const params = { ...dayBoundsMs(q), q: q.q ? q.q.toLowerCase() : null };
  const total =
    db
      .query<{ n: number }, [typeof params]>(
        `SELECT COUNT(*) n FROM sessions s WHERE ${SESSION_WHERE}`,
      )
      .get(params)?.n ?? 0;
  const records = db
    .query<SessionRecord, [typeof params & { limit: number; offset: number }]>(
      `${SESSION_SELECT} WHERE ${SESSION_WHERE} ORDER BY s.last_ts DESC, s.id LIMIT $limit OFFSET $offset`,
    )
    .all({ ...params, limit, offset });
  return { total, items: withTotals(db, records) };
}

/** Sessions with requests in [fromMs, toMs), most expensive first; totals count only those requests. */
export function listWindowSessions(db: Database, fromMs: number, toMs: number): SessionList {
  if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || fromMs >= toMs)
    throw new BadRequest("fromMs and toMs must be integers with fromMs < toMs");
  const records = db
    .query<SessionRecord, [number, number]>(
      `${SESSION_SELECT} WHERE s.id IN (SELECT session_id FROM requests WHERE ts >= ?1 AND ts < ?2)`,
    )
    .all(fromMs, toMs);
  const items = withTotals(db, records, { fromMs, toMs }).sort((a, b) => b.costUsd - a.costUsd);
  return { total: items.length, items };
}

const TOKENS_OF = (r: Tokens): Tokens => ({
  input: r.input,
  output: r.output,
  cacheRead: r.cacheRead,
  cacheWrite5m: r.cacheWrite5m,
  cacheWrite1h: r.cacheWrite1h,
  thinking: r.thinking,
  webSearch: r.webSearch,
  webFetch: r.webFetch,
});

export function getSession(db: Database, id: string): SessionDetail | null {
  const record = db.query<SessionRecord, [string]>(`${SESSION_SELECT} WHERE s.id = ?`).get(id);
  if (!record) return null;
  const [row] = withTotals(db, [record]);
  const requests = db
    .query<Omit<RequestRow, "unpriced"> & { unpriced: number }, [string]>(
      `SELECT id, ts, model, agent_id agentId, input, output, cache_read cacheRead, cache_write_5m cacheWrite5m,
         cache_write_1h cacheWrite1h, thinking, web_search webSearch, speed, cost_usd costUsd, unpriced
       FROM requests WHERE session_id = ? ORDER BY ts, id`,
    )
    .all(id)
    .map((r) => ({ ...r, unpriced: r.unpriced === 1 }));
  const agents = db
    .query<Agg & { agentId: string }, [string]>(
      `SELECT agent_id agentId, COUNT(*) requests, ${TOKEN_COLS}, TOTAL(cost_usd) costUsd
       FROM requests WHERE session_id = ? AND agent_id IS NOT NULL GROUP BY agent_id ORDER BY agent_id`,
    )
    .all(id)
    .map((a) => ({
      agentId: a.agentId,
      requests: a.requests,
      tokens: TOKENS_OF(a),
      costUsd: a.costUsd,
    }));
  const costStateUsd =
    db
      .query<{ v: number | null }, [string]>(
        "SELECT SUM(cost_usd) v FROM cost_states WHERE session_id = ?",
      )
      .get(id)?.v ?? null;
  return {
    session: {
      ...row,
      ccVersion: record.ccVersion,
      tag: record.tag,
      agentName: record.agentName,
    },
    requests,
    agents,
    costStateUsd,
  };
}

export function listSources(db: Database): SourceRow[] {
  return db
    .query<Omit<SourceRow, "enabled"> & { enabled: number }, []>(
      `SELECT so.id, so.kind, so.host, so.distro, so.root_path rootPath, so.last_scan_at lastScanAt, so.enabled,
         (SELECT COUNT(*) FROM files f WHERE f.source_id = so.id) files,
         (SELECT COUNT(*) FROM files f WHERE f.source_id = so.id AND f.error_count > 0) filesWithErrors,
         (SELECT TOTAL(f.error_count) FROM files f WHERE f.source_id = so.id) errorCount,
         (SELECT f.last_error FROM files f WHERE f.source_id = so.id AND f.error_count > 0
           ORDER BY f.last_ingest_at DESC LIMIT 1) lastError,
         (SELECT COUNT(*) FROM requests r WHERE r.source_id = so.id) requests
       FROM sources so ORDER BY so.id`,
    )
    .all()
    .map((s) => ({ ...s, enabled: s.enabled === 1 }));
}

const utcDay = (ms: number | null) =>
  ms === null ? null : new Date(ms).toISOString().slice(0, 10);

export async function getPrices(
  db: Database,
  localPath: string,
  localError: string | null,
): Promise<Prices> {
  const periods = db
    .query<
      {
        id: string;
        modelId: string;
        from: number | null;
        to: number | null;
        origin: PriceRow["origin"];
        values: string;
      },
      []
    >(
      `SELECT id, model_id modelId, effective_from "from", effective_to "to", origin, values_json "values"
       FROM price_periods ORDER BY model_id, effective_from`,
    )
    .all()
    .map((p) => ({
      id: p.id,
      modelId: p.modelId,
      effectiveFrom: utcDay(p.from),
      effectiveTo: utcDay(p.to),
      origin: p.origin,
      perMtok: JSON.parse(p.values).per_mtok,
    }));
  const file = Bun.file(localPath);
  return {
    updated: shippedPrices.updated,
    periods,
    localText: (await file.exists()) ? await file.text() : null,
    localError,
    localPath,
  };
}

export function getStatus(
  db: Database,
  x: { startedAt: number; dbPath: string; ingest: IngestState },
): Status {
  const value = (key: string) =>
    db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)
      ?.value ?? null;
  return {
    version: SERVER_VERSION,
    protocol: PROTOCOL,
    schemaVersion: SCHEMA_VERSION,
    startedAt: x.startedAt,
    dbPath: x.dbPath,
    ingest: x.ingest,
    pricesHash: value("prices_hash"),
    unpricedModels: db
      .query<{ model: string }, []>(
        "SELECT DISTINCT COALESCE(model, 'unknown') model FROM requests WHERE unpriced = 1 ORDER BY 1",
      )
      .all()
      .map((r) => r.model),
    requests: db.query<{ n: number }, []>("SELECT COUNT(*) n FROM requests").get()?.n ?? 0,
  };
}
