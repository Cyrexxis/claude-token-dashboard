import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SCHEMA_VERSION } from "../src/db/database";
import m0001 from "../src/db/migrations/0001_init.sql" with { type: "text" };

const tmp = () => mkdtempSync(join(tmpdir(), "td-db-"));
const tableNames = (db: Database) =>
  db
    .query<{ name: string }, []>("select name from sqlite_master where type = 'table'")
    .all()
    .map((r) => r.name);
const count = (db: Database, t: string) =>
  db.query<{ n: number }, []>(`select count(*) as n from ${t}`).get()?.n;

test("fresh db has all tables, WAL, FKs, latest user_version", () => {
  const db = openDatabase(join(tmp(), "sub", "a.db"));
  expect(tableNames(db)).toEqual(
    expect.arrayContaining([
      "requests",
      "sessions",
      "files",
      "sources",
      "price_periods",
      "cost_states",
      "daily_rollups",
      "plan_snapshots",
      "plan_windows",
      "live_usage",
      "settings",
      "installations",
    ]),
  );
  expect(db.query("pragma journal_mode").get()).toEqual({ journal_mode: "wal" });
  expect(db.query("pragma foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(db.query("pragma user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
  db.close();
});

test("reopening is idempotent", () => {
  const p = join(tmp(), "a.db");
  openDatabase(p).close();
  const db = openDatabase(p);
  expect(count(db, "installations")).toBe(1);
  expect(db.query("select schema_version as v from installations").get()).toEqual({
    v: SCHEMA_VERSION,
  });
  db.close();
});

test("migration 2 adds cost columns and forces a full reprice", () => {
  const p = join(tmp(), "a.db");
  const old = new Database(p);
  old.run(m0001);
  old.run("PRAGMA user_version = 1");
  old.run("INSERT INTO settings (key, value) VALUES ('prices_hash', 'x')");
  old.close();
  const db = openDatabase(p);
  expect(db.query("select cost_input, cost_web_search from requests").all()).toEqual([]);
  expect(db.query("select cost_input from daily_rollups").all()).toEqual([]);
  expect(db.query("select value from settings where key = 'prices_hash'").get()).toBeNull();
  db.close();
});

test("request_id '' keeps UNIQUE effective", () => {
  const db = openDatabase(":memory:");
  const ins = () => db.run("insert into requests (message_id, ts) values ('m1', 1)");
  ins();
  expect(ins).toThrow(/UNIQUE/);
});

test("sessions carry the title and agent metadata columns", () => {
  const db = openDatabase(":memory:");
  const cols = db
    .query<{ name: string }, []>("pragma table_info(sessions)")
    .all()
    .map((c) => c.name);
  expect(cols).toEqual(
    expect.arrayContaining([
      "title",
      "ai_title",
      "agent_name",
      "agent_color",
      "agent_setting",
      "tag",
      "project",
    ]),
  );
});
