import { expect, test } from "bun:test";
import { BadRequest } from "../src/api/queries";
import { openDatabase } from "../src/db/database";
import { getPlanSnapshots, getPlanWindows, recordSnapshots } from "../src/plan";
import { all, insertRequest } from "./db-helpers";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const RESET = "2026-10-15T17:00:00Z";
const rows = (db: ReturnType<typeof openDatabase>) =>
  all<Record<string, unknown>>(db, "SELECT * FROM plan_snapshots ORDER BY id");

test("stores each window", () => {
  const db = openDatabase(":memory:");
  const out = recordSnapshots(
    db,
    {
      windows: [
        { kind: "five_hour", percentUsed: 12.5, resetsAt: RESET },
        { kind: "seven_day", percentUsed: 40 },
      ],
      sessionCostUsd: 1.5,
    },
    NOW,
  );
  expect(out).toEqual([
    { ts: NOW, kind: "five_hour", percentUsed: 12.5, resetsAt: Date.parse(RESET) },
    { ts: NOW, kind: "seven_day", percentUsed: 40, resetsAt: null },
  ]);
  expect(rows(db)).toMatchObject([
    {
      org_id: "default",
      origin: "mod",
      kind: "five_hour",
      percent_used: 12.5,
      resets_at: Date.parse(RESET),
      session_cost_usd: 1.5,
      ts: NOW,
    },
    { kind: "seven_day", resets_at: null },
  ]);
});

test("two sessions, same reading → one row", () => {
  const db = openDatabase(":memory:");
  const body = { windows: [{ kind: "five_hour", percentUsed: 12.5, resetsAt: RESET }] };
  expect(recordSnapshots(db, body, NOW)).toHaveLength(1);
  expect(recordSnapshots(db, { ...body, sessionCostUsd: 9 }, NOW + 1000)).toEqual([]);
  expect(rows(db)).toHaveLength(1);
});

test("changed percent or reset → new row", () => {
  const db = openDatabase(":memory:");
  recordSnapshots(
    db,
    { windows: [{ kind: "five_hour", percentUsed: 12.5, resetsAt: RESET }] },
    NOW,
  );
  recordSnapshots(
    db,
    { windows: [{ kind: "five_hour", percentUsed: 13, resetsAt: RESET }] },
    NOW + 1,
  );
  recordSnapshots(
    db,
    { windows: [{ kind: "five_hour", percentUsed: 13, resetsAt: "2026-10-15T22:00:00Z" }] },
    NOW + 2,
  );
  expect(rows(db).map((r) => [r.percent_used, r.resets_at])).toEqual([
    [12.5, Date.parse(RESET)],
    [13, Date.parse(RESET)],
    [13, Date.parse("2026-10-15T22:00:00Z")],
  ]);
});

test("resetsAt rounded to the minute", () => {
  const db = openDatabase(":memory:");
  const w = (resetsAt: string) => ({ windows: [{ kind: "five_hour", percentUsed: 5, resetsAt }] });
  recordSnapshots(db, w("2026-10-15T17:00:29Z"), NOW);
  recordSnapshots(db, w("2026-10-15T17:00:14Z"), NOW + 1);
  recordSnapshots(db, w("2026-10-15T16:59:31Z"), NOW + 2);
  expect(rows(db).map((r) => r.resets_at)).toEqual([Date.parse(RESET)]);
});

test("rejects bad bodies", () => {
  const db = openDatabase(":memory:");
  const ok = { kind: "five_hour", percentUsed: 1 };
  const bad: unknown[] = [
    null,
    "x",
    [],
    {},
    { windows: [] },
    { windows: Array.from({ length: 11 }, () => ok) },
    { windows: [{ ...ok, kind: "Five Hour" }] },
    { windows: [{ ...ok, kind: "" }] },
    { windows: [{ ...ok, percentUsed: Number.NaN }] },
    { windows: [{ ...ok, percentUsed: "5" }] },
    { windows: [{ ...ok, percentUsed: -1 }] },
    { windows: [{ ...ok, percentUsed: 1001 }] },
    { windows: [{ ...ok, resetsAt: "soon" }] },
    { windows: [{ ...ok, resetsAt: 5 }] },
    { windows: [ok], sessionCostUsd: -1 },
    { windows: [ok], sessionCostUsd: "1" },
  ];
  for (const b of bad) expect(() => recordSnapshots(db, b, NOW)).toThrow(BadRequest);
  expect(rows(db)).toEqual([]);
});

const H = 3_600_000;
const at = (iso: string) => Date.parse(iso);
const NONE = { from: null, to: null };

function windowFixture() {
  const db = openDatabase(":memory:");
  const read = (ts: string, percentUsed: number, kind = "five_hour", resetsAt = RESET) =>
    recordSnapshots(db, { windows: [{ kind, percentUsed, resetsAt }] }, at(ts));
  read("2026-10-15T13:00:00Z", 20);
  read("2026-10-15T14:00:00Z", 40);
  const req = (ts: string, cost_usd: number, input: number) =>
    insertRequest(db, { ts: at(ts), cost_usd, input });
  req("2026-10-15T11:59:00Z", 50, 5000); // before the window started
  req("2026-10-15T12:30:00Z", 1, 100);
  req("2026-10-15T13:30:00Z", 1, 100);
  req("2026-10-15T15:00:00Z", 2, 200); // after the last reading
  return { db, read };
}

test("window math", () => {
  const { db } = windowFixture();
  const { current, past } = getPlanWindows(db, NONE, at("2026-10-15T16:00:00Z"));
  expect(past).toEqual([]);
  expect(current).toEqual([
    {
      kind: "five_hour",
      startMs: at("2026-10-15T12:00:00Z"),
      resetsAt: at(RESET),
      current: true,
      peakPercent: 40,
      peakTs: at("2026-10-15T14:00:00Z"),
      tokens: 400,
      costUsd: 4,
      tokensAtPeak: 200,
      costAtPeak: 2,
      usdPerPercent: 0.05,
      tokensPerPercent: 5,
      lowSignal: false,
    },
  ]);
});

test("per-1 % stops at the peak reading", () => {
  const { db } = windowFixture();
  const [w] = getPlanWindows(db, NONE, at("2026-10-15T16:00:00Z")).current;
  expect(w?.costUsd).toBe(4); // includes the 15:00 request
  expect(w?.costAtPeak).toBe(2); // excludes it
});

test("tokens count all input and cache types, not thinking", () => {
  const db = openDatabase(":memory:");
  recordSnapshots(
    db,
    { windows: [{ kind: "five_hour", percentUsed: 10, resetsAt: RESET }] },
    at("2026-10-15T14:00:00Z"),
  );
  insertRequest(db, {
    ts: at("2026-10-15T13:00:00Z"),
    input: 1,
    output: 2,
    cache_read: 4,
    cache_write_5m: 8,
    cache_write_1h: 16,
    thinking: 1000,
  });
  const [w] = getPlanWindows(db, NONE, at("2026-10-15T16:00:00Z")).current;
  expect(w?.tokens).toBe(31);
  expect(w?.tokensAtPeak).toBe(31);
});

test("current vs past", () => {
  const { db } = windowFixture();
  const later = getPlanWindows(db, NONE, at("2026-10-15T18:00:00Z"));
  expect(later.current).toEqual([]);
  expect(later.past).toHaveLength(1);
  expect(later.past[0]).toMatchObject({ current: false, costUsd: 4, peakPercent: 40 });
});

test("only the latest window per kind is current; older ones are past", () => {
  const { db, read } = windowFixture();
  read("2026-10-15T18:00:00Z", 3, "five_hour", "2026-10-15T22:00:00Z");
  const r = getPlanWindows(db, NONE, at("2026-10-15T18:30:00Z"));
  expect(r.current.map((w) => w.resetsAt)).toEqual([at("2026-10-15T22:00:00Z")]);
  expect(r.past.map((w) => w.resetsAt)).toEqual([at(RESET)]);
});

test("spend_limit has no start and no per-1 % figures", () => {
  const db = openDatabase(":memory:");
  recordSnapshots(
    db,
    { windows: [{ kind: "spend_limit", percentUsed: 50, resetsAt: RESET }] },
    NOW,
  );
  const [w] = getPlanWindows(db, NONE, NOW).current;
  expect(w).toMatchObject({
    kind: "spend_limit",
    startMs: null,
    usdPerPercent: null,
    tokensPerPercent: null,
  });
});

test("lowSignal below 5 %", () => {
  const db = openDatabase(":memory:");
  const one = (kind: string, p: number) =>
    recordSnapshots(
      db,
      { windows: [{ kind, percentUsed: p, resetsAt: "2026-10-20T12:00:00Z" }] },
      NOW,
    );
  one("five_hour", 4.9);
  one("seven_day", 5);
  const byKind = Object.fromEntries(getPlanWindows(db, NONE, NOW).current.map((w) => [w.kind, w]));
  expect(byKind.five_hour?.lowSignal).toBe(true);
  expect(byKind.seven_day?.lowSignal).toBe(false);
});

test("peak 0 → no per-1 % figures", () => {
  const db = openDatabase(":memory:");
  recordSnapshots(db, { windows: [{ kind: "five_hour", percentUsed: 0, resetsAt: RESET }] }, NOW);
  const [w] = getPlanWindows(db, NONE, NOW).current;
  expect(w?.usdPerPercent).toBeNull();
  expect(w?.tokensPerPercent).toBeNull();
});

test("range filters past windows and points; current ignores the range", () => {
  const db = openDatabase(":memory:");
  const read = (ts: string, p: number, resetsAt: string) =>
    recordSnapshots(db, { windows: [{ kind: "five_hour", percentUsed: p, resetsAt }] }, at(ts));
  read("2026-10-10T13:00:00Z", 10, "2026-10-10T17:00:00Z");
  read("2026-10-15T13:00:00Z", 20, "2026-10-15T17:00:00Z");
  read("2026-10-20T13:00:00Z", 30, "2026-10-20T17:00:00Z");
  const r = { from: "2026-10-14", to: "2026-10-16" };
  const w = getPlanWindows(db, r, at("2026-10-20T14:00:00Z"));
  expect(w.past.map((x) => x.peakPercent)).toEqual([20]);
  expect(w.current.map((x) => x.peakPercent)).toEqual([30]);
  expect(getPlanSnapshots(db, r).points.map((p) => p.percentUsed)).toEqual([20]);
  expect(getPlanSnapshots(db, NONE).points).toEqual([
    {
      ts: at("2026-10-10T13:00:00Z"),
      kind: "five_hour",
      percentUsed: 10,
      resetsAt: at("2026-10-10T17:00:00Z"),
    },
    {
      ts: at("2026-10-15T13:00:00Z"),
      kind: "five_hour",
      percentUsed: 20,
      resetsAt: at("2026-10-15T17:00:00Z"),
    },
    {
      ts: at("2026-10-20T13:00:00Z"),
      kind: "five_hour",
      percentUsed: 30,
      resetsAt: at("2026-10-20T17:00:00Z"),
    },
  ]);
});

test("past windows newest first", () => {
  const db = openDatabase(":memory:");
  for (const d of ["10", "11", "12"])
    recordSnapshots(
      db,
      { windows: [{ kind: "five_hour", percentUsed: 1, resetsAt: `2026-10-${d}T17:00:00Z` }] },
      at(`2026-10-${d}T13:00:00Z`),
    );
  const past = getPlanWindows(db, NONE, at("2026-10-13T00:00:00Z")).past;
  expect(past.map((w) => new Date(w.resetsAt).getUTCDate())).toEqual([12, 11, 10]);
  expect(past[0]?.startMs).toBe(at("2026-10-12T17:00:00Z") - 5 * H);
});
