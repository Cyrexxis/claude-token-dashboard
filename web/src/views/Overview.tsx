import { useQuery } from "@tanstack/react-query";
import type { Summary, Timeseries } from "@td/shared";
import type { ViewProps } from "../App";
import { api } from "../api";
import { StatTile } from "../components/StatTile";
import { TimeChart } from "../components/TimeChart";
import { autoBucket, fmtDuration, fmtTokens, fmtUsd, rangeDays } from "../format";
import { kindLabel, useNow, usePlanWindows } from "./Plan";

const DAYS_PER_MONTH = 30.4375;

export function Overview({ range }: ViewProps) {
  const bucket = autoBucket(range);
  const summary = useQuery({
    queryKey: ["summary", range],
    queryFn: () => api<Summary>("/summary", range),
  });
  const series = useQuery({
    queryKey: ["timeseries", { ...range, metric: "tokens", group: "type", bucket }],
    queryFn: () =>
      api<Timeseries>("/timeseries", { ...range, metric: "tokens", group: "type", bucket }),
  });
  const plan = usePlanWindows(range);
  const now = useNow();
  const s = summary.data;
  if (summary.error) return <p className="error">{summary.error.message}</p>;
  if (!s) return <p className="muted">Loading…</p>;

  const t = s.tokens;
  const days = rangeDays(range);
  const sub =
    s.subscriptionMonthlyUsd !== null && days !== null
      ? (s.subscriptionMonthlyUsd * days) / DAYS_PER_MONTH
      : null;
  return (
    <>
      <div className="tiles">
        <StatTile
          label="Tokens"
          value={fmtTokens(t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h)}
          sub={`${fmtTokens(t.output)} output · ${fmtTokens(t.thinking)} thinking`}
        />
        <StatTile
          label="API-equivalent cost"
          value={fmtUsd(s.costUsd)}
          sub={s.unpricedRequests ? `${s.unpricedRequests} unpriced requests` : undefined}
        />
        {sub !== null && (
          <StatTile
            label="vs. subscription"
            value={sub > 0 ? `×${(s.costUsd / sub).toFixed(1)}` : "—"}
            sub={`${fmtUsd(sub)} of plan for ${days} days`}
          />
        )}
        {plan.data?.current.map((w) => (
          <StatTile
            key={`${w.kind}-${w.resetsAt}`}
            label={`${kindLabel(w.kind)} plan`}
            value={`${w.peakPercent.toFixed(1).replace(/\.0$/, "")} %`}
            sub={`resets in ${fmtDuration(Math.max(w.resetsAt - now, 0))}`}
          />
        ))}
        <StatTile label="Requests" value={s.requests.toLocaleString()} />
        <StatTile label="Sessions" value={s.sessions.toLocaleString()} />
        <StatTile
          label="Cache hit ratio"
          value={s.cacheHitRatio === null ? "—" : `${(s.cacheHitRatio * 100).toFixed(1)}%`}
          sub="cache read ÷ all input"
        />
      </div>
      {plan.data && !plan.data.current.length && (
        <p className="muted note">
          No current plan window: load the mod to see plan usage (see the <a href="#/plan">Plan</a>{" "}
          page).
        </p>
      )}
      <section className="card">
        <h2>Tokens by type</h2>
        {series.data ? (
          <TimeChart data={series.data} kind="area" format={fmtTokens} />
        ) : (
          <p className="muted">Loading…</p>
        )}
      </section>
    </>
  );
}
