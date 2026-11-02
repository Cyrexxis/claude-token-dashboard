import { useQuery } from "@tanstack/react-query";
import { type SessionDetail as Detail, GROUP_LABEL, type Group, type Timeseries } from "@td/shared";
import { useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, HttpError } from "../api";
import { StatTile } from "../components/StatTile";
import { SERIES_VARS, TimeChart } from "../components/TimeChart";
import { fmtDuration, fmtTokens, fmtUsd, projectLabel, sourceLabel } from "../format";

const M = 60_000;
const DAY = 24 * 60 * M;
const STEPS = [M, 5 * M, 15 * M, 60 * M, 3 * 60 * M, DAY];
const STEP_LABEL = ["1-minute", "5-minute", "15-minute", "1-hour", "3-hour", "1-day"];
/** Smallest slot that keeps a session of this length to at most 60 bars. */
export const pickStep = (durationMs: number) => STEPS.find((s) => durationMs / s < 60) ?? DAY;
/** Start of the local-time slot holding `ts`, so hour and day slots begin on the clock. */
export function slotStart(ts: number, step: number): number {
  const local = -new Date(ts).getTimezoneOffset() * M;
  return ts - ((ts + local) % step);
}
const hhmm = (b: string) =>
  new Date(Number(b)).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const dayHour = (b: string) =>
  new Date(Number(b)).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** Tokens or cost over the session's lifetime, sub-agents included; slot size follows its length. */
function SessionSeries({ s }: { s: Detail["session"] }) {
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const [group, setGroup] = useState<Group>("type");
  const first = s.firstTs ?? 0;
  const last = s.lastTs ?? first;
  const stepMs = pickStep(last - first);
  const params = {
    sessionId: s.id,
    fromMs: slotStart(first, stepMs),
    toMs: last + 1,
    stepMs,
    metric,
    group,
  };
  const q = useQuery({
    queryKey: ["session", s.id, "timeseries", params],
    queryFn: () => api<Timeseries>("/plan/timeseries", params),
    // Keep the chart while a live session grows, but never show another session's data.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === s.id ? prev : undefined),
  });
  const multiDay = new Date(first).toDateString() !== new Date(last).toDateString();
  return (
    <section className="card">
      <div className="toolbar">
        <h2 style={{ margin: 0, flex: 1 }}>
          {metric === "tokens" ? "Tokens" : "API-equivalent cost"} over the session
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
            {(["type", "agent"] as const).map((g) => (
              <option key={g} value={g}>
                {GROUP_LABEL[g]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {q.error && <p className="error">{q.error.message}</p>}
      {!q.data && !q.error && <p className="muted">Loading…</p>}
      {q.data && (
        <TimeChart
          // Remount per metric and group so the cache-read default applies to tokens by type only.
          key={`${metric}-${group}`}
          data={q.data}
          kind="bar"
          height={320}
          format={metric === "cost" ? fmtUsd : fmtTokens}
          label={multiDay ? dayHour : hhmm}
          // Cache reads dwarf every other type and would flatten the chart.
          defaultHidden={metric === "tokens" && group === "type" ? ["cacheRead"] : []}
        />
      )}
      <p className="muted note">Includes sub-agents; {STEP_LABEL[STEPS.indexOf(stepMs)]} slots.</p>
    </section>
  );
}
const CACHE_SERIES = [
  { key: "cacheRead", label: "Cache read", color: SERIES_VARS[0] },
  { key: "cacheWrite", label: "Cache write", color: SERIES_VARS[1] },
  { key: "input", label: "Uncached input", color: SERIES_VARS[2] },
] as const;

export function SessionDetail({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ["session", id],
    queryFn: () => api<Detail>(`/sessions/${encodeURIComponent(id)}`),
  });
  if (q.error instanceof HttpError && q.error.status === 404)
    return (
      <section className="card">
        <h1>Session not found</h1>
      </section>
    );
  if (q.error) return <p className="error">{q.error.message}</p>;
  if (!q.data) return <p className="muted">Loading…</p>;

  const { session: s, requests, agents, costStateUsd } = q.data;
  const t = s.tokens;
  // The main agent's context per request: everything it sent, cached or not.
  const context = requests
    .filter((r) => r.agentId === null)
    .map((r, i) => ({
      n: i + 1,
      cacheRead: r.cacheRead,
      cacheWrite: r.cacheWrite5m + r.cacheWrite1h,
      input: r.input,
    }));
  const axis = {
    stroke: "var(--axis)",
    tick: { fill: "var(--muted)", fontSize: 12 },
    tickLine: false,
  };

  return (
    <>
      <section className="card">
        <h1>{s.title ?? s.id}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {projectLabel(s.project, s.cwd)} · {s.cwd ?? "no cwd"} ·{" "}
          {sourceLabel(s.sourceKind, s.entrypoint)}
          {s.ccVersion && ` · Claude Code ${s.ccVersion}`}
          {s.tag && ` · tag ${s.tag}`}
          {s.firstTs !== null && ` · ${new Date(s.firstTs).toLocaleString()}`}
          {s.firstTs !== null && s.lastTs !== null && ` (${fmtDuration(s.lastTs - s.firstTs)})`}
        </p>
        <p className="mono muted" style={{ margin: "4px 0 0" }}>
          {s.id}
        </p>
      </section>
      <div className="tiles">
        <StatTile
          label="Requests"
          value={s.requests.toLocaleString()}
          sub={`${agents.length} ${agents.length === 1 ? "subagent" : "subagents"}`}
        />
        <StatTile
          label="Tokens"
          value={fmtTokens(t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h)}
          sub={`${fmtTokens(t.output)} output`}
        />
        <StatTile
          label="API-equivalent cost"
          value={fmtUsd(s.costUsd)}
          sub={s.unpricedRequests ? `${s.unpricedRequests} unpriced requests` : undefined}
        />
        {costStateUsd !== null && (
          // cost-state is written at process exit, so a running session's latest process is missing:
          // show Claude Code's own total as-is rather than a difference that can go negative.
          <StatTile
            label="Claude Code reported"
            value={fmtUsd(costStateUsd)}
            sub="cost-state of exited processes, incl. side requests"
          />
        )}
      </div>
      {context.length > 1 && (
        <section className="card">
          <h2>Context window of the main agent per request</h2>
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={context}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="n" {...axis} />
              <YAxis tickFormatter={fmtTokens} width={64} axisLine={false} {...axis} />
              <Tooltip
                formatter={(v) => fmtTokens(Number(v))}
                labelFormatter={(n) => `Request ${n}`}
                contentStyle={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                itemStyle={{ color: "var(--text)" }}
              />
              <Legend
                content={() => (
                  <div className="legend">
                    {CACHE_SERIES.map((c) => (
                      <span key={c.key}>
                        <span className="swatch" style={{ background: c.color }} />
                        {c.label}
                      </span>
                    ))}
                  </div>
                )}
              />
              {CACHE_SERIES.map((c) => (
                <Area
                  key={c.key}
                  dataKey={c.key}
                  name={c.label}
                  stackId="a"
                  type="stepAfter"
                  fill={c.color}
                  fillOpacity={0.85}
                  stroke="var(--surface)"
                  strokeWidth={1}
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </section>
      )}
      <SessionSeries s={s} />
      {agents.length > 0 && (
        <section className="card">
          <h2>Subagents</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th className="num">Requests</th>
                  <th className="num">Output</th>
                  <th className="num">Cache read</th>
                  <th className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.agentId}>
                    <td title={a.agentId} className={a.name ? undefined : "mono"}>
                      {a.name ?? a.agentId}
                    </td>
                    <td className="num">{a.requests}</td>
                    <td className="num">{fmtTokens(a.tokens.output)}</td>
                    <td className="num">{fmtTokens(a.tokens.cacheRead)}</td>
                    <td className="num">{fmtUsd(a.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
