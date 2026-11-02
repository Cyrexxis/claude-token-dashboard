/** Fixed categorical order (dataviz reference palette); "other" is always neutral gray. */
export const SERIES_VARS = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);
export const seriesColor = (key: string, i: number) =>
  key === "other" ? "var(--series-other)" : SERIES_VARS[i % SERIES_VARS.length];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const shortDay = (day: string) =>
  `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;

/** Shared Recharts axis look. */
export const axisProps = {
  stroke: "var(--axis)",
  tick: { fill: "var(--muted)", fontSize: 12 },
  tickLine: false,
};
/** Recharts default tooltip box, themed. */
export const tooltipStyle = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 12,
};
