import type { Database } from "bun:sqlite";
import {
  localDay,
  type PlanSnapshotPoint,
  type PlanSnapshots,
  type PlanWindow,
  type PlanWindows,
  type SessionRow,
} from "@td/shared";
import { BadRequest, dayBoundsMs, type Range, toDate } from "./api/queries";

const ORG = "default"; // single account (user decision); the column keeps room for more
const MINUTE = 60_000;

type Reading = { kind: string; percentUsed: number; resetsAt: number | null };

function parseBody(body: unknown): { windows: Reading[]; sessionCostUsd: number | null } {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new BadRequest("body must be an object");
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.windows) || b.windows.length < 1 || b.windows.length > 10)
    throw new BadRequest("windows must be an array of 1 to 10 items");
  const windows = b.windows.map((w, i): Reading => {
    const x = (w ?? {}) as Record<string, unknown>;
    if (typeof x.kind !== "string" || !/^[a-z_]{1,32}$/.test(x.kind))
      throw new BadRequest(`windows[${i}].kind must match [a-z_]{1,32}`);
    const p = x.percentUsed;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1000)
      throw new BadRequest(`windows[${i}].percentUsed must be a number 0–1000`);
    let resetsAt: number | null = null;
    if (x.resetsAt !== undefined) {
      const ms = typeof x.resetsAt === "string" ? Date.parse(x.resetsAt) : Number.NaN;
      if (Number.isNaN(ms)) throw new BadRequest(`windows[${i}].resetsAt must be an ISO date`);
      // Readings of one window can differ by seconds; rounding keeps it one (kind, resets_at) key.
      resetsAt = Math.round(ms / MINUTE) * MINUTE;
    }
    return { kind: x.kind, percentUsed: p, resetsAt };
  });
  const c = b.sessionCostUsd;
  if (c !== undefined && (typeof c !== "number" || !Number.isFinite(c) || c < 0))
    throw new BadRequest("sessionCostUsd must be a number >= 0");
  return { windows, sessionCostUsd: (c as number | undefined) ?? null };
}

/**
 * Stores readings whose value differs from the latest stored one for the kind (`stored`).
 * An unchanged reading only moves the latest row's seen_ts, so the chart can draw the value up to it
 * (`confirmed`); both need a live event, or an open chart stops at the last change.
 */
export function recordSnapshots(
  db: Database,
  body: unknown,
  now: number,
): { stored: PlanSnapshotPoint[]; confirmed: PlanSnapshotPoint[] } {
  const { windows, sessionCostUsd } = parseBody(body);
  const latest = db.query<
    { id: number; ts: number; percent_used: number; resets_at: number | null },
    [string, string]
  >(
    "SELECT id, ts, percent_used, resets_at FROM plan_snapshots WHERE org_id = ? AND kind = ? ORDER BY ts DESC, id DESC LIMIT 1",
  );
  const seen = db.query<never, [number, number]>(
    "UPDATE plan_snapshots SET seen_ts = ? WHERE id = ?",
  );
  const insert = db.query<never, [number, string, string, number, number | null, number | null]>(
    `INSERT INTO plan_snapshots (ts, org_id, kind, percent_used, resets_at, session_cost_usd, origin)
     VALUES (?, ?, ?, ?, ?, ?, 'mod')`,
  );
  return db.transaction(() => {
    const stored: PlanSnapshotPoint[] = [];
    const confirmed: PlanSnapshotPoint[] = [];
    for (const w of windows) {
      const prev = latest.get(ORG, w.kind);
      if (prev && prev.percent_used === w.percentUsed && prev.resets_at === w.resetsAt) {
        seen.run(now, prev.id);
        confirmed.push({ ts: prev.ts, seenTs: now, ...w });
        continue;
      }
      insert.run(now, ORG, w.kind, w.percentUsed, w.resetsAt, sessionCostUsd);
      stored.push({ ts: now, seenTs: now, ...w });
    }
    return { stored, confirmed };
  })();
}

const HOUR = 3_600_000;
/** Window lengths by kind; `spend_limit` has none, so no start and no per-1 % figures. */
const WINDOW_MS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * 24 * HOUR };
const LOW_SIGNAL_PERCENT = 5;

/** Windows are (kind, resets_at) groups of readings; usage is summed from requests at read time, so repricing needs no rebuild. */
/** [first local midnight, last ms of the last local day] around [start, end): an active day counts in full. */
function wholeDays(start: number, end: number): [number, number] {
  const from = new Date(start);
  from.setHours(0, 0, 0, 0);
  const to = new Date(end - 1);
  to.setHours(24, 0, 0, 0);
  return [from.getTime(), to.getTime() - 1];
}

export function getPlanWindows(db: Database, r: Range, now: number): PlanWindows {
  const { fromMs, toMs } = dayBoundsMs(r);
  // In range, or still running (a current window ignores the range). Keeps "All time" the only unbounded case.
  const groups = db
    .query<
      { kind: string; resets_at: number; peak: number },
      [string, number, number | null, number | null]
    >(
      `SELECT kind, resets_at, MAX(percent_used) peak FROM plan_snapshots
       WHERE org_id = ?1 AND resets_at IS NOT NULL
         AND (resets_at > ?2 OR ((?3 IS NULL OR resets_at >= ?3) AND (?4 IS NULL OR resets_at < ?4)))
       GROUP BY kind, resets_at ORDER BY resets_at DESC`,
    )
    .all(ORG, now, fromMs, toMs);
  const peakTs = db.query<{ ts: number }, [string, string, number, number]>(
    "SELECT MAX(ts) ts FROM plan_snapshots WHERE org_id = ? AND kind = ? AND resets_at = ? AND percent_used = ?",
  );
  const usage = db.query<
    { tokens: number; cost: number; first: number | null; last: number | null },
    [number, number]
  >(
    `SELECT TOTAL(input) + TOTAL(output) + TOTAL(cache_read) + TOTAL(cache_write_5m) + TOTAL(cache_write_1h) tokens,
       TOTAL(cost_usd) cost, MIN(ts) first, MAX(ts) last FROM requests WHERE ts >= ? AND ts <= ?`,
  );
  // Local days with requests: the same days the rollups use.
  const activeDays = db.query<{ day: string }, [number, number]>(
    `SELECT DISTINCT date(ts / 1000, 'unixepoch', 'localtime') day FROM requests
     WHERE ts >= ? AND ts <= ? ORDER BY day`,
  );
  const current: PlanWindow[] = [];
  const past: PlanWindow[] = [];
  const seenKinds = new Set<string>();
  for (const g of groups) {
    const isCurrent = !seenKinds.has(g.kind) && g.resets_at > now;
    seenKinds.add(g.kind);
    if (
      !isCurrent &&
      ((fromMs !== null && g.resets_at < fromMs) || (toMs !== null && g.resets_at >= toMs))
    )
      continue;
    const len = WINDOW_MS[g.kind];
    const startMs = len === undefined ? null : g.resets_at - len;
    const pTs = peakTs.get(ORG, g.kind, g.resets_at, g.peak)?.ts ?? 0;
    const end = Math.min(g.resets_at, now) - 1;
    const all = startMs === null ? null : usage.get(startMs, end);
    const atPeak = startMs === null ? null : usage.get(startMs, pTs);
    const per = (v: number | undefined) =>
      atPeak && g.peak > 0 && v !== undefined ? v / g.peak : null;
    (isCurrent ? current : past).push({
      kind: g.kind,
      startMs,
      resetsAt: g.resets_at,
      current: isCurrent,
      peakPercent: g.peak,
      peakTs: pTs,
      tokens: all?.tokens ?? 0,
      costUsd: all?.cost ?? 0,
      tokensAtPeak: atPeak?.tokens ?? 0,
      costAtPeak: atPeak?.cost ?? 0,
      usdPerPercent: per(atPeak?.cost),
      tokensPerPercent: per(atPeak?.tokens),
      lowSignal: g.peak < LOW_SIGNAL_PERCENT,
      activity:
        startMs === null
          ? []
          : g.kind === "seven_day"
            ? activeDays.all(...wholeDays(startMs, g.resets_at)).map(({ day }) => {
                const d = toDate(day);
                const from = d.getTime();
                d.setDate(d.getDate() + 1);
                return [Math.max(from, startMs), Math.min(d.getTime(), g.resets_at)];
              })
            : all?.first != null && all.last != null
              ? [[all.first, all.last]]
              : [],
    });
  }
  return { current, past };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/** Plan % of `total` USD: each window's part at that window's $ per 1 %; parts without a rate (and
 *  cost outside every window) at the median rate of the rated parts; null when no part is rated. */
export function estimatePercent(total: number, parts: { cost: number; rate: number | null }[]) {
  const rates = parts.flatMap((p) => (p.rate ? [p.rate] : []));
  if (!rates.length) return null;
  const fallback = median(rates);
  const covered = parts.reduce((n, p) => n + p.cost, 0);
  const inWindows = parts.reduce((n, p) => n + p.cost / (p.rate || fallback), 0);
  return inWindows + Math.max(0, total - covered) / fallback;
}

/** Adds `planPercent` (5-hour and weekly) for each whole session. */
export function withPlanPercent(db: Database, rows: SessionRow[], now: number): SessionRow[] {
  const ts = rows.flatMap((r) =>
    r.firstTs === null || r.lastTs === null ? [] : [r.firstTs, r.lastTs],
  );
  if (!ts.length)
    return rows.map((r) => ({ ...r, planPercent: { five_hour: null, seven_day: null } }));
  // Every window that can hold one of these requests resets within 7 days after it.
  const range = {
    from: localDay(new Date(Math.min(...ts))),
    to: localDay(new Date(Math.max(...ts) + 7 * 24 * HOUR)),
  };
  const { current, past } = getPlanWindows(db, range, now);
  const windows = [...current, ...past].filter(
    (w) => w.startMs !== null && (w.kind === "five_hour" || w.kind === "seven_day"),
  );
  const costs = db
    .query<{ sid: string; i: number; cost: number }, [string, string]>(
      `SELECT r.session_id sid, CAST(w.key AS INTEGER) i, TOTAL(r.cost_usd) cost
       FROM requests r JOIN json_each(?2) w
         ON r.ts >= json_extract(w.value, '$[0]') AND r.ts < json_extract(w.value, '$[1]')
       WHERE r.session_id IN (SELECT value FROM json_each(?1)) GROUP BY sid, i`,
    )
    .all(
      JSON.stringify(rows.map((r) => r.id)),
      JSON.stringify(windows.map((w) => [w.startMs, w.resetsAt])),
    );
  const parts = new Map<string, { kind: string; cost: number; rate: number | null }[]>();
  for (const c of costs) {
    const w = windows[c.i] as PlanWindow;
    const list = parts.get(c.sid) ?? [];
    list.push({ kind: w.kind, cost: c.cost, rate: w.usdPerPercent || null });
    parts.set(c.sid, list);
  }
  return rows.map((r) => {
    const of = (kind: string) =>
      estimatePercent(
        r.costUsd,
        (parts.get(r.id) ?? []).filter((p) => p.kind === kind),
      );
    return { ...r, planPercent: { five_hour: of("five_hour"), seven_day: of("seven_day") } };
  });
}

export function getPlanSnapshots(db: Database, r: Range): PlanSnapshots {
  const { fromMs, toMs } = dayBoundsMs(r);
  const points = db
    .query<PlanSnapshotPoint, [string, number | null, number | null]>(
      // A row from before the range still counts when it was confirmed inside it.
      `SELECT ts, COALESCE(seen_ts, ts) seenTs, kind, percent_used percentUsed, resets_at resetsAt
       FROM plan_snapshots
       WHERE org_id = ?1 AND (?2 IS NULL OR COALESCE(seen_ts, ts) >= ?2) AND (?3 IS NULL OR ts < ?3)
       ORDER BY ts, id`,
    )
    .all(ORG, fromMs, toMs);
  return { points };
}
