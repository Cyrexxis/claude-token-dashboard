import type { PlanSnapshotPoint, PlanWindow } from "@td/shared";

export type WindowId = { kind: string; resetsAt: number };

/** The window `id` names in `all`, or null when nothing is picked or the window is gone. */
export const findWindow = (all: PlanWindow[], id: WindowId | null): PlanWindow | null =>
  (id && all.find((w) => w.kind === id.kind && w.resetsAt === id.resetsAt)) ?? null;

/**
 * One row per reading time from `start` on, each kind holding its latest value so far in its
 * current window. Readings are stored only when a value changes, so carrying it forward is exact.
 * Rows end at the last reading of any kind, so a mod that stopped reporting shows as a gap.
 */
export function mergeReadings(
  points: PlanSnapshotPoint[],
  current: Pick<PlanWindow, "kind" | "resetsAt">[],
  start: number,
): Record<string, number>[] {
  const resets = new Map(current.map((w) => [w.kind, w.resetsAt]));
  const own = points.filter((p) => resets.get(p.kind) === p.resetsAt).sort((a, b) => a.ts - b.ts);
  const times = [...new Set([start, ...own.filter((p) => p.ts > start).map((p) => p.ts)])];
  const last: Record<string, number> = {};
  let i = 0;
  return times.map((ts) => {
    for (let p = own[i]; p && p.ts <= ts; p = own[++i]) last[p.kind] = p.percentUsed;
    return { ...last, ts };
  });
}

/** Whole hours for the 5-hour window, local midnights for the weekly one. */
export function windowTicks(kind: string, start: number, end: number): number[] {
  const t = new Date(start);
  if (kind === "five_hour") t.setMinutes(0, 0, 0);
  else t.setHours(0, 0, 0, 0);
  const out: number[] = [];
  for (
    ;
    t.getTime() <= end;
    kind === "five_hour" ? t.setHours(t.getHours() + 1) : t.setDate(t.getDate() + 1)
  )
    if (t.getTime() >= start) out.push(t.getTime());
  return out;
}

/** Weekly windows overlapping `w` (a 5-hour window); none for a weekly window. */
export function overlappingWeekly(w: PlanWindow, all: PlanWindow[]): PlanWindow[] {
  if (w.kind !== "five_hour" || w.startMs === null) return [];
  const start = w.startMs;
  return all.filter(
    (x) =>
      x.kind === "seven_day" && x.startMs !== null && x.startMs < w.resetsAt && start < x.resetsAt,
  );
}
