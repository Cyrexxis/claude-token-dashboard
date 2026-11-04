import { expect, test } from "bun:test";
import {
  findWindow,
  fiveHourByWeek,
  flipWindow,
  mergeReadings,
  overlappingWeekly,
  weeklyByQuarter,
  windowTicks,
} from "../src/plan-math";

const H = 3_600_000;
const pt = (ts: number, kind: string, percentUsed: number, resetsAt: number, seenTs = ts) => ({
  ts,
  seenTs,
  kind,
  percentUsed,
  resetsAt,
});

test("mergeReadings: shared rows, values carried forward, other windows ignored, ends at last reading within the window", () => {
  const start = 10 * H;
  const cur = [
    { kind: "five_hour", resetsAt: 15 * H },
    { kind: "seven_day", resetsAt: 100 * H },
  ];
  const rows = mergeReadings(
    [
      pt(1 * H, "seven_day", 5, 100 * H), // before the 5h window: carries in
      pt(9 * H, "five_hour", 80, 10 * H), // previous 5h window: dropped
      pt(11 * H, "five_hour", 10, 15 * H),
      pt(12 * H, "seven_day", 7, 100 * H),
      pt(13 * H, "five_hour", 20, 15 * H),
      pt(16 * H, "seven_day", 9, 100 * H), // after the 5h window ends: dropped
    ],
    cur,
    start,
    15 * H,
  );
  expect(rows).toEqual([
    { ts: 10 * H, seven_day: 5 },
    { ts: 11 * H, seven_day: 5, five_hour: 10 },
    { ts: 12 * H, seven_day: 7, five_hour: 10 },
    { ts: 13 * H, seven_day: 7, five_hour: 20 },
  ]); // ends at the last reading, not at now
});

test("mergeReadings: a value confirmed unchanged draws on to its last confirmation, capped at the end", () => {
  const cur = [
    { kind: "five_hour", resetsAt: 15 * H },
    { kind: "seven_day", resetsAt: 100 * H },
  ];
  const rows = mergeReadings(
    [
      pt(9 * H, "seven_day", 5, 100 * H, 14 * H),
      pt(11 * H, "five_hour", 10, 15 * H, 12 * H),
      pt(13 * H, "five_hour", 20, 15 * H, 16 * H), // confirmed after the window: capped
    ],
    cur,
    10 * H,
    15 * H,
  );
  expect(rows).toEqual([
    { ts: 10 * H, seven_day: 5 },
    { ts: 11 * H, seven_day: 5, five_hour: 10 },
    { ts: 12 * H, seven_day: 5, five_hour: 10 },
    { ts: 13 * H, seven_day: 5, five_hour: 20 },
    { ts: 14 * H, seven_day: 5, five_hour: 20 },
  ]);
});

test("windowTicks: whole hours for 5 hours, local midnights for a week", () => {
  const start = new Date(2026, 10, 1, 13, 30).getTime();
  const hours = windowTicks("five_hour", start, start + 5 * H);
  expect(hours.map((t) => new Date(t).getHours())).toEqual([14, 15, 16, 17, 18]);
  const days = windowTicks("seven_day", start, start + 7 * 24 * H);
  expect(days).toHaveLength(7);
  expect(days.every((t) => new Date(t).getHours() === 0)).toBe(true);
});

test("overlappingWeekly: weekly windows that overlap a 5-hour window; none for a weekly one", () => {
  const win = (kind: string, startMs: number | null, resetsAt: number) =>
    ({ kind, startMs, resetsAt }) as Parameters<typeof overlappingWeekly>[0];
  const five = win("five_hour", 10 * H, 15 * H);
  const inside = win("seven_day", 0, 100 * H);
  const before = win("seven_day", -168 * H, 0);
  const straddle = win("seven_day", 12 * H, 180 * H);
  expect(overlappingWeekly(five, [five, inside, before, straddle])).toEqual([inside, straddle]);
  expect(overlappingWeekly(inside, [five, inside])).toEqual([]);
});

test("flipWindow: 5-hour to its week, week to the remembered or last 5-hour window; current is null", () => {
  const win = (kind: string, startMs: number, resetsAt: number, current = false) =>
    ({ kind, startMs, resetsAt, current }) as Parameters<typeof flipWindow>[1][number];
  const oldWeek = win("seven_day", 0, 168 * H);
  const nowWeek = win("seven_day", 168 * H, 336 * H, true);
  const a = win("five_hour", 10 * H, 15 * H);
  const b = win("five_hour", 20 * H, 25 * H);
  const c = win("five_hour", 200 * H, 205 * H);
  const live = win("five_hour", 210 * H, 215 * H, true);
  const all = [oldWeek, nowWeek, a, b, c, live];
  const id = (w: { kind: string; resetsAt: number }) => ({ kind: w.kind, resetsAt: w.resetsAt });
  expect(flipWindow(a, all, null)).toEqual(id(oldWeek));
  expect(flipWindow(c, all, null)).toBeNull(); // its week is the current one
  expect(flipWindow(oldWeek, all, id(a))).toEqual(id(a));
  expect(flipWindow(oldWeek, all, id(c))).toEqual(id(b)); // remembered is in another week
  expect(flipWindow(nowWeek, all, id(c))).toEqual(id(c));
  expect(flipWindow(nowWeek, all, null)).toBeNull(); // last one is the live window
  expect(flipWindow(undefined, all, null)).toBeNull();
});

test("findWindow: looks a picked window up by identity; null when gone or unpicked", () => {
  const win = (kind: string, resetsAt: number) =>
    ({ kind, startMs: resetsAt - 5 * H, resetsAt }) as Parameters<typeof overlappingWeekly>[0];
  const a = win("five_hour", 15 * H);
  const b = win("seven_day", 15 * H);
  expect(findWindow([a, b], { kind: "seven_day", resetsAt: 15 * H })).toBe(b);
  expect(findWindow([a, b], { kind: "five_hour", resetsAt: 20 * H })).toBeNull();
  expect(findWindow([a, b], null)).toBeNull();
});

test("fiveHourByWeek: weeks newest first, 5-hour windows grouped by where they start", () => {
  const win = (kind: string, startMs: number | null, resetsAt: number, current = false) =>
    ({ kind, startMs, resetsAt, current }) as Parameters<typeof fiveHourByWeek>[0][number];
  const thisWeek = win("seven_day", 168 * H, 336 * H, true);
  const lastWeek = win("seven_day", 0, 168 * H);
  const late = win("five_hour", 200 * H, 205 * H);
  const straddle = win("five_hour", 166 * H, 171 * H); // starts last week, resets this week
  const early = win("five_hour", 10 * H, 15 * H);
  const spend = win("seven_day", null, 400 * H); // no known start: not a page
  expect(fiveHourByWeek([late, lastWeek, straddle, thisWeek, early, spend])).toEqual([
    { fromMs: 168 * H, toMs: 336 * H, current: true, windows: [late] },
    { fromMs: 0, toMs: 168 * H, current: false, windows: [straddle, early] },
  ]);
});

test("weeklyByQuarter: local calendar quarters newest first, weeks grouped by where they start", () => {
  const week = (y: number, m: number, d: number) => {
    const startMs = new Date(y, m, d).getTime();
    return { kind: "seven_day", startMs, resetsAt: startMs + 168 * H } as Parameters<
      typeof weeklyByQuarter
    >[0][number];
  };
  const q4a = week(2026, 9, 1);
  const q4b = week(2026, 11, 29); // resets in January: still Q4
  const q3 = week(2026, 6, 15);
  const five = { ...week(2026, 9, 2), kind: "five_hour" };
  const now = new Date(2026, 10, 4).getTime();
  expect(weeklyByQuarter([q4b, five, q3, q4a], now)).toEqual([
    {
      fromMs: new Date(2026, 9, 1).getTime(),
      toMs: new Date(2027, 0, 1).getTime(),
      current: true,
      windows: [q4b, q4a],
    },
    {
      fromMs: new Date(2026, 6, 1).getTime(),
      toMs: new Date(2026, 9, 1).getTime(),
      current: false,
      windows: [q3],
    },
  ]);
});
