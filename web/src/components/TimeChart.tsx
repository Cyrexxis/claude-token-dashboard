import type { Timeseries } from "@td/shared";
import { useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  BarStack,
  CartesianGrid,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { axisProps, seriesColors, shortDay } from "../chart-theme";

type Props = {
  data: Timeseries;
  kind: "bar" | "area";
  format: (n: number) => string;
  marks?: { day: string; label: string }[];
  height?: number;
  /** Series keys hidden until the legend toggles them on. */
  defaultHidden?: string[];
  /** Bucket → axis and tooltip text; defaults to "Oct 14". */
  label?: (bucket: string) => string;
  /** Bars run left to right, buckets down the side (bar charts only). */
  horizontal?: boolean;
};

type TipProps = {
  active?: boolean;
  label?: string;
  payload?: { name: string; dataKey: string; value: number; color: string }[];
  format: (n: number) => string;
  fmtLabel: (bucket: string) => string;
};
function Tip({ active, label, payload, format, fmtLabel }: TipProps) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((a, p) => a + (p.value ?? 0), 0);
  return (
    <div className="chart-tip">
      <div className="tip-head">{label && fmtLabel(label)}</div>
      {[...payload].reverse().map((p) => (
        <div key={p.dataKey} className="tip-row">
          <span className="swatch" style={{ background: p.color }} />
          <span>{p.name}</span>
          <span className="num">{format(p.value)}</span>
        </div>
      ))}
      {payload.length > 1 && (
        <div className="tip-row total">
          <span />
          <span>Total</span>
          <span className="num">{format(total)}</span>
        </div>
      )}
    </div>
  );
}

/** Stacked time chart: one stack per bucket, legend, tooltip with per-series values and the total. */
export function TimeChart({
  data,
  kind,
  format,
  marks = [],
  height = 300,
  defaultHidden = [],
  label = shortDay,
  horizontal = false,
}: Props) {
  const [hidden, setHidden] = useState(() => new Set(defaultHidden));
  if (!data.series.length) return <p className="muted empty">No data in this period.</p>;
  // Index-based keys: model and project names may contain dots, which Recharts reads as paths.
  const rows = data.buckets.map((bucket, i) => {
    const row: Record<string, string | number> = { bucket };
    data.series.forEach((s, j) => {
      row[`s${j}`] = s.values[i] ?? 0;
    });
    return row;
  });
  const toggle = (key: string) =>
    setHidden((h) => {
      const next = new Set(h);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  // j stays the index into data.series, so colors and dataKeys don't shift when a series is hidden.
  const shown = data.series.flatMap((s, j) => (hidden.has(s.key) ? [] : [{ s, j }]));
  const colors = seriesColors(data.series.map((s) => s.key));
  const axis = axisProps;
  const common = (
    <>
      <CartesianGrid vertical={horizontal} horizontal={!horizontal} stroke="var(--grid)" />
      {horizontal ? (
        <>
          <XAxis type="number" tickFormatter={format} {...axis} />
          <YAxis
            type="category"
            dataKey="bucket"
            tickFormatter={label}
            width={140}
            interval={0}
            {...axis}
          />
        </>
      ) : (
        <>
          <XAxis dataKey="bucket" tickFormatter={label} minTickGap={24} {...axis} />
          <YAxis tickFormatter={format} width={64} axisLine={false} {...axis} />
        </>
      )}
      <Tooltip
        content={<Tip format={format} fmtLabel={label} />}
        cursor={{ fill: "var(--hover)", stroke: "var(--axis)" }}
      />
      {data.series.length > 1 && (
        // Own legend: Recharts colors icons from the stroke, which is the surface (2px gaps).
        <Legend
          content={() => (
            <div className="legend">
              {data.series.map((s, j) => (
                <button
                  type="button"
                  key={s.key}
                  aria-pressed={!hidden.has(s.key)}
                  onClick={() => toggle(s.key)}
                >
                  <span className="swatch" style={{ background: colors[j] }} />
                  {s.label}
                </button>
              ))}
            </div>
          )}
        />
      )}
      {marks.map((m) => (
        <ReferenceLine
          key={`${m.day}-${m.label}`}
          x={m.day}
          stroke="var(--muted)"
          strokeDasharray="3 3"
          label={{ value: m.label, position: "insideTopLeft", fill: "var(--muted)", fontSize: 11 }}
        />
      ))}
    </>
  );
  return (
    <ResponsiveContainer width="100%" height={height}>
      {kind === "bar" ? (
        <BarChart data={rows} barCategoryGap="20%" layout={horizontal ? "vertical" : "horizontal"}>
          {common}
          {/* Rounds only the outer end of each whole stack; the axis end stays flat. */}
          <BarStack radius={horizontal ? [0, 2, 2, 0] : [2, 2, 0, 0]}>
            {shown.map(({ s, j }) => (
              <Bar
                key={s.key}
                dataKey={`s${j}`}
                name={s.label}
                fill={colors[j]}
                stroke="var(--surface)"
                strokeWidth={1}
                isAnimationActive={false}
              />
            ))}
          </BarStack>
        </BarChart>
      ) : (
        <AreaChart data={rows}>
          {common}
          {shown.map(({ s, j }) => (
            <Area
              key={s.key}
              dataKey={`s${j}`}
              name={s.label}
              stackId="a"
              type="monotone"
              fill={colors[j]}
              fillOpacity={0.85}
              stroke="var(--surface)"
              strokeWidth={2}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      )}
    </ResponsiveContainer>
  );
}
