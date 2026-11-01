import { useQuery } from "@tanstack/react-query";
import type { PlanSnapshots, PlanWindow, PlanWindows } from "@td/shared";
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
import { seriesColor } from "../components/TimeChart";
import { fmtDuration, fmtTokens, fmtUsd } from "../format";

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

function Timeline({ data, resets }: { data: PlanSnapshots; resets: number[] }) {
  const kinds = [...new Set(data.points.map((p) => p.kind))];
  const axis = {
    stroke: "var(--axis)",
    tick: { fill: "var(--muted)", fontSize: 12 },
    tickLine: false,
  };
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis
          {...axis}
          dataKey="ts"
          type="number"
          scale="time"
          domain={["dataMin", "dataMax"]}
          tickFormatter={when}
          allowDuplicatedCategory={false}
        />
        <YAxis {...axis} domain={[0, 100]} tickFormatter={(v) => `${v}%`} width={44} />
        <Tooltip
          labelFormatter={(v) => when(Number(v))}
          formatter={(v) => pct(Number(v))}
          contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)" }}
        />
        <Legend />
        {resets.map((r) => (
          <ReferenceLine key={r} x={r} stroke="var(--muted)" strokeDasharray="3 3" />
        ))}
        {kinds.map((k, i) => (
          <Line
            key={k}
            data={data.points.filter((p) => p.kind === k)}
            dataKey="percentUsed"
            name={kindLabel(k)}
            type="stepAfter"
            stroke={seriesColor(k, i)}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

const perPct = (v: number | null, f: (n: number) => string) => (v === null ? "—" : f(v));

export function Plan({ range }: ViewProps) {
  const now = useNow();
  const windows = usePlanWindows(range);
  const points = useQuery({
    queryKey: ["plan", "snapshots", range],
    queryFn: () => api<PlanSnapshots>("/plan/snapshots", range),
  });
  if (windows.error) return <p className="error">{windows.error.message}</p>;
  if (!windows.data || !points.data) return <p className="muted">Loading…</p>;
  const { current, past } = windows.data;
  if (!current.length && !past.length && !points.data.points.length)
    return (
      <p className="muted empty">
        No plan readings yet. Start a Claude Code session in WSL with the mod loaded (
        <code>claude --plugin-dir ./plugin</code>).
      </p>
    );
  const resets = [...new Set(points.data.points.flatMap((p) => p.resetsAt ?? []))].filter(
    (r) => r <= (points.data.points.at(-1)?.ts ?? 0),
  );
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
        <h2>Plan usage over time</h2>
        {points.data.points.length ? (
          <Timeline data={points.data} resets={resets} />
        ) : (
          <p className="muted empty">No readings in this period.</p>
        )}
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
