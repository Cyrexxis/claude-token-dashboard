import { useQuery } from "@tanstack/react-query";
import type { Prices, Summary } from "@td/shared";
import type { ViewProps } from "../App";
import { api } from "../api";
import { SeriesView } from "../components/SeriesView";
import { StatTile } from "../components/StatTile";
import { fmtTokens, fmtUsd, rangeDays } from "../format";

const DAYS_PER_MONTH = 30.4375;

export function Overview({ range }: ViewProps) {
  const summary = useQuery({
    queryKey: ["summary", range],
    queryFn: () => api<Summary>("/summary", range),
  });
  const prices = useQuery({ queryKey: ["prices"], queryFn: () => api<Prices>("/prices") });
  const s = summary.data;
  if (summary.error) return <p className="error">{summary.error.message}</p>;
  if (!s) return <p className="muted">Loading…</p>;

  // A price change is marked on the bucket that contains its effective date.
  const priceMarks = (buckets: string[]) =>
    (prices.data?.periods ?? []).flatMap((p) => {
      if (!p.effectiveFrom || !buckets.length) return [];
      if (p.effectiveFrom < buckets[0]) return [];
      if (range.to && p.effectiveFrom > range.to) return [];
      const at = buckets.filter((b) => b <= (p.effectiveFrom as string)).at(-1);
      return at ? [{ day: at, label: `${p.modelId} price change` }] : [];
    });
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
        <StatTile label="Requests" value={s.requests.toLocaleString()} />
        <StatTile label="Sessions" value={s.sessions.toLocaleString()} />
        <StatTile
          label="Cache hit ratio"
          value={s.cacheHitRatio === null ? "—" : `${(s.cacheHitRatio * 100).toFixed(1)}%`}
          sub="cache read ÷ all input"
        />
      </div>
      <SeriesView
        range={range}
        metric="tokens"
        groups={["type", "model", "source", "project"]}
        title="Tokens"
        // Cache reads dwarf every other type and would flatten the chart.
        defaultHidden={["cacheRead"]}
      />
      <SeriesView
        range={range}
        metric="cost"
        groups={["type", "model", "source", "project"]}
        title="API-equivalent cost at historical prices"
        marks={priceMarks}
      />
    </>
  );
}
