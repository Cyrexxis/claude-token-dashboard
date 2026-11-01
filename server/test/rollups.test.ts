import { expect, test } from "bun:test";
import { openDatabase } from "../src/db/database";
import { rebuildRollups } from "../src/rollups";
import { all, insertRequest, one } from "./db-helpers";

const D1 = Date.parse("2026-10-15T12:00:00Z");
const D2 = Date.parse("2026-10-16T12:00:00Z");

function seeded() {
  const db = openDatabase(":memory:");
  db.run("insert into sessions (id, project) values ('s1', '-home-user-demo')");
  insertRequest(db, { session_id: "s1", ts: D1, model: "a", input: 1, output: 10, cost_usd: 0.5 });
  insertRequest(db, {
    session_id: "s1",
    ts: D1 + 1000,
    model: "b",
    input: 2,
    output: 20,
    cost_usd: null,
  });
  insertRequest(db, {
    session_id: "nosession",
    ts: D2,
    model: "a",
    input: 3,
    output: 30,
    cost_usd: 1,
  });
  return db;
}

test("day buckets and sums equal request sums", () => {
  const db = seeded();
  rebuildRollups(db, "all");
  const rows = all<{
    day: string;
    model: string;
    project: string;
    output: number;
    request_count: number;
    cost_usd: number;
  }>(
    db,
    "select day, model, project, output, request_count, cost_usd from daily_rollups order by day, model",
  );
  expect(rows).toEqual([
    {
      day: "2026-10-15",
      model: "a",
      project: "-home-user-demo",
      output: 10,
      request_count: 1,
      cost_usd: 0.5,
    },
    {
      day: "2026-10-15",
      model: "b",
      project: "-home-user-demo",
      output: 20,
      request_count: 1,
      cost_usd: 0,
    },
    { day: "2026-10-16", model: "a", project: "", output: 30, request_count: 1, cost_usd: 1 },
  ]);
  const sum = (sql: string) => one<{ s: number }>(db, sql).s;
  expect(sum("select sum(output) s from daily_rollups")).toBe(
    sum("select sum(output) s from requests"),
  );
  expect(sum("select sum(request_count) s from daily_rollups")).toBe(3);
});

test("rebuild for a range leaves other days untouched", () => {
  const db = seeded();
  rebuildRollups(db, "all");
  db.run("update daily_rollups set output = 999 where day = '2026-10-16'");
  db.run("update requests set output = 11 where model = 'a' and ts = ?", [D1]);
  rebuildRollups(db, { from: D1, to: D1 + 1000 });
  expect(
    one<{ output: number }>(
      db,
      "select output from daily_rollups where day = '2026-10-15' and model = 'a'",
    ).output,
  ).toBe(11);
  expect(
    one<{ output: number }>(db, "select output from daily_rollups where day = '2026-10-16'").output,
  ).toBe(999);
});

test("rebuild removes days whose requests are gone", () => {
  const db = seeded();
  rebuildRollups(db, "all");
  db.run("delete from requests where ts = ?", [D2]);
  rebuildRollups(db, { from: D2, to: D2 });
  expect(
    one<{ n: number }>(db, "select count(*) n from daily_rollups where day = '2026-10-16'").n,
  ).toBe(0);
});
