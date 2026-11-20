import { expect, test } from "bun:test";
import type { SessionRow } from "@td/shared";
import { percentCols, sortSessions } from "../src/session-sort";

const row = (id: string, title: string | null, lastTs: number, costUsd: number) =>
  ({ id, title, lastTs, costUsd }) as SessionRow;
const rows = [row("a", "beta", 2, 5), row("b", null, 3, 1), row("c", "alpha", 1, 9)];
const ids = (r: SessionRow[]) => r.map((s) => s.id);

test("sorts by last active, title (falls back to id) and cost, both directions", () => {
  expect(ids(sortSessions(rows, "lastActive", true))).toEqual(["b", "a", "c"]);
  expect(ids(sortSessions(rows, "title", false))).toEqual(["c", "b", "a"]);
  expect(ids(sortSessions(rows, "cost", true))).toEqual(["c", "a", "b"]);
  expect(ids(rows)).toEqual(["a", "b", "c"]);
});

test("percent columns: whole-session 5h/weekly, or a window's part at its rate", () => {
  const withPct = [
    { ...row("a", "x", 1, 2), planPercent: { five_hour: 3, seven_day: null } },
    { ...row("b", "y", 2, 4), planPercent: { five_hour: 12.345, seven_day: 1 } },
  ] as SessionRow[];
  const [five, week] = percentCols();
  expect(withPct.map((s) => five?.show?.(s))).toEqual(["3.0 %", "12 %"]);
  expect(withPct.map((s) => week?.show?.(s))).toEqual(["—", "1.0 %"]);
  expect(ids(sortSessions(withPct, "weekly", true, percentCols()))).toEqual(["b", "a"]);
  const [est] = percentCols(0.5);
  expect(withPct.map((s) => est?.show?.(s))).toEqual(["4.0 %", "8.0 %"]);
  expect(percentCols(null)[0]?.show?.(withPct[0] as SessionRow)).toBe("—");
});
