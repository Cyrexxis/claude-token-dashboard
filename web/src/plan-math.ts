import type { PlanSnapshotPoint, PlanWindow } from "@td/shared";

export type WindowId = { kind: string; resetsAt: number };

/** The window `id` names in `all`, or null when nothing is picked or the window is gone. */
export const findWindow = (all: PlanWindow[], id: WindowId | null): PlanWindow | null =>
  (id && all.find((w) => w.kind === id.kind && w.resetsAt === id.resetsAt)) ?? null;

/**
 * One row per reading time from `start` on, each kind holding its latest value so far in its
 * current window. Readings are stored only when a value changes, so carrying it forward is exact.
 * Rows end at the last reading of any kind, so a mod that stopped reporting shows as a gap,
 * and never run past `end`: the weekly line of a past 5-hour window would stretch the axis.
 */
export function mergeReadings(
  points: PlanSnapshotPoint[],
  current: Pick<PlanWindow, "kind" | "resetsAt">[],
  start: number,
  end: number,
): Record<string, number>[] {
  const resets = new Map(current.map((w) => [w.kind, w.resetsAt]));
  const own = points.filter((p) => resets.get(p.kind) === p.resetsAt).sort((a, b) => a.ts - b.ts);
  const times = [
    ...new Set([start, ...own.filter((p) => p.ts > start && p.ts <= end).map((p) => p.ts)]),
  ];
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

/**
 * The window to show after flipping 5-hour/weekly from `from`: the week a 5-hour window starts in,
 * or for a week the `remembered` 5-hour window if it starts inside, else the week's last one.
 * Null means the current window (also when nothing matches), the same as "no pick".
 */
export function flipWindow(
  from: PlanWindow | undefined,
  all: PlanWindow[],
  remembered: WindowId | null,
): WindowId | null {
  if (!from || from.startMs === null) return null;
  const start = from.startMs;
  const inSpan = (w: PlanWindow, span: PlanWindow) =>
    w.startMs !== null &&
    span.startMs !== null &&
    w.startMs >= span.startMs &&
    w.startMs < span.resetsAt;
  let to: PlanWindow | undefined;
  if (from.kind === "five_hour")
    to = all.find(
      (w) =>
        w.kind === "seven_day" && w.startMs !== null && w.startMs <= start && start < w.resetsAt,
    );
  else {
    const inWeek = all.filter((w) => w.kind === "five_hour" && inSpan(w, from));
    to =
      inWeek.find((w) => w.resetsAt === remembered?.resetsAt) ??
      inWeek.reduce<PlanWindow | undefined>(
        (a, w) => (a && a.resetsAt > w.resetsAt ? a : w),
        undefined,
      );
  }
  return !to || to.current ? null : { kind: to.kind, resetsAt: to.resetsAt };
}

/** One page of the Windows table: a time span and the windows that start inside it. */
export type WindowPage = { fromMs: number; toMs: number; current: boolean; windows: PlanWindow[] };

/**
 * One page per weekly window, newest first, holding the 5-hour windows that start inside it (in `all`'s order).
 * shortcut: a 5-hour window outside every listed week is not shown; add an "other" page if that shows up.
 */
export function fiveHourByWeek(all: PlanWindow[]): WindowPage[] {
  return all
    .filter((w) => w.kind === "seven_day" && w.startMs !== null)
    .sort((a, b) => b.resetsAt - a.resetsAt)
    .map((week) => {
      const fromMs = week.startMs ?? 0;
      const windows = all.filter(
        (w) =>
          w.kind === "five_hour" &&
          w.startMs !== null &&
          w.startMs >= fromMs &&
          w.startMs < week.resetsAt,
      );
      return { fromMs, toMs: week.resetsAt, current: week.current, windows };
    });
}

/** One page per local calendar quarter, newest first, holding the weekly windows that start inside it. */
export function weeklyByQuarter(all: PlanWindow[], now: number): WindowPage[] {
  const quarters = new Map<number, PlanWindow[]>();
  for (const w of all) {
    if (w.kind !== "seven_day" || w.startMs === null) continue;
    const d = new Date(w.startMs);
    const q = new Date(d.getFullYear(), d.getMonth() - (d.getMonth() % 3), 1).getTime();
    quarters.set(q, [...(quarters.get(q) ?? []), w]);
  }
  return [...quarters]
    .sort(([a], [b]) => b - a)
    .map(([fromMs, windows]) => {
      const d = new Date(fromMs);
      const toMs = new Date(d.getFullYear(), d.getMonth() + 3, 1).getTime();
      return { fromMs, toMs, current: fromMs <= now && now < toMs, windows };
    });
}
