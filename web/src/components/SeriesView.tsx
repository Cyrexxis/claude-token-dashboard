import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { BUCKETS, type Bucket, type RollupGroup, type Timeseries } from "@td/shared";
import { useState } from "react";
import { api } from "../api";
import { autoBucket, fmtTokens, fmtUsd, type Range } from "../format";
import { ChartCard } from "./ChartCard";
import { TimeChart } from "./TimeChart";
import { type ChartMetric, GroupSelect, MetricToggle } from "./Toggle";

const TITLE: Record<ChartMetric, string> = {
  tokens: "Tokens",
  cost: "API-equivalent cost at historical prices",
};
/** The last picked metric, per browser; blocked storage just means "tokens". */
const METRIC_KEY = "td:series-metric";
function loadMetric(): ChartMetric {
  try {
    return localStorage.getItem(METRIC_KEY) === "cost" ? "cost" : "tokens";
  } catch {
    return "tokens";
  }
}
function saveMetric(m: ChartMetric): void {
  try {
    localStorage.setItem(METRIC_KEY, m);
  } catch {
    // Not saved: the switch still works for this visit.
  }
}

/** Tokens/cost switch, group + bucket selectors over one stacked bar chart. */
export function SeriesView({
  range,
  groups,
  marks,
}: {
  range: Range;
  groups: [RollupGroup, ...RollupGroup[]]; // the first is the initial choice
  /** Shown on the cost chart only. */
  marks?: (buckets: string[]) => { day: string; label: string }[];
}) {
  const [metric, setMetric] = useState(loadMetric);
  const [group, setGroup] = useState<RollupGroup>(groups[0]);
  const [picked, setPicked] = useState<Bucket | null>(null);
  const bucket = picked ?? autoBucket(range);
  const params = { ...range, metric, group, bucket };
  const q = useQuery({
    queryKey: ["timeseries", params],
    // Tagged with its metric: while a switch loads, the old bars stay up and keep their own labels.
    queryFn: async ({ signal }) => ({
      metric,
      series: await api<Timeseries>("/timeseries", params, { signal }),
    }),
    placeholderData: keepPreviousData,
  });
  const shown = q.data?.metric ?? metric;
  return (
    <ChartCard
      // One widen setting for both metrics, so switching never resizes; reuses the old tokens chart's key.
      id="series-tokens"
      title={TITLE[shown]}
      controls={
        <>
          <MetricToggle
            value={metric}
            onChange={(m) => {
              setMetric(m);
              saveMetric(m);
            }}
          />
          <GroupSelect value={group} groups={groups} onChange={setGroup} />
          <label>
            Per{" "}
            <select value={bucket} onChange={(e) => setPicked(e.target.value as Bucket)}>
              {BUCKETS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
        </>
      }
    >
      {q.error && <p className="error">{q.error.message}</p>}
      {q.data && (
        <TimeChart
          // Remount per metric so the cache-read default applies to tokens only.
          key={shown}
          data={q.data.series}
          kind="bar"
          height={380}
          format={shown === "cost" ? fmtUsd : fmtTokens}
          marks={shown === "cost" ? marks?.(q.data.series.buckets) : undefined}
          // Cache reads dwarf every other type and would flatten the chart.
          defaultHidden={shown === "tokens" ? ["cacheRead"] : []}
        />
      )}
      {!q.data && !q.error && <p className="muted">Loading…</p>}
    </ChartCard>
  );
}
