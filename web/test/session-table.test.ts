import { expect, test } from "bun:test";
import type { SessionRow } from "@td/shared";
import { sortSessions } from "../src/session-sort";

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
