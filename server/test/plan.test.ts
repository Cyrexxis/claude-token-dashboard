import { expect, test } from "bun:test";
import type { SessionRow } from "@td/shared";
import { BadRequest } from "../src/api/queries";
import { openDatabase } from "../src/db/database";
import {
  dropNoise,
  estimatePercent,
  getPlanSnapshots,
  getPlanWindows,
  otherUse,
  recordSnapshots,
  withPlanPercent,
} from "../src/plan";
import { saveSettings } from "../src/settings";
import { all, insertRequest } from "./db-helpers";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const RESET = "2026-10-15T17:00:00Z";
const rows = (db: ReturnType<typeof openDatabase>) =>
  all<Record<string, unknown>>(db, "SELECT * FROM plan_snapshots ORDER BY id");

test("stores each window", () => {
  const db = openDatabase(":memory:");
  const { stored: out } = recordSnapshots(
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
    { ts: NOW, seenTs: NOW, kind: "five_hour", percentUsed: 12.5, resetsAt: Date.parse(RESET) },
    { ts: NOW, seenTs: NOW, kind: "seven_day", percentUsed: 40, resetsAt: null },
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

test("two sessions, same reading → one row, confirmed at the later reading", () => {
  const db = openDatabase(":memory:");
  const body = { windows: [{ kind: "five_hour", percentUsed: 12.5, resetsAt: RESET }] };
  expect(recordSnapshots(db, body, NOW).stored).toHaveLength(1);
  expect(recordSnapshots(db, { ...body, sessionCostUsd: 9 }, NOW + 1000)).toEqual({
    stored: [],
    confirmed: [
      {
        ts: NOW,
        seenTs: NOW + 1000,
        kind: "five_hour",
        percentUsed: 12.5,
        resetsAt: Date.parse(RESET),
      },
    ],
  });
  expect(rows(db)).toMatchObject([{ ts: NOW, seen_ts: NOW + 1000 }]);
  expect(getPlanSnapshots(db, NONE).points).toMatchObject([{ ts: NOW, seenTs: NOW + 1000 }]);
  // A row from before the range counts when it was confirmed inside it.
  recordSnapshots(db, body, Date.parse("2026-10-17T12:00:00Z"));
  expect(getPlanSnapshots(db, { from: "2026-10-16", to: null }).points).toHaveLength(1);
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
      percent: 40,
      peakTs: at("2026-10-15T14:00:00Z"),
      tokens: 400,
      costUsd: 4,
      tokensAtPeak: 200,
      costAtPeak: 2,
      usdPerPercent: 0.05,
      tokensPerPercent: 5,
      lowSignal: false,
      activity: [[at("2026-10-15T12:30:00Z"), at("2026-10-15T15:00:00Z")]],
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

test("a small fall is a rescale (plan change): same window, percent is the latest reading", () => {
  const { db, read } = windowFixture();
  read("2026-10-15T15:30:00Z", 20);
  const { current, past } = getPlanWindows(db, NONE, at("2026-10-15T16:00:00Z"));
  expect(past).toEqual([]);
  expect(current).toMatchObject([{ resetsAt: at(RESET), peakPercent: 40, percent: 20 }]);
});

test("a fall to the reset threshold is a limit reset: a new window after the last reading", () => {
  const { db, read } = windowFixture();
  read("2026-10-15T15:30:00Z", 3);
  const r = getPlanWindows(db, NONE, at("2026-10-15T16:00:00Z"));
  const cut = at("2026-10-15T14:00:00Z") + 1;
  expect(r.current).toMatchObject([
    { startMs: cut, resetsAt: at(RESET), peakPercent: 3, percent: 3, costUsd: 2 },
  ]);
  expect(r.past).toMatchObject([
    { startMs: at("2026-10-15T12:00:00Z"), resetsAt: cut, peakPercent: 40, costUsd: 2 },
  ]);
  saveSettings(db, { otherProducts: false, otherEstimate: false, resetPercent: 2 });
  expect(getPlanWindows(db, NONE, at("2026-10-15T16:00:00Z")).past).toEqual([]);
});

test("a new reset time before the old one ends the old window where the new one starts", () => {
  const { db, read } = windowFixture();
  read("2026-10-15T15:30:00Z", 0, "five_hour", "2026-10-15T20:30:00Z");
  const r = getPlanWindows(db, NONE, at("2026-10-15T16:00:00Z"));
  const reset = at("2026-10-15T15:30:00Z");
  expect(r.current).toMatchObject([{ startMs: reset, resetsAt: at("2026-10-15T20:30:00Z") }]);
  expect(r.past).toMatchObject([{ resetsAt: reset, peakPercent: 40, costUsd: 4 }]);
});

test("a reset without a reset time ends the window; the next reset time starts the next one", () => {
  const { db, read } = windowFixture();
  recordSnapshots(
    db,
    { windows: [{ kind: "five_hour", percentUsed: 0 }] },
    at("2026-10-15T15:30:00Z"),
  );
  const gap = getPlanWindows(db, NONE, at("2026-10-15T15:35:00Z"));
  expect(gap.current).toEqual([]);
  const cut = at("2026-10-15T15:30:00Z");
  expect(gap.past).toMatchObject([{ resetsAt: cut, peakPercent: 40 }]);
  read("2026-10-15T15:40:00Z", 5, "five_hour", "2026-10-15T20:40:00Z");
  const r = getPlanWindows(db, NONE, at("2026-10-15T16:00:00Z"));
  expect(r.current).toMatchObject([{ startMs: cut, peakPercent: 5 }]);
  expect(r.past).toMatchObject([{ resetsAt: cut }]);
});

test("readings with another reset time inside a window are a glitch, not a window", () => {
  const { db, read } = windowFixture();
  read("2026-10-15T14:10:00Z", 1, "five_hour", "2026-10-15T19:10:00Z");
  read("2026-10-15T14:20:00Z", 8);
  const { current, past } = getPlanWindows(db, NONE, at("2026-10-15T16:00:00Z"));
  expect(past).toEqual([]);
  expect(current).toMatchObject([{ resetsAt: at(RESET), peakPercent: 40, percent: 8 }]);
});

test("a fall the next reading undoes is a stale reading from another session: dropped", () => {
  const { db, read } = windowFixture();
  read("2026-10-15T14:10:00Z", 2); // a session that last saw the window at its start
  read("2026-10-15T14:20:00Z", 41);
  const { current, past } = getPlanWindows(db, NONE, at("2026-10-15T16:00:00Z"));
  expect(past).toEqual([]);
  expect(current).toMatchObject([{ startMs: at("2026-10-15T12:00:00Z"), peakPercent: 41 }]);
  expect(getPlanSnapshots(db, NONE).points.map((p) => p.percentUsed)).toEqual([20, 40, 41]);
});

test("dropNoise: glitch blocks and undone falls go; real falls, resets and rescales stay", () => {
  const r = (percent: number, resetsAt: number | null = 1) => ({ percent, resetsAt });
  const kept = (xs: ReturnType<typeof r>[]) => dropNoise(xs).map((x) => x.percent);
  expect(kept([r(40), r(1, 2), r(3, 2), r(41)])).toEqual([40, 41]); // glitch
  expect(kept([r(40), r(38), r(40)])).toEqual([40, 40]); // stale
  expect(kept([r(40), r(0), r(1)])).toEqual([40, 0, 1]); // reset
  expect(kept([r(40), r(20), r(21)])).toEqual([40, 20, 21]); // rescale
  expect(kept([r(40), r(3)])).toEqual([40, 3]); // latest: can't tell yet
  expect(kept([r(40, 1), r(2, 2), r(41, 2)])).toEqual([40, 2, 41]); // a new window, not a fall
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

test("activity: a weekly window has one span per active local day, clipped to the window; a day counts as active from requests outside the window too", () => {
  const db = openDatabase(":memory:");
  const local = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
  recordSnapshots(
    db,
    {
      windows: [
        { kind: "seven_day", percentUsed: 10, resetsAt: new Date(local(20, 3)).toISOString() },
      ],
    },
    local(19, 12),
  );
  for (const ts of [
    local(12, 23), // a day before the window: not shown
    local(13, 9),
    local(13, 21),
    local(14, 2), // after midnight: the next day
    local(16, 10), // the 15th is skipped
    local(20, 5), // after the reset, yet the 20th is active, so the window's last 3 hours are too
  ])
    insertRequest(db, { ts, cost_usd: 0, input: 1 });
  const [w] = getPlanWindows(db, NONE, local(20, 6)).past;
  expect(w?.activity).toEqual([
    [local(13, 3), local(14, 0)],
    [local(14, 0), local(15, 0)],
    [local(16, 0), local(17, 0)],
    [local(20, 0), local(20, 3)],
  ]);
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
      seenTs: at("2026-10-10T13:00:00Z"),
      kind: "five_hour",
      percentUsed: 10,
      resetsAt: at("2026-10-10T17:00:00Z"),
    },
    {
      ts: at("2026-10-15T13:00:00Z"),
      seenTs: at("2026-10-15T13:00:00Z"),
      kind: "five_hour",
      percentUsed: 20,
      resetsAt: at("2026-10-15T17:00:00Z"),
    },
    {
      ts: at("2026-10-20T13:00:00Z"),
      seenTs: at("2026-10-20T13:00:00Z"),
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

test("estimatePercent: own rate per window, median for unrated and uncovered cost, null without a rate", () => {
  const parts = [
    { cost: 1, rate: 0.5 }, // 2 %
    { cost: 3, rate: 1.5 }, // 2 %
    { cost: 2, rate: null }, // at the median 1.0: 2 %
  ];
  expect(estimatePercent(6, parts)).toBe(6);
  expect(estimatePercent(9, parts)).toBe(9); // 3 USD outside every window: 3 % more
  expect(estimatePercent(2, [{ cost: 2, rate: null }])).toBeNull();
  expect(estimatePercent(2, [])).toBeNull();
});

test("withPlanPercent: whole session per kind, cost outside the windows at the session's median rate", () => {
  const { db } = windowFixture(); // one 5-hour window, 0.05 USD per 1 %
  db.run("update requests set session_id = 's1' where ts >= ?", [at("2026-10-15T12:30:00Z")]);
  db.run("update requests set session_id = 's1' where cost_usd = 50"); // before the window
  const row = {
    id: "s1",
    firstTs: at("2026-10-15T11:59:00Z"),
    lastTs: at("2026-10-15T15:00:00Z"),
    costUsd: 54,
  } as SessionRow;
  const [r] = withPlanPercent(db, [row], at("2026-10-15T16:00:00Z"));
  expect(r?.planPercent?.five_hour).toBeCloseTo(54 / 0.05);
  expect(r?.planPercent?.seven_day).toBeNull(); // no weekly readings
  const [none] = withPlanPercent(db, [{ ...row, id: "nope" }], at("2026-10-15T16:00:00Z"));
  expect(none?.planPercent).toEqual({ five_hour: null, seven_day: null });
});

const M = 60_000;
const pt = (min: number, percent: number, seenMin = min) => ({
  ts: min * M,
  seen: seenMin * M,
  percent,
});
const rq = (min: number, cost = 0.4) => ({ ts: min * M, cost });

test("otherUse: certain only when no request is near; never counts Claude Code jumps", () => {
  // From window start (0) to the first reading: no requests → +3 is other.
  expect(otherUse([pt(60, 3)], [], 0, null)).toEqual({ certain: 3, estimated: null });
  // A big jump right after a request is Claude Code.
  expect(otherUse([pt(60, 3), pt(61, 8)], [rq(61)], 0, null).certain).toBe(3);
  // A request 8 minutes before a reading (inside the 10-minute margin) blocks both rises around it.
  expect(otherUse([pt(60, 3), pt(90, 4)], [rq(52)], 0, null).certain).toBe(0);
  // The request at 60 makes the first +3 Claude Code; the reading was seen until 80, so the margin
  // starts at 70 and the +2 up to 120 is other.
  expect(otherUse([pt(60, 3, 80), pt(120, 5)], [rq(60)], 0, null).certain).toBe(2);
  // Falling percent never counts.
  expect(otherUse([pt(60, 3), pt(90, 2)], [], 0, null).certain).toBe(3);
});

test("otherUse: estimate subtracts Claude Code's share after a pause, from 2 % on", () => {
  // Chat 30 minutes, then one Claude Code request ($0.40 at $0.40 per 1 %): 4 - 1 = 3 % other.
  const chat = [pt(60, 10), pt(91, 14)];
  expect(otherUse(chat, [rq(90)], 0, 0.4)).toEqual({ certain: 10, estimated: 3 });
  // Switch off: no estimate.
  expect(otherUse(chat, [rq(90)], 0, null).estimated).toBeNull();
  // Under 2 % left: ignored.
  expect(otherUse([pt(60, 10), pt(91, 12)], [rq(90)], 0, 0.4).estimated).toBe(0);
  // No 15-minute pause (steady work): nothing estimated.
  const steady = [...[65, 70, 75, 80, 85].map((m) => rq(m, 0)), rq(90)];
  expect(otherUse(chat, steady, 0, 0.4).estimated).toBe(0);
});

test("getPlanWindows adds other only when asked", () => {
  const { db } = windowFixture();
  const now = at("2026-10-15T16:00:00Z");
  expect(getPlanWindows(db, NONE, now).current[0]?.other).toBeUndefined();
  const w = getPlanWindows(db, NONE, now, { estimate: false }).current[0];
  expect(w?.other).toEqual({ certain: 0, estimated: null }); // requests near both readings
});
