import { useQuery } from "@tanstack/react-query";
import type { Bucket, Group, Metric, Timeseries } from "@td/shared";
import { useState } from "react";
import { api } from "../api";
import { TimeChart } from "../components/TimeChart";
import { autoBucket, fmtTokens, fmtUsd, type Range } from "../format";

const BUCKETS: Bucket[] = ["day", "week", "month"];
const LABELS: Record<Group, string> = {
  type: "Token type",
  model: "Model",
  source: "Source",
  project: "Project",
};

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
  groups: Group[];
  title: string;
  marks?: (buckets: string[]) => { day: string; label: string }[];
  defaultHidden?: string[];
}) {
  const [group, setGroup] = useState<Group>(groups[0]);
  const [picked, setPicked] = useState<Bucket | null>(null);
  const bucket = picked ?? autoBucket(range);
  const params = { ...range, metric, group, bucket };
  const q = useQuery({
    queryKey: ["timeseries", params],
    queryFn: () => api<Timeseries>("/timeseries", params),
  });
  return (
    <section className="card">
      <div className="toolbar">
        <h2 style={{ margin: 0, flex: 1 }}>{title}</h2>
        <label>
          Group by{" "}
          <select value={group} onChange={(e) => setGroup(e.target.value as Group)}>
            {groups.map((g) => (
              <option key={g} value={g}>
                {LABELS[g]}
              </option>
            ))}
          </select>
        </label>
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
