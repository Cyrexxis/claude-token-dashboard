const M = 60_000;
const LARGEST = { ms: 24 * 60 * M, label: "1-day" };
/** Slot sizes for a session chart, smallest first. */
const STEPS = [
  { ms: M, label: "1-minute" },
  { ms: 5 * M, label: "5-minute" },
  { ms: 15 * M, label: "15-minute" },
  { ms: 60 * M, label: "1-hour" },
  { ms: 3 * 60 * M, label: "3-hour" },
  LARGEST,
];

/** Smallest slot that keeps a session of this length to at most 60 bars. */
export const pickStep = (durationMs: number): number =>
  (STEPS.find((s) => durationMs / s.ms < 60) ?? LARGEST).ms;
export const stepLabel = (ms: number): string => STEPS.find((s) => s.ms === ms)?.label ?? "";

/** Start of the local-time slot holding `ts`, so hour and day slots begin on the clock. */
export function slotStart(ts: number, step: number): number {
  const local = -new Date(ts).getTimezoneOffset() * M;
  return ts - ((ts + local) % step);
}
