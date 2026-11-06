import { useQuery } from "@tanstack/react-query";
import type { SessionDetail as Detail, Group, Timeseries } from "@td/shared";
import { useState } from "react";
import { api } from "../../api";
import { ChartCard } from "../../components/ChartCard";
import { TimeChart } from "../../components/TimeChart";
import { GroupSelect, MetricToggle } from "../../components/Toggle";
import { fmtTokens, fmtUsd } from "../../format";
import { pickStep, slotStart, stepLabel } from "../../session-math";

const hhmm = (b: string) =>
  new Date(Number(b)).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const dayHour = (b: string) =>
  new Date(Number(b)).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** Tokens or cost over the session's lifetime, sub-agents included; slot size follows its length. */
export function SessionSeries({ s }: { s: Detail["session"] }) {
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const [group, setGroup] = useState<Group>("type");
  const first = s.firstTs ?? 0;
  const last = s.lastTs ?? first;
  const stepMs = pickStep(last - first);
  const params = {
    sessionId: s.id,
    fromMs: slotStart(first, stepMs),
    toMs: last + 1,
    stepMs,
    metric,
    group,
  };
  const q = useQuery({
    queryKey: ["session", s.id, "timeseries", params],
    queryFn: ({ signal }) => api<Timeseries>("/plan/timeseries", params, { signal }),
    // Keep the chart while a live session grows, but never show another session's data.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === s.id ? prev : undefined),
  });
  const multiDay = new Date(first).toDateString() !== new Date(last).toDateString();
  return (
    <ChartCard
      id="session-series"
      title={`${metric === "tokens" ? "Tokens" : "API-equivalent cost"} over the session`}
      controls={
        <>
          <MetricToggle value={metric} onChange={setMetric} />
          <GroupSelect value={group} groups={["type", "agent"] as const} onChange={setGroup} />
        </>
      }
    >
      {q.error && <p className="error">{q.error.message}</p>}
      {!q.data && !q.error && <p className="muted">Loading…</p>}
      {q.data && (
        <TimeChart
          // Remount per metric and group so the cache-read default applies to tokens by type only.
          key={`${metric}-${group}`}
          data={q.data}
          kind="bar"
          height={320}
          format={metric === "cost" ? fmtUsd : fmtTokens}
          label={multiDay ? dayHour : hhmm}
          // Cache reads dwarf every other type and would flatten the chart.
          defaultHidden={metric === "tokens" && group === "type" ? ["cacheRead"] : []}
        />
      )}
      <p className="muted note">Includes sub-agents; {stepLabel(stepMs)} slots.</p>
    </ChartCard>
  );
}
