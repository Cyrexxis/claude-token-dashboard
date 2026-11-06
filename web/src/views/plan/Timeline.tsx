import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { localDay, type PlanSnapshots, type PlanWindow } from "@td/shared";
import { useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../../api";
import { axisProps, seriesColor, tooltipStyle } from "../../chart-theme";
import { mergeReadings, windowTicks } from "../../plan-math";
import { hourTick, KINDS, kindLabel, pct, useNow, when } from "./util";

const dayTick = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

/** Snapshots covering the window; the API filters by local day, so this over-fetches a little. */
function useWindowPoints(w: PlanWindow) {
  const range = { from: localDay(new Date(w.startMs ?? 0)), to: localDay(new Date(w.resetsAt)) };
  return useQuery({
    queryKey: ["plan", "snapshots", range],
    queryFn: ({ signal }) => api<PlanSnapshots>("/plan/snapshots", range, { signal }),
    // Keeps the old chart's height while the next window loads, so the page doesn't jump.
    placeholderData: keepPreviousData,
  });
}

/** The 5-hour view also shows the weekly line; the weekly view shows only itself. */
export function Timeline({ w, current }: { w: PlanWindow; current: PlanWindow[] }) {
  const now = useNow();
  // The weekly window's range also holds the weekly reading that carries into a 5-hour window.
  const points = useWindowPoints(current.find((c) => c.kind === "seven_day") ?? w);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set(["seven_day"]));
  if (points.error) return <p className="error">{points.error.message}</p>;
  if (!points.data) return <p className="muted">Loading…</p>;
  const start = w.startMs ?? 0;
  const rows = mergeReadings(points.data.points, current, start, w.resetsAt);
  const shown = w.kind === "five_hour" ? KINDS : [w.kind];
  const axis = axisProps;
  const color = (k: string) => seriesColor(k, (KINDS as readonly string[]).indexOf(k));
  const toggle = (k: string) =>
    setHidden((h) => {
      const next = new Set(h);
      if (!next.delete(k)) next.add(k);
      return next;
    });
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={rows}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis
          {...axis}
          dataKey="ts"
          type="number"
          scale="time"
          domain={[start, w.resetsAt]}
          ticks={windowTicks(w.kind, start, w.resetsAt)}
          tickFormatter={w.kind === "five_hour" ? hourTick : dayTick}
        />
        <YAxis {...axis} domain={[0, 100]} tickFormatter={(v) => `${v}%`} width={44} />
        <Tooltip
          labelFormatter={(v) => when(Number(v))}
          formatter={(v) => pct(Number(v))}
          contentStyle={tooltipStyle}
        />
        {shown.length > 1 ? (
          // Same clickable legend as TimeChart, so the weekly line can be switched off.
          <Legend
            content={() => (
              <div className="legend">
                {shown.map((k) => (
                  <button
                    type="button"
                    key={k}
                    aria-pressed={!hidden.has(k)}
                    onClick={() => toggle(k)}
                  >
                    <span className="swatch" style={{ background: color(k) }} />
                    {kindLabel(k)}
                  </button>
                ))}
              </div>
            )}
          />
        ) : (
          <Legend />
        )}
        <ReferenceLine
          x={now}
          stroke="var(--muted)"
          strokeDasharray="3 3"
          label={{ value: "now", position: "insideTopRight", fill: "var(--muted)", fontSize: 11 }}
        />
        {shown.map((k) => (
          <Line
            key={k}
            dataKey={k}
            name={kindLabel(k)}
            type="stepAfter"
            stroke={color(k)}
            // The weekly view has a plain legend, so nothing can be hidden there.
            hide={shown.length > 1 && hidden.has(k)}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
