import { expect, test } from "bun:test";
import { mergeReadings, windowTicks } from "../src/views/Plan";

const H = 3_600_000;
const pt = (ts: number, kind: string, percentUsed: number, resetsAt: number) => ({
  ts,
  kind,
  percentUsed,
  resetsAt,
});

test("mergeReadings: shared rows, values carried forward, other windows ignored, ends at last reading", () => {
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
    ],
    cur,
    start,
  );
  expect(rows).toEqual([
    { ts: 10 * H, seven_day: 5 },
    { ts: 11 * H, seven_day: 5, five_hour: 10 },
    { ts: 12 * H, seven_day: 7, five_hour: 10 },
    { ts: 13 * H, seven_day: 7, five_hour: 20 },
  ]); // ends at the last reading, not at now
});

test("windowTicks: whole hours for 5 hours, local midnights for a week", () => {
  const start = new Date(2026, 10, 1, 13, 30).getTime();
  const hours = windowTicks("five_hour", start, start + 5 * H);
  expect(hours.map((t) => new Date(t).getHours())).toEqual([14, 15, 16, 17, 18]);
  const days = windowTicks("seven_day", start, start + 7 * 24 * H);
  expect(days).toHaveLength(7);
  expect(days.every((t) => new Date(t).getHours() === 0)).toBe(true);
});
