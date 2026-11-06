/** Fixed categorical order (dataviz reference palette); "other" is always neutral gray. */
export const SERIES_VARS = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);
export const seriesColor = (key: string, i: number) =>
  key === "other" ? "var(--series-other)" : SERIES_VARS[i % SERIES_VARS.length];

/** Token types keep fixed slots, picked for the usual view: output and cache write 1h get blue and orange. */
const TYPE_SLOT: Record<string, number> = {
  output: 0,
  cacheWrite1h: 1,
  cacheRead: 2,
  input: 3,
  cacheWrite5m: 4,
};
/** One chart's series colors: by token type when every series is one, else in fixed order. */
export const seriesColors = (keys: string[]) =>
  keys.length > 0 && keys.every((k) => Object.hasOwn(TYPE_SLOT, k))
    ? keys.map((k) => SERIES_VARS[TYPE_SLOT[k] as number])
    : keys.map((k, i) => seriesColor(k, i));

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
