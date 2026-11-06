import { useQuery } from "@tanstack/react-query";
import { type SessionDetail as Detail, totalTokens } from "@td/shared";
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
import { api, HttpError } from "../../api";
import { axisProps, SERIES_VARS, tooltipStyle } from "../../chart-theme";
import { ChartCard } from "../../components/ChartCard";
import { StatTile } from "../../components/StatTile";
import { fmtDuration, fmtTokens, fmtUsd, sourceLabel } from "../../format";
import { SessionSeries } from "./SessionSeries";

const CACHE_SERIES = [
  // Same slots as the token types elsewhere (chart-theme TYPE_SLOT); cache write takes 1h's orange.
  { key: "cacheRead", label: "Cache read", color: SERIES_VARS[2] },
  { key: "cacheWrite", label: "Cache write", color: SERIES_VARS[1] },
  { key: "input", label: "Uncached input", color: SERIES_VARS[3] },
] as const;

export function SessionDetail({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ["session", id],
    queryFn: ({ signal }) =>
      api<Detail>(`/sessions/${encodeURIComponent(id)}`, undefined, { signal }),
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
  const axis = axisProps;

  return (
    <>
      <section className="card">
        <h1>{s.title ?? s.id}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {s.projectLabel ?? "—"} · {s.cwd ?? "no cwd"} · {sourceLabel(s.sourceKind, s.entrypoint)}
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
          value={fmtTokens(totalTokens(t))}
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
        <ChartCard id="session-context" title="Context window of the main agent per request">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={context}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="n" {...axis} />
              <YAxis tickFormatter={fmtTokens} width={64} axisLine={false} {...axis} />
              <Tooltip
                formatter={(v) => fmtTokens(Number(v))}
                labelFormatter={(n) => `Request ${n}`}
                contentStyle={tooltipStyle}
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
        </ChartCard>
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
