import { useQuery } from "@tanstack/react-query";
import type {
  PlanSnapshotPoint,
  PlanSnapshots,
  PlanWindow,
  PlanWindows,
  SessionList,
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
import { seriesColor } from "../components/TimeChart";
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

type Kind = "five_hour" | "seven_day";
const KINDS: Kind[] = ["five_hour", "seven_day"];

function WindowTabs({ kind, onChange }: { kind: Kind; onChange: (k: Kind) => void }) {
  return (
    <div className="tabs" role="tablist">
      {KINDS.map((k) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={k === kind}
          onClick={() => onChange(k)}
        >
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
    for (; i < own.length && own[i].ts <= ts; i++) last[own[i].kind] = own[i].percentUsed;
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
            stroke={seriesColor(k, KINDS.indexOf(k as Kind))}
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

const perPct = (v: number | null, f: (n: number) => string) => (v === null ? "—" : f(v));

export function Plan({ range }: ViewProps) {
  const now = useNow();
  const windows = usePlanWindows(range);
  const [chartKind, setChartKind] = useState<Kind>("five_hour");
  const [tableKind, setTableKind] = useState<Kind>("five_hour");
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
  const chartWin = win(chartKind);
  const tableWin = win(tableKind);
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
      <section className="card">
        <div className="toolbar">
          <h2 style={{ margin: 0, flex: 1 }}>Plan usage in the current window</h2>
          <WindowTabs kind={chartKind} onChange={setChartKind} />
        </div>
        {chartWin ? <Timeline w={chartWin} current={current} now={now} /> : none(chartKind)}
      </section>
      <section className="card">
        <div className="toolbar">
          <h2 style={{ margin: 0, flex: 1 }}>Sessions in the current window</h2>
          <WindowTabs kind={tableKind} onChange={setTableKind} />
        </div>
        {tableWin ? <WindowSessions w={tableWin} /> : none(tableKind)}
      </section>
      <section className="card">
        <h2>Past windows</h2>
        {past.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Window</th>
                  <th>Start → reset</th>
                  <th className="num">Peak</th>
                  <th className="num">Tokens</th>
                  <th className="num">Cost</th>
                  <th className="num">$ per 1 %</th>
                  <th className="num">Tokens per 1 %</th>
                </tr>
              </thead>
              <tbody>
                {past.map((w) => (
                  <tr
                    key={`${w.kind}-${w.resetsAt}`}
                    className={w.lowSignal ? "faded" : undefined}
                    title={w.lowSignal ? "Under 5 %: per-1 % figures are noisy" : undefined}
                  >
                    <td>{kindLabel(w.kind)}</td>
                    <td>
                      {w.startMs === null ? "" : `${when(w.startMs)} → `}
                      {when(w.resetsAt)}
                    </td>
                    <td className="num">{pct(w.peakPercent)}</td>
                    <td className="num">{fmtTokens(w.tokens)}</td>
                    <td className="num">{fmtUsd(w.costUsd)}</td>
                    <td className="num">{perPct(w.usdPerPercent, fmtUsd)}</td>
                    <td className="num">{perPct(w.tokensPerPercent, fmtTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No finished windows in this period.</p>
        )}
        <p className="muted note">
          Per-1 % figures are Claude Code only, counted up to the last plan reading. {CHAT_NOTE}
        </p>
      </section>
    </>
  );
}
