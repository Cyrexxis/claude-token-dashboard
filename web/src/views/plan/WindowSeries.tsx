import { keepPreviousData, skipToken, useQuery } from "@tanstack/react-query";
import type { Group, PlanWindow, Timeseries } from "@td/shared";
import { useState } from "react";
import { api } from "../../api";
import { ChartCard } from "../../components/ChartCard";
import { TimeChart } from "../../components/TimeChart";
import { GroupSelect, MetricToggle } from "../../components/Toggle";
import { fmtTokens, fmtUsd } from "../../format";
import { dayTime, hourTick, type Kind, kindLabel } from "./util";

const STEP_MS: Record<Kind, number> = { five_hour: 5 * 60_000, seven_day: 3 * 3_600_000 };

const GROUPS: Group[] = ["type", "model", "source", "project"];

const slotLabel = (kind: Kind) => (b: string) =>
  kind === "five_hour" ? hourTick(Number(b)) : dayTime(Number(b));

/** Tokens or cost in the current window, 5-minute slots for 5-hour, 3-hour slots for weekly. */
export function WindowSeries({
  current,
  picked,
  kind,
}: {
  current: PlanWindow[];
  picked: PlanWindow | null;
  kind: Kind;
}) {
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const [group, setGroup] = useState<Group>("type");
  const w = picked ?? current.find((c) => c.kind === kind && c.startMs !== null);
  const params = w && {
    fromMs: w.startMs ?? 0,
    toMs: w.resetsAt,
    stepMs: STEP_MS[kind],
    metric,
    group,
  };
  const q = useQuery({
    queryKey: ["plan", "timeseries", params],
    queryFn: params
      ? ({ signal }) => api<Timeseries>("/plan/timeseries", params, { signal })
      : skipToken,
    placeholderData: keepPreviousData,
  });
  return (
    <ChartCard
      id="plan-series"
      title={`${metric === "tokens" ? "Tokens" : "API-equivalent cost"} in the ${picked ? "selected" : "current"} window`}
      controls={
        <>
          <MetricToggle value={metric} onChange={setMetric} />
          <GroupSelect value={group} groups={GROUPS} onChange={setGroup} />
        </>
      }
    >
      {!w && <p className="muted empty">No current {kindLabel(kind)} window.</p>}
      {q.error && <p className="error">{q.error.message}</p>}
      {w && !q.data && !q.error && <p className="muted">Loading…</p>}
      {w && q.data && (
        <TimeChart
          // Remount per metric so the cache-read default applies to tokens only.
          key={metric}
          data={q.data}
          kind="bar"
          height={320}
          format={metric === "cost" ? fmtUsd : fmtTokens}
          label={slotLabel(kind)}
          // Cache reads dwarf every other type and would flatten the chart.
          defaultHidden={metric === "tokens" ? ["cacheRead"] : []}
        />
      )}
    </ChartCard>
  );
}
