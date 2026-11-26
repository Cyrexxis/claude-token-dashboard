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
import { getSettings } from "./settings";

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

/** Windows are built from readings (`splitWindows`); usage is summed from requests at read time, so repricing needs no rebuild. */
/** [first local midnight, last ms of the last local day] around [start, end): an active day counts in full. */
function wholeDays(start: number, end: number): [number, number] {
  const from = new Date(start);
  from.setHours(0, 0, 0, 0);
  const to = new Date(end - 1);
  to.setHours(24, 0, 0, 0);
  return [from.getTime(), to.getTime() - 1];
}

const OTHER_MARGIN_MS = 10 * MINUTE; // the plan % can lag a request by a few minutes
const OTHER_PAUSE_MS = 15 * MINUTE;
const OTHER_MIN_ESTIMATE = 2; // whole-percent readings and rate noise hide anything smaller

type Point = { ts: number; seen: number; percent: number };

/** Plan % that rose while Claude Code (as seen in the transcripts) was not working; a lower bound.
 *  certain: increases with no request from `margin` before the earlier reading up to the later one.
 *  estimated (when `rate` is given): increases in intervals holding a pause of at least 15 minutes,
 *  minus the interval's Claude Code cost at `rate` USD per 1 %, when at least 2 % is left. */
export function otherUse(
  points: Point[],
  requests: { ts: number; cost: number }[],
  startMs: number,
  rate: number | null,
): { certain: number; estimated: number | null } {
  let certain = 0;
  let estimated = 0;
  let prev = { seen: startMs, percent: 0 };
  for (const p of points) {
    const rise = p.percent - prev.percent;
    if (rise > 0) {
      const near = requests.filter((q) => q.ts >= prev.seen - OTHER_MARGIN_MS && q.ts <= p.ts);
      if (!near.length) certain += rise;
      else if (rate) {
        const inside = near.filter((q) => q.ts > prev.seen);
        const marks = [prev.seen, ...inside.map((q) => q.ts), p.ts];
        const pause = Math.max(...marks.slice(1).map((t, i) => t - (marks[i] as number)));
        const left = rise - inside.reduce((n, q) => n + q.cost, 0) / rate;
        if (pause >= OTHER_PAUSE_MS && left >= OTHER_MIN_ESTIMATE) estimated += left;
      }
    }
    prev = p;
  }
  return { certain, estimated: rate === null ? null : estimated };
}

type Snap = Point & { resetsAt: number | null };
type Span = { resetsAt: number; startMs: number | null; endMs: number; points: Snap[] };

/**
 * One kind's readings (in ts order) without the ones that aren't the plan's real state:
 * - a glitch: readings with another reset time between two readings of one window (Anthropic, seen
 *   right after a plan upgrade);
 * - a stale reading: a fall the next reading undoes (a concurrent session reporting old data).
 * shortcut: two stale readings in a row stay; look ahead further if that shows up.
 */
export function dropNoise<T extends Pick<Snap, "percent" | "resetsAt">>(snaps: T[]): T[] {
  const blocks: { resetsAt: number | null; points: T[] }[] = [];
  for (const s of snaps) {
    const b = blocks.at(-1);
    if (b && (s.resetsAt === null || b.resetsAt === null || s.resetsAt === b.resetsAt)) {
      b.points.push(s);
      b.resetsAt ??= s.resetsAt;
      continue;
    }
    const before = blocks.at(-2);
    if (before && s.resetsAt === before.resetsAt) {
      blocks.pop(); // the glitch
      before.points.push(s);
    } else blocks.push({ resetsAt: s.resetsAt, points: [s] });
  }
  return blocks.flatMap(({ points }) =>
    points.filter((p, i) => {
      const prev = points[i - 1];
      const next = points[i + 1];
      return !(prev && next && p.percent < prev.percent && next.percent >= prev.percent);
    }),
  );
}

/**
 * One kind's readings (in ts order, noise dropped) as windows that never overlap.
 * - A new reset time starts a new window.
 * - A fall to `resetPercent` or below is a limit reset and starts a new window; a smaller fall is a
 *   rescale (a plan change) and stays in the window.
 * - Readings without a reset time join the window around them; a run of only those is no window.
 * A window ends where the next one starts, at most at its reset time.
 */
export function splitWindows(snaps: Snap[], len: number | undefined, resetPercent: number): Span[] {
  const runs: { resetsAt: number | null; points: Snap[] }[] = [];
  for (const s of snaps) {
    const run = runs.at(-1);
    const last = run?.points.at(-1);
    const moved = s.resetsAt !== null && run?.resetsAt != null && s.resetsAt !== run.resetsAt;
    // A reset run takes its reset time from its own readings: none yet means no window yet.
    if (!run || !last || moved || (s.percent <= resetPercent && s.percent < last.percent))
      runs.push({ resetsAt: s.resetsAt, points: [s] });
    else {
      run.points.push(s);
      run.resetsAt ??= s.resetsAt;
    }
  }
  // Where each run starts: its reset time minus the length, but not before the previous run was last
  // seen nor after its own first reading (reset times are rounded to the minute).
  const starts = runs.map((run, i) => {
    const first = (run.points[0] as Snap).ts;
    const natural = run.resetsAt !== null && len !== undefined ? run.resetsAt - len : first;
    const prev = runs[i - 1]?.points.at(-1);
    return Math.min(prev ? Math.max(natural, prev.seen + 1) : natural, first);
  });
  return runs.flatMap((run, i) =>
    run.resetsAt === null
      ? []
      : [
          {
            resetsAt: run.resetsAt,
            startMs: len === undefined ? null : (starts[i] as number),
            endMs: Math.min(run.resetsAt, starts[i + 1] ?? Infinity),
            points: run.points,
          },
        ],
  );
}

export function getPlanWindows(
  db: Database,
  r: Range,
  now: number,
  /** Adds `other` to each window; `estimate` adds its estimated part. */
  other?: { estimate: boolean },
): PlanWindows {
  const { fromMs, toMs } = dayBoundsMs(r);
  const { resetPercent } = getSettings(db);
  // A window in range started at most a week before it, and so did a window it cut short.
  const snaps = db
    .query<Snap & { kind: string }, [string, number | null]>(
      `SELECT kind, ts, COALESCE(seen_ts, ts) seen, percent_used percent, resets_at resetsAt
       FROM plan_snapshots WHERE org_id = ?1 AND (?2 IS NULL OR COALESCE(seen_ts, ts) >= ?2)
       ORDER BY kind, ts, id`,
    )
    .all(ORG, fromMs === null ? null : fromMs - 8 * 24 * HOUR);
  // In range, or still running (a current window ignores the range). Keeps "All time" the only unbounded case.
  const spans = [...Map.groupBy(snaps, (s) => s.kind)]
    .flatMap(([kind, list]) =>
      splitWindows(dropNoise(list), WINDOW_MS[kind], resetPercent).map((s) => ({
        ...s,
        kind,
        current: s.endMs > now,
      })),
    )
    .filter(
      (s) =>
        s.current || ((fromMs === null || s.endMs >= fromMs) && (toMs === null || s.endMs < toMs)),
    )
    .sort((a, b) => b.endMs - a.endMs);
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
  const reqs = db.query<{ ts: number; cost: number }, [number, number]>(
    "SELECT ts, COALESCE(cost_usd, 0) cost FROM requests WHERE ts >= ? AND ts <= ? ORDER BY ts",
  );
  const current: PlanWindow[] = [];
  const past: PlanWindow[] = [];
  for (const g of spans) {
    const isCurrent = g.current;
    const { startMs } = g;
    const peak = Math.max(...g.points.map((p) => p.percent));
    const pTs = g.points.findLast((p) => p.percent === peak)?.ts ?? 0;
    const end = Math.min(g.endMs, now) - 1;
    const all = startMs === null ? null : usage.get(startMs, end);
    const atPeak = startMs === null ? null : usage.get(startMs, pTs);
    const per = (v: number | undefined) =>
      atPeak && peak > 0 && v !== undefined ? v / peak : null;
    (isCurrent ? current : past).push({
      kind: g.kind,
      startMs,
      resetsAt: g.endMs,
      current: isCurrent,
      peakPercent: peak,
      percent: (g.points.at(-1) as Snap).percent,
      peakTs: pTs,
      tokens: all?.tokens ?? 0,
      costUsd: all?.cost ?? 0,
      tokensAtPeak: atPeak?.tokens ?? 0,
      costAtPeak: atPeak?.cost ?? 0,
      usdPerPercent: per(atPeak?.cost),
      tokensPerPercent: per(atPeak?.tokens),
      lowSignal: peak < LOW_SIGNAL_PERCENT,
      ...(other && startMs !== null
        ? {
            other: otherUse(
              g.points,
              reqs.all(startMs - OTHER_MARGIN_MS, Math.min(g.endMs, now)),
              startMs,
              other.estimate ? per(atPeak?.cost) : null,
            ),
          }
        : {}),
      activity:
        startMs === null
          ? []
          : g.kind === "seven_day"
            ? activeDays.all(...wholeDays(startMs, g.endMs)).map(({ day }) => {
                const d = toDate(day);
                const from = d.getTime();
                d.setDate(d.getDate() + 1);
                return [Math.max(from, startMs), Math.min(d.getTime(), g.endMs)];
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
  const rows = db
    .query<Snap & { kind: string }, [string, number | null, number | null]>(
      // A row from before the range still counts when it was confirmed inside it.
      `SELECT ts, COALESCE(seen_ts, ts) seen, kind, percent_used percent, resets_at resetsAt
       FROM plan_snapshots
       WHERE org_id = ?1 AND (?2 IS NULL OR COALESCE(seen_ts, ts) >= ?2) AND (?3 IS NULL OR ts < ?3)
       ORDER BY ts, id`,
    )
    .all(ORG, fromMs, toMs);
  // The same readings the windows use. shortcut: noise at the range's edges stays; widen the query if that shows.
  const points = [...Map.groupBy(rows, (p) => p.kind).values()]
    .flatMap(dropNoise)
    .sort((a, b) => a.ts - b.ts)
    .map(({ ts, seen, kind, percent, resetsAt }) => ({
      ts,
      seenTs: seen,
      kind,
      percentUsed: percent,
      resetsAt,
    }));
  return { points };
}
