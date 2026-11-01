import { useQuery } from "@tanstack/react-query";
import type { SessionDetail as Detail } from "@td/shared";
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
import { SERIES_VARS } from "../components/TimeChart";
import { fmtDuration, fmtTokens, fmtUsd, projectLabel, sourceLabel } from "../format";

const time = (ms: number) => new Date(ms).toLocaleTimeString();
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
        <a href="#/sessions">Back to sessions</a>
      </section>
    );
  if (q.error) return <p className="error">{q.error.message}</p>;
  if (!q.data) return <p className="muted">Loading…</p>;

  const { session: s, requests, agents, costStateUsd } = q.data;
  const t = s.tokens;
  const cache = requests.map((r, i) => ({
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
      <p>
        <a href="#/sessions">← Sessions</a>
      </p>
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
          sub={`${agents.length} subagents`}
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
      {cache.length > 1 && (
        <section className="card">
          <h2>Cache behaviour per request</h2>
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={cache}>
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
                    <td className="mono">{a.agentId}</td>
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
      <section className="card">
        <h2>Requests</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Model</th>
                <th>Agent</th>
                <th className="num">Input</th>
                <th className="num">Output</th>
                <th className="num">Cache read</th>
                <th className="num">Write 5m</th>
                <th className="num">Write 1h</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td>{time(r.ts)}</td>
                  <td>
                    {r.model ?? "—"}
                    {r.speed && r.speed !== "standard" && ` (${r.speed})`}
                  </td>
                  <td className="mono">{r.agentId ?? "main"}</td>
                  <td className="num">{fmtTokens(r.input)}</td>
                  <td className="num">{fmtTokens(r.output)}</td>
                  <td className="num">{fmtTokens(r.cacheRead)}</td>
                  <td className="num">{fmtTokens(r.cacheWrite5m)}</td>
                  <td className="num">{fmtTokens(r.cacheWrite1h)}</td>
                  <td className="num">{r.unpriced ? "unpriced" : fmtUsd(r.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
