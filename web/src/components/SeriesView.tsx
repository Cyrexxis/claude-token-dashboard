import { useQuery } from "@tanstack/react-query";
import { BUCKETS, type Bucket, type Metric, type RollupGroup, type Timeseries } from "@td/shared";
import { useState } from "react";
import { api } from "../api";
import { autoBucket, fmtTokens, fmtUsd, type Range } from "../format";
import { TimeChart } from "./TimeChart";
import { GroupSelect } from "./Toggle";

/** Group + bucket selectors over one stacked bar chart. */
export function SeriesView({
  range,
  metric,
  groups,
  title,
  marks,
  defaultHidden,
}: {
  range: Range;
  metric: Metric;
  groups: [RollupGroup, ...RollupGroup[]]; // the first is the initial choice
  title: string;
  marks?: (buckets: string[]) => { day: string; label: string }[];
  defaultHidden?: string[];
}) {
  const [group, setGroup] = useState<RollupGroup>(groups[0]);
  const [picked, setPicked] = useState<Bucket | null>(null);
  const bucket = picked ?? autoBucket(range);
  const params = { ...range, metric, group, bucket };
  const q = useQuery({
    queryKey: ["timeseries", params],
    queryFn: ({ signal }) => api<Timeseries>("/timeseries", params, { signal }),
  });
  return (
    <section className="card">
      <div className="toolbar">
        <h2 className="card-title">{title}</h2>
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
      </div>
      {q.error && <p className="error">{q.error.message}</p>}
      {q.data && (
        <TimeChart
          data={q.data}
          kind="bar"
          height={380}
          format={metric === "cost" ? fmtUsd : fmtTokens}
          marks={marks?.(q.data.buckets)}
          defaultHidden={defaultHidden}
        />
      )}
      {!q.data && !q.error && <p className="muted">Loading…</p>}
    </section>
  );
}
