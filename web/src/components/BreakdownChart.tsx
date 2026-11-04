import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Timeseries } from "@td/shared";
import { useState } from "react";
import { api } from "../api";
import { fmtTokens, fmtUsd, type Range } from "../format";
import { TimeChart } from "./TimeChart";
import { type ChartMetric, GroupSelect, MetricToggle } from "./Toggle";

const same = (b: string) => b;

/** Range totals per top project or model as horizontal stacked bars, split by type or the other. */
export function BreakdownChart({
  range,
  by,
  title,
}: {
  range: Range;
  by: "project" | "model";
  title: string;
}) {
  const [metric, setMetric] = useState<ChartMetric>("tokens");
  const [group, setGroup] = useState<"type" | "project" | "model">("type");
  const params = { ...range, metric, by, group };
  const q = useQuery({
    queryKey: ["breakdown", params],
    queryFn: ({ signal }) => api<Timeseries>("/breakdown", params, { signal }),
    placeholderData: keepPreviousData,
  });
  return (
    <section className="card">
      <div className="toolbar">
        <h2 className="card-title">{title}</h2>
        <MetricToggle value={metric} onChange={setMetric} />
        <GroupSelect
          value={group}
          groups={["type", by === "project" ? "model" : "project"]}
          onChange={setGroup}
        />
      </div>
      {q.error && <p className="error">{q.error.message}</p>}
      {!q.data && !q.error && <p className="muted">Loading…</p>}
      {q.data && (
        <TimeChart
          // Remount per metric so the cache-read default applies to tokens only.
          key={metric}
          data={q.data}
          kind="bar"
          horizontal
          height={q.data.buckets.length * 40 + 80}
          format={metric === "cost" ? fmtUsd : fmtTokens}
          label={same}
          // Cache reads dwarf every other type and would flatten the chart.
          defaultHidden={metric === "tokens" ? ["cacheRead"] : []}
        />
      )}
    </section>
  );
}
