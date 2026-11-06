import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { type Prices, type Summary, totalTokens } from "@td/shared";
import { api } from "../api";
import { BreakdownChart } from "../components/BreakdownChart";
import { SeriesView } from "../components/SeriesView";
import { StatTile } from "../components/StatTile";
import { fmtTokens, fmtUsd, rangeDays } from "../format";
import type { ViewProps } from "../types";

const DAYS_PER_MONTH = 30.4375;

export function Overview({ range }: ViewProps) {
  const summary = useQuery({
    queryKey: ["summary", range],
    queryFn: ({ signal }) => api<Summary>("/summary", range, { signal }),
    // Keeps the old view on screen while a new range loads, so the page doesn't jump.
    placeholderData: keepPreviousData,
  });
  const prices = useQuery({
    queryKey: ["prices"],
    queryFn: ({ signal }) => api<Prices>("/prices", undefined, { signal }),
  });
  const s = summary.data;
  if (summary.error) return <p className="error">{summary.error.message}</p>;
  if (!s) return <p className="muted">Loading…</p>;

  // A price change is marked on the bucket that contains its effective date.
  const priceMarks = (buckets: string[]) =>
    (prices.data?.periods ?? []).flatMap((p) => {
      const from = p.effectiveFrom;
      const first = buckets[0];
      if (!from || first === undefined || from < first) return [];
      if (range.to && from > range.to) return [];
      const at = buckets.filter((b) => b <= from).at(-1);
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
          value={fmtTokens(totalTokens(t))}
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
        groups={["type", "model", "source", "project"]}
        marks={priceMarks}
      />
      <div className="pair">
        <BreakdownChart range={range} by="project" title="By project" />
        <BreakdownChart range={range} by="model" title="By model" />
      </div>
      {prices.error && (
        <p className="muted note">Price changes unavailable: {prices.error.message}</p>
      )}
    </>
  );
}
