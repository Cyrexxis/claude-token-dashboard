import { useQuery } from "@tanstack/react-query";
import {
  GROUP_LABEL,
  type Group,
  isTimedPlanKind,
  type PlanSnapshotPoint,
  type PlanSnapshots,
  type PlanWindow,
  type PlanWindows,
  type SessionList,
  TIMED_PLAN_KINDS,
  type TimedPlanKind,
  type Timeseries,
} from "@td/shared";
import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ViewProps } from "../App";
import { api } from "../api";
import { SessionTable } from "../components/SessionTable";
import { seriesColor, TimeChart } from "../components/TimeChart";
import { fmtDuration, fmtTokens, fmtUsd, localDay } from "../format";

const KIND_LABEL: Record<string, string> = { five_hour: "5-hour", seven_day: "Weekly" };
export const kindLabel = (kind: string) => KIND_LABEL[kind] ?? kind;
const pct = (n: number) => `${n.toFixed(1).replace(/\.0$/, "")} %`;
const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const CHAT_NOTE =
  "Plan % also counts claude.ai chat and Cowork, so this reads low on days you also chat.";

/** Re-renders every 30 s so reset countdowns stay current. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function usePlanWindows(range: ViewProps["range"]) {
  return useQuery({
    queryKey: ["plan", "windows", range],
    queryFn: () => api<PlanWindows>("/plan/windows", range),
  });
}

function WindowCard({ w, now }: { w: PlanWindow; now: number }) {
  return (
    <div className="tile">
      <div className="label">{kindLabel(w.kind)} window</div>
      <div className="value">{pct(w.peakPercent)}</div>
      <div className="bar" role="presentation">
        <span style={{ width: `${Math.min(w.peakPercent, 100)}%` }} />
      </div>
      <div className="sub">resets in {fmtDuration(Math.max(w.resetsAt - now, 0))}</div>
      {w.usdPerPercent !== null && w.tokensPerPercent !== null && (
        <div className="sub">
          {fmtUsd(w.usdPerPercent)} · {fmtTokens(w.tokensPerPercent)} tokens per 1 % (Claude Code
          only)
        </div>
      )}
    </div>
  );
}

type Kind = TimedPlanKind;
const KINDS = TIMED_PLAN_KINDS;

function WindowTabs({ kind, onChange }: { kind: Kind; onChange: (k: Kind) => void }) {
  return (
    <div className="tabs">
      {KINDS.map((k) => (
        <button key={k} type="button" aria-pressed={k === kind} onClick={() => onChange(k)}>
          {kindLabel(k)}
        </button>
      ))}
    </div>
  );
}

/** Snapshots covering the window; the API filters by local day, so this over-fetches a little. */
function useWindowPoints(w: PlanWindow) {
  const range = { from: localDay(new Date(w.startMs ?? 0)), to: localDay(new Date(w.resetsAt)) };
  return useQuery({
    queryKey: ["plan", "snapshots", range],
    queryFn: () => api<PlanSnapshots>("/plan/snapshots", range),
  });
}

/**
 * One row per reading time from `start` on, each kind holding its latest value so far in its
 * current window. Readings are stored only when a value changes, so carrying it forward is exact.
 * Rows end at the last reading of any kind, so a mod that stopped reporting shows as a gap.
 */
export function mergeReadings(
  points: PlanSnapshotPoint[],
  current: Pick<PlanWindow, "kind" | "resetsAt">[],
  start: number,
): Record<string, number>[] {
  const resets = new Map(current.map((w) => [w.kind, w.resetsAt]));
  const own = points.filter((p) => resets.get(p.kind) === p.resetsAt).sort((a, b) => a.ts - b.ts);
  const times = [...new Set([start, ...own.filter((p) => p.ts > start).map((p) => p.ts)])];
  const last: Record<string, number> = {};
  let i = 0;
  return times.map((ts) => {
    for (let p = own[i]; p && p.ts <= ts; p = own[++i]) last[p.kind] = p.percentUsed;
    return { ...last, ts };
  });
}

/** Whole hours for the 5-hour window, local midnights for the weekly one. */
export function windowTicks(kind: string, start: number, end: number): number[] {
  const t = new Date(start);
  if (kind === "five_hour") t.setMinutes(0, 0, 0);
  else t.setHours(0, 0, 0, 0);
  const out: number[] = [];
  for (
    ;
    t.getTime() <= end;
    kind === "five_hour" ? t.setHours(t.getHours() + 1) : t.setDate(t.getDate() + 1)
  )
    if (t.getTime() >= start) out.push(t.getTime());
  return out;
}
const hourTick = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const dayTick = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

/** The 5-hour view also shows the weekly line; the weekly view shows only itself. */
function Timeline({ w, current, now }: { w: PlanWindow; current: PlanWindow[]; now: number }) {
  // The weekly window's range also holds the weekly reading that carries into a 5-hour window.
  const points = useWindowPoints(current.find((c) => c.kind === "seven_day") ?? w);
  if (points.error) return <p className="error">{points.error.message}</p>;
  if (!points.data) return <p className="muted">Loading…</p>;
  const start = w.startMs ?? 0;
  const rows = mergeReadings(points.data.points, current, start);
  const shown = w.kind === "five_hour" ? KINDS : [w.kind];
  const axis = {
    stroke: "var(--axis)",
    tick: { fill: "var(--muted)", fontSize: 12 },
    tickLine: false,
  };
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={rows}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis
          {...axis}
          dataKey="ts"
          type="number"
          scale="time"
          domain={[start, w.resetsAt]}
          ticks={windowTicks(w.kind, start, w.resetsAt)}
          tickFormatter={w.kind === "five_hour" ? hourTick : dayTick}
        />
        <YAxis {...axis} domain={[0, 100]} tickFormatter={(v) => `${v}%`} width={44} />
        <Tooltip
          labelFormatter={(v) => when(Number(v))}
          formatter={(v) => pct(Number(v))}
          contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)" }}
        />
        <Legend />
        <ReferenceLine
          x={now}
          stroke="var(--muted)"
          strokeDasharray="3 3"
          label={{ value: "now", position: "insideTopRight", fill: "var(--muted)", fontSize: 11 }}
        />
        {shown.map((k) => (
          <Line
            key={k}
            dataKey={k}
            name={kindLabel(k)}
            type="stepAfter"
            stroke={seriesColor(k, (KINDS as readonly string[]).indexOf(k))}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function WindowSessions({ w }: { w: PlanWindow }) {
  const params = { fromMs: w.startMs ?? 0, toMs: w.resetsAt };
  const list = useQuery({
    queryKey: ["plan", "sessions", params],
    queryFn: () => api<SessionList>("/plan/sessions", params),
  });
  if (list.error) return <p className="error">{list.error.message}</p>;
  if (!list.data) return <p className="muted">Loading…</p>;
  if (!list.data.items.length) return <p className="muted empty">No sessions in this window.</p>;
  return (
    <>
      <SessionTable items={list.data.items} sortable />
      <p className="muted note">
        Tokens and cost count only requests inside the window; duration is the whole session.
      </p>
    </>
  );
}

const STEP_MS: Record<Kind, number> = { five_hour: 5 * 60_000, seven_day: 3 * 3_600_000 };
const GROUPS: Group[] = ["type", "model", "source", "project"];
const slotLabel = (kind: Kind) => (b: string) =>
  kind === "five_hour"
    ? hourTick(Number(b))
    : new Date(Number(b)).toLocaleString(undefined, {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      });

/** Tokens or cost in the current window, 5-minute slots for 5-hour, 3-hour slots for weekly. */
function WindowSeries({ current, picked }: { current: PlanWindow[]; picked: PlanWindow | null }) {
  const [tabKind, setKind] = useState<Kind>("five_hour");
  const kind = picked && isTimedPlanKind(picked.kind) ? picked.kind : tabKind;
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const [group, setGroup] = useState<Group>("type");
  const w = picked ?? current.find((c) => c.kind === kind && c.startMs !== null);
  const params = w && {
    fromMs: w.startMs ?? 0,
    toMs: w.resetsAt,
    stepMs: STEP_MS[kind],
    metric,
    group,
  };
  const q = useQuery({
    queryKey: ["plan", "timeseries", params],
    queryFn: () => api<Timeseries>("/plan/timeseries", params),
    enabled: !!params,
  });
  return (
    <section className="card">
      <div className="toolbar">
        <h2 style={{ margin: 0, flex: 1 }}>
          {metric === "tokens" ? "Tokens" : "API-equivalent cost"} in the{" "}
          {picked ? "selected" : "current"} window
        </h2>
        <div className="tabs">
          {(["tokens", "cost"] as const).map((m) => (
            <button key={m} type="button" aria-pressed={m === metric} onClick={() => setMetric(m)}>
              {m === "tokens" ? "Tokens" : "Cost"}
            </button>
          ))}
        </div>
        <label>
          Group by{" "}
          <select value={group} onChange={(e) => setGroup(e.target.value as Group)}>
            {GROUPS.map((g) => (
              <option key={g} value={g}>
                {GROUP_LABEL[g]}
              </option>
            ))}
          </select>
        </label>
        {!picked && <WindowTabs kind={kind} onChange={setKind} />}
      </div>
      {!w && <p className="muted empty">No current {kindLabel(kind)} window.</p>}
      {q.error && <p className="error">{q.error.message}</p>}
      {w && !q.data && !q.error && <p className="muted">Loading…</p>}
      {w && q.data && (
        <TimeChart
          // Remount per metric so the cache-read default applies to tokens only.
          key={metric}
          data={q.data}
          kind="bar"
          height={320}
          format={metric === "cost" ? fmtUsd : fmtTokens}
          label={slotLabel(kind)}
          // Cache reads dwarf every other type and would flatten the chart.
          defaultHidden={metric === "tokens" ? ["cacheRead"] : []}
        />
      )}
    </section>
  );
}

/** Weekly windows overlapping `w` (a 5-hour window); none for a weekly window. */
export function overlappingWeekly(w: PlanWindow, all: PlanWindow[]): PlanWindow[] {
  if (w.kind !== "five_hour" || w.startMs === null) return [];
  const start = w.startMs;
  return all.filter(
    (x) =>
      x.kind === "seven_day" && x.startMs !== null && x.startMs < w.resetsAt && start < x.resetsAt,
  );
}

const perPct = (v: number | null, f: (n: number) => string) => (v === null ? "—" : f(v));

export function Plan({ range }: ViewProps) {
  const now = useNow();
  const windows = usePlanWindows(range);
  const [chartKind, setChartKind] = useState<Kind>("five_hour");
  const [tableKind, setTableKind] = useState<Kind>("five_hour");
  const [listKind, setListKind] = useState<Kind>("five_hour");
  const [picked, setPicked] = useState<PlanWindow | null>(null);
  if (windows.error) return <p className="error">{windows.error.message}</p>;
  if (!windows.data) return <p className="muted">Loading…</p>;
  const { current, past } = windows.data;
  if (!current.length && !past.length)
    return (
      <p className="muted empty">
        No plan readings yet. Start a Claude Code session in WSL with the mod loaded (
        <code>claude --plugin-dir ./plugin</code>).
      </p>
    );
  const win = (k: Kind) => current.find((w) => w.kind === k && w.startMs !== null);
  const chartWin = picked ?? win(chartKind);
  // A picked window brings its own readings; a 5-hour one also shows the weekly window it overlaps.
  const chartCurrent = picked
    ? [picked, ...overlappingWeekly(picked, [...current, ...past]).slice(0, 1)]
    : current;
  const tableWin = picked ?? win(tableKind);
  const listed = [...current, ...past].filter((w) => w.kind === listKind && w.startMs !== null);
  const none = (k: Kind) => <p className="muted empty">No current {kindLabel(k)} window.</p>;
  return (
    <>
      {current.length > 0 && (
        <div className="tiles">
          {current.map((w) => (
            <WindowCard key={`${w.kind}-${w.resetsAt}`} w={w} now={now} />
          ))}
        </div>
      )}
      {picked && (
        <div className="card toolbar">
          <span style={{ flex: 1 }}>
            Charts and sessions show the past {kindLabel(picked.kind)} window{" "}
            {when(picked.startMs ?? 0)} → {when(picked.resetsAt)}.
          </span>
          <button type="button" className="primary" onClick={() => setPicked(null)}>
            Back to current window
          </button>
        </div>
      )}
      <section className="card">
        <div className="toolbar">
          <h2 style={{ margin: 0, flex: 1 }}>
            Plan usage in the {picked ? "selected" : "current"} window
          </h2>
          {!picked && <WindowTabs kind={chartKind} onChange={setChartKind} />}
        </div>
        {chartWin ? <Timeline w={chartWin} current={chartCurrent} now={now} /> : none(chartKind)}
      </section>
      <WindowSeries current={current} picked={picked} />
      <section className="card">
        <div className="toolbar">
          <h2 style={{ margin: 0, flex: 1 }}>
            Sessions in the {picked ? "selected" : "current"} window
          </h2>
          {!picked && <WindowTabs kind={tableKind} onChange={setTableKind} />}
        </div>
        {tableWin ? <WindowSessions w={tableWin} /> : none(tableKind)}
      </section>
      <section className="card">
        <div className="toolbar">
          <h2 style={{ margin: 0, flex: 1 }}>Windows</h2>
          <WindowTabs kind={listKind} onChange={setListKind} />
        </div>
        {listed.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Start → reset</th>
                  <th className="num">Peak</th>
                  <th className="num">Tokens</th>
                  <th className="num">Cost</th>
                  <th className="num">$ per 1 %</th>
                  <th className="num">Tokens per 1 %</th>
                </tr>
              </thead>
              <tbody>
                {listed.map((w) => {
                  // The current row stands for "no pick": choosing it goes back to the current view.
                  const isPicked = w.current
                    ? picked === null
                    : picked?.kind === w.kind && picked.resetsAt === w.resetsAt;
                  const pick = () => setPicked(w.current ? null : w);
                  const cls = ["link", w.lowSignal && "faded", isPicked && "selected"];
                  return (
                    <tr
                      key={`${w.kind}-${w.resetsAt}`}
                      className={cls.filter(Boolean).join(" ")}
                      title={w.lowSignal ? "Under 5 %: per-1 % figures are noisy" : undefined}
                      // Mouse convenience; the button is the real (keyboard) target and handles its own clicks.
                      onClick={(e) => (e.target as Element).closest("button") || pick()}
                    >
                      <td>
                        <button
                          type="button"
                          className="row-pick"
                          aria-pressed={isPicked}
                          onClick={pick}
                        >
                          {when(w.startMs ?? 0)} → {when(w.resetsAt)}
                        </button>
                        {w.current && <span className="muted"> (current)</span>}
                      </td>
                      <td className="num">{pct(w.peakPercent)}</td>
                      <td className="num">{fmtTokens(w.tokens)}</td>
                      <td className="num">{fmtUsd(w.costUsd)}</td>
                      <td className="num">{perPct(w.usdPerPercent, fmtUsd)}</td>
                      <td className="num">{perPct(w.tokensPerPercent, fmtTokens)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No {kindLabel(listKind)} windows in this period.</p>
        )}
        <p className="muted note">
          Pick a window to show it in the charts and sessions. Per-1 % figures are Claude Code only,
          counted up to the last plan reading. {CHAT_NOTE}
        </p>
      </section>
    </>
  );
}
