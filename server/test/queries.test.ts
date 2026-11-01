import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL } from "@td/shared";
import {
  BadRequest,
  getPrices,
  getSession,
  getStatus,
  getSummary,
  getTimeseries,
  getWindowTimeseries,
  listSessions,
  listSources,
  listWindowSessions,
  parseRange,
} from "../src/api/queries";
import { openDatabase, SCHEMA_VERSION } from "../src/db/database";
import { loadPrices, syncPrices } from "../src/pricing/load";
import { rebuildRollups } from "../src/rollups";
import { SERVER_VERSION } from "../src/version";
import { insertRequest } from "./db-helpers";

// Noon UTC keeps the local day stable for any timezone within ±11h.
const at = (day: string) => Date.parse(`${day}T12:00:00Z`);

function db(): Database {
  return openDatabase(":memory:");
}
function session(
  d: Database,
  id: string,
  project: string | null = null,
  cwd: string | null = null,
  lastTs = 0,
) {
  d.run("insert into sessions (id, project, cwd, last_ts) values (?, ?, ?, ?)", [
    id,
    project,
    cwd,
    lastTs,
  ]);
}

test("parseRange rejects bad dates and inverted ranges", () => {
  for (const q of [
    { from: "2026-13-01" },
    { to: "yesterday" },
    { from: "2026-02-30" },
    { from: "2026-10-02", to: "2026-10-01" },
  ])
    expect(() => parseRange(q)).toThrow(BadRequest);
  expect(parseRange({})).toEqual({ from: null, to: null });
  expect(parseRange({ from: "2026-10-01", to: "2026-10-01" })).toEqual({
    from: "2026-10-01",
    to: "2026-10-01",
  });
});

test("summary sums, sessions, unpriced and cache ratio", () => {
  const d = db();
  const r = { input: 10, output: 5, cache_read: 30, cache_write_1h: 10, cost_usd: 1 };
  insertRequest(d, { ...r, session_id: "a", ts: at("2026-10-14") });
  insertRequest(d, { ...r, session_id: "a", ts: at("2026-10-15") });
  insertRequest(d, { ...r, session_id: "b", ts: at("2026-10-15"), cost_usd: null });
  d.run("update requests set unpriced = 1 where cost_usd is null");
  insertRequest(d, { ...r, session_id: "c", ts: at("2026-10-20") }); // outside the range
  rebuildRollups(d, "all");
  const s = getSummary(d, { from: "2026-10-14", to: "2026-10-15" }, 200);
  expect(s).toMatchObject({
    from: "2026-10-14",
    to: "2026-10-15",
    requests: 3,
    sessions: 2,
    unpricedRequests: 1,
    costUsd: 2,
    cacheHitRatio: 0.6,
    subscriptionMonthlyUsd: 200,
  });
  expect(s.tokens).toMatchObject({ input: 30, output: 15, cacheRead: 90, cacheWrite1h: 30 });
  expect(getSummary(d, { from: null, to: null }, null).requests).toBe(4);
});

test("empty db → zeros and null ratio", () => {
  expect(getSummary(db(), { from: null, to: null }, null)).toMatchObject({
    requests: 0,
    sessions: 0,
    costUsd: 0,
    cacheHitRatio: null,
    unpricedRequests: 0,
    tokens: { input: 0, output: 0 },
  });
});

test("day buckets are contiguous and zero-filled", () => {
  const d = db();
  insertRequest(d, { ts: at("2026-10-14"), input: 1 });
  insertRequest(d, { ts: at("2026-10-16"), input: 2 });
  rebuildRollups(d, "all");
  const t = getTimeseries(d, {
    metric: "tokens",
    group: "model",
    bucket: "day",
    from: "2026-10-13",
    to: "2026-10-17",
  });
  expect(t.buckets).toEqual(["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"]);
  expect(t.series).toEqual([
    { key: "claude-opus-5-5", label: "claude-opus-5-5", values: [0, 1, 0, 2, 0] },
  ]);
});

test("week buckets start on Monday; month on the 1st", () => {
  const d = db();
  insertRequest(d, { ts: at("2026-10-18"), input: 1 }); // Sunday
  insertRequest(d, { ts: at("2026-10-19"), input: 2 }); // Monday
  rebuildRollups(d, "all");
  const q = { metric: "requests", group: "model", from: "2026-10-18", to: "2026-10-19" } as const;
  const w = getTimeseries(d, { ...q, bucket: "week" });
  expect(w.buckets).toEqual(["2026-10-12", "2026-10-19"]);
  expect(w.series[0].values).toEqual([1, 1]);
  const m = getTimeseries(d, { ...q, bucket: "month" });
  expect(m.buckets).toEqual(["2026-10-01"]);
  expect(m.series[0].values).toEqual([2]);
});

test("tokens by type: five series, thinking not included", () => {
  const d = db();
  insertRequest(d, {
    ts: at("2026-10-14"),
    input: 1,
    output: 20,
    thinking: 15,
    cache_read: 3,
    cache_write_5m: 4,
    cache_write_1h: 5,
  });
  rebuildRollups(d, "all");
  const t = getTimeseries(d, {
    metric: "tokens",
    group: "type",
    bucket: "day",
    from: "2026-10-14",
    to: "2026-10-14",
  });
  expect(t.series.map((s) => [s.key, s.values[0]])).toEqual([
    ["input", 1],
    ["output", 20],
    ["cacheRead", 3],
    ["cacheWrite5m", 4],
    ["cacheWrite1h", 5],
  ]);
});

test("top 8 + other; bucket sums equal ungrouped totals", () => {
  const d = db();
  for (let i = 1; i <= 10; i++) {
    insertRequest(d, { ts: at("2026-10-14"), model: `m${i}`, input: i * 10, output: 1 });
    insertRequest(d, { ts: at("2026-10-15"), model: `m${i}`, input: i, cache_read: 2 });
  }
  rebuildRollups(d, "all");
  const q = { metric: "tokens", bucket: "day", from: "2026-10-14", to: "2026-10-15" } as const;
  const byModel = getTimeseries(d, { ...q, group: "model" });
  expect(byModel.series).toHaveLength(9);
  expect(byModel.series.map((s) => s.key)).toEqual([
    "m10",
    "m9",
    "m8",
    "m7",
    "m6",
    "m5",
    "m4",
    "m3",
    "other",
  ]);
  expect(byModel.series[8].label).toBe("Other");
  const byType = getTimeseries(d, { ...q, group: "type" });
  byModel.buckets.forEach((_, i) => {
    const grouped = byModel.series.reduce((a, s) => a + s.values[i], 0);
    const total = byType.series.reduce((a, s) => a + s.values[i], 0);
    expect(grouped).toBe(total);
  });
});

test("labels: project is the cwd basename, source is kind · host", () => {
  const d = db();
  d.run("insert into sources (id, kind, host, root_path) values (1, 'wsl', 'pc', '/r')");
  session(d, "s1", "-home-u-demo", "/home/u/old-name", 1);
  session(d, "s2", "-home-u-demo", "/home/u/demo", 2);
  session(d, "s3", "-x", null, 3);
  session(d, "s4", null, null, 4);
  for (const s of ["s1", "s3", "s4"])
    insertRequest(d, { session_id: s, ts: at("2026-10-14"), input: 1, source_id: 1 });
  rebuildRollups(d, "all");
  const q = { metric: "requests", bucket: "day", from: "2026-10-14", to: "2026-10-14" } as const;
  const labels = (g: "project" | "source") =>
    Object.fromEntries(getTimeseries(d, { ...q, group: g }).series.map((s) => [s.key, s.label]));
  expect(labels("project")).toEqual({ "-home-u-demo": "demo", "-x": "-x", "": "(none)" });
  expect(labels("source")).toEqual({ "1": "wsl · pc" });
});

test("type group with requests metric → BadRequest", () => {
  expect(() =>
    getTimeseries(db(), { metric: "requests", group: "type", bucket: "day", from: null, to: null }),
  ).toThrow(BadRequest);
});

test("cost by type: one series per token type; web search only when used", () => {
  const d = db();
  const r = { ts: at("2026-10-14"), cost_usd: 3, cost_input: 1, cost_output: 2 };
  insertRequest(d, r);
  rebuildRollups(d, "all");
  const q = {
    metric: "cost",
    group: "type",
    bucket: "day",
    from: "2026-10-14",
    to: "2026-10-14",
  } as const;
  const values = () =>
    Object.fromEntries(getTimeseries(d, q).series.map((s) => [s.key, s.values[0]]));
  expect(values()).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  insertRequest(d, { ...r, cost_web_search: 0.5 });
  rebuildRollups(d, "all");
  expect(values()).toMatchObject({ input: 2, webSearch: 0.5 });
});

test("empty db timeseries with a range → zero buckets, no series", () => {
  const t = getTimeseries(db(), {
    metric: "cost",
    group: "model",
    bucket: "day",
    from: "2026-10-01",
    to: "2026-10-03",
  });
  expect(t).toEqual({ buckets: ["2026-10-01", "2026-10-02", "2026-10-03"], series: [] });
});

test("missing from starts at the earliest data; missing to ends today", () => {
  const d = db();
  insertRequest(d, { ts: at("2026-10-14"), input: 1 });
  rebuildRollups(d, "all");
  const t = getTimeseries(d, {
    metric: "requests",
    group: "model",
    bucket: "month",
    from: null,
    to: null,
  });
  expect(t.buckets[0]).toBe("2026-10-01");
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  expect(t.buckets.at(-1)).toBe(thisMonth);
});

// --- sessions, sources, prices, status ---

function sessions3() {
  const d = db();
  d.run("insert into sources (id, kind, host, root_path) values (1, 'wsl', 'pc', '/r')");
  const add = (id: string, title: string | null, first: string, last: string) =>
    d.run(
      "insert into sessions (id, source_id, title, project, cwd, entrypoint, first_ts, last_ts) values (?, 1, ?, '-p', '/home/u/p', 'cli', ?, ?)",
      [id, title, at(first), at(last)],
    );
  add("s1", "Fix 100% bug", "2026-10-10", "2026-10-11");
  add("s2", "other", "2026-10-12", "2026-10-14");
  add("s3", null, "2026-10-15", "2026-10-15");
  d.run("update sessions set ai_title = 'AI named' where id = 's3'");
  insertRequest(d, { session_id: "s1", ts: at("2026-10-10"), model: "a", output: 5, cost_usd: 1 });
  insertRequest(d, { session_id: "s1", ts: at("2026-10-11"), model: "b", output: 50, cost_usd: 2 });
  insertRequest(d, {
    session_id: "s1",
    ts: at("2026-10-11"),
    model: "a",
    agent_id: "x",
    input: 7,
    cost_usd: 0.5,
  });
  insertRequest(d, {
    session_id: "s2",
    ts: at("2026-10-12"),
    model: "new",
    cost_usd: null,
    unpriced: 1,
  });
  insertRequest(d, { session_id: "s3", ts: at("2026-10-15"), output: 1, cost_usd: 0.25 });
  return d;
}

test("sessions: range overlap, newest first, paging, totals", () => {
  const d = sessions3();
  const page = listSessions(d, { from: null, to: null, limit: 2 });
  expect(page.total).toBe(3);
  expect(page.items.map((s) => s.id)).toEqual(["s3", "s2"]);
  expect(page.items[0].title).toBe("AI named");
  expect(
    listSessions(d, { from: null, to: null, limit: 2, offset: 2 }).items.map((s) => s.id),
  ).toEqual(["s1"]);
  const s1 = listSessions(d, { from: "2026-10-11", to: "2026-10-12" });
  expect(s1.items.map((s) => s.id)).toEqual(["s2", "s1"]);
  expect(s1.items[1]).toMatchObject({
    title: "Fix 100% bug",
    project: "-p",
    cwd: "/home/u/p",
    sourceKind: "wsl",
    entrypoint: "cli",
    model: "b",
    requests: 3,
    costUsd: 3.5,
    unpricedRequests: 0,
    agents: 1,
    tokens: { input: 7, output: 55 },
  });
});

test("window sessions: only requests inside the window count, most expensive first", () => {
  const d = sessions3();
  const w = listWindowSessions(d, at("2026-10-11"), at("2026-10-15"));
  expect(w.items.map((s) => s.id)).toEqual(["s1", "s2"]);
  expect(w.items[0]).toMatchObject({ requests: 2, costUsd: 2.5, model: "b", agents: 1 });
  expect(listWindowSessions(d, at("2026-10-16"), at("2026-10-17")).total).toBe(0);
  expect(() => listWindowSessions(d, Number.NaN, 1)).toThrow(BadRequest);
});

test("session with only unpriced requests → costUsd 0, unpricedRequests > 0", () => {
  const s2 = listSessions(sessions3(), { from: null, to: null, q: "other" }).items[0];
  expect(s2).toMatchObject({ id: "s2", costUsd: 0, unpricedRequests: 1 });
});

test("q matches title case-insensitively and treats % literally", () => {
  const d = sessions3();
  expect(listSessions(d, { from: null, to: null, q: "100%" }).items.map((s) => s.id)).toEqual([
    "s1",
  ]);
  expect(listSessions(d, { from: null, to: null, q: "FIX" }).total).toBe(1);
  expect(listSessions(d, { from: null, to: null, q: "%" }).total).toBe(1);
  expect(listSessions(d, { from: null, to: null, q: "ai NAMED" }).total).toBe(1);
});

test("limit 0 or 500 or negative offset → BadRequest", () => {
  const d = sessions3();
  for (const q of [{ limit: 0 }, { limit: 500 }, { offset: -1 }])
    expect(() => listSessions(d, { from: null, to: null, ...q })).toThrow(BadRequest);
});

test("empty db → no sessions", () => {
  expect(listSessions(db(), { from: null, to: null })).toEqual({ total: 0, items: [] });
});

test("session detail: requests by ts, subagent breakdown, costStateUsd", () => {
  const d = sessions3();
  d.run(
    "insert into cost_states (session_id, start_time, ts, model, cost_usd) values ('s1', 1, 2, 'a', 3), ('s1', 5, 6, 'b', 1)",
  );
  const s = getSession(d, "s1");
  expect(s?.session).toMatchObject({ id: "s1", requests: 3, costUsd: 3.5 });
  expect(s?.requests.map((r) => r.ts)).toEqual([
    at("2026-10-10"),
    at("2026-10-11"),
    at("2026-10-11"),
  ]);
  expect(s?.requests[2]).toMatchObject({ agentId: "x", input: 7, unpriced: false });
  d.run("insert into agents (agent_id, agent_type) values ('x', 'Explore')");
  expect(getSession(d, "s1")?.agents[0].name).toBe("Explore"); // no description: falls back to type
  expect(s?.agents).toEqual([
    {
      agentId: "x",
      name: null,
      requests: 1,
      costUsd: 0.5,
      tokens: {
        input: 7,
        output: 0,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        thinking: 0,
        webSearch: 0,
        webFetch: 0,
      },
    },
  ]);
  expect(s?.costStateUsd).toBe(4);
  expect(getSession(d, "s2")?.costStateUsd).toBeNull();
});

test("unknown session → null", () => expect(getSession(db(), "nope")).toBeNull());

test("sources: file and error counts", () => {
  const d = sessions3();
  d.run(`insert into files (source_id, path, error_count, last_error, last_ingest_at) values
    (1, '/r/a', 0, null, 1), (1, '/r/b', 2, 'old', 2), (1, '/r/c', 1, 'newest', 3)`);
  expect(listSources(d)).toEqual([
    {
      id: 1,
      kind: "wsl",
      host: "pc",
      distro: null,
      rootPath: "/r",
      lastScanAt: null,
      enabled: true,
      files: 3,
      filesWithErrors: 2,
      errorCount: 3,
      lastError: "newest",
      requests: 0,
    },
  ]);
});

test("prices: periods round-trip dates, localText null without a file", async () => {
  const d = db();
  const local = join(tmpdir(), `td-q-${Date.now()}.json`);
  const missing = await getPrices(d, local, null);
  expect(missing.localText).toBeNull();
  expect(missing.periods).toEqual([]);
  const text = JSON.stringify({
    schema: 1,
    updated: "2026-11-01",
    currency: "USD",
    models: [
      {
        id: "m1",
        match: ["m1"],
        periods: [
          {
            effective_from: null,
            effective_to: "2026-06-01",
            per_mtok: { input: 1, output: 2, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 },
            long_context: null,
            modifiers: { speed: {}, inference_geo: {} },
          },
        ],
      },
    ],
    server_tools: [],
  });
  writeFileSync(local, text);
  syncPrices(d, await loadPrices(local));
  const p = await getPrices(d, local, "bad thing");
  expect(p.localText).toBe(text);
  expect(p.localError).toBe("bad thing");
  expect(p.localPath).toBe(local);
  expect(p.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(p.periods.find((x) => x.modelId === "m1")).toEqual({
    id: "m1@release@local",
    modelId: "m1",
    effectiveFrom: null,
    effectiveTo: "2026-06-01",
    origin: "local",
    perMtok: { input: 1, output: 2, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 },
  });
});

test("status: unpriced models and versions", () => {
  const d = sessions3();
  const ingest = { running: false, lastRunAt: 5, lastFiles: 2, lastErrors: 0 };
  expect(getStatus(d, { startedAt: 1, dbPath: "/x.db", ingest })).toEqual({
    version: SERVER_VERSION,
    protocol: PROTOCOL,
    schemaVersion: SCHEMA_VERSION,
    startedAt: 1,
    dbPath: "/x.db",
    ingest,
    pricesHash: null,
    unpricedModels: ["new"],
    requests: 5,
  });
});

test("parseRange rejects years outside 1970–2100 (one GET must not build millions of buckets)", () => {
  for (const q of [
    { from: "1000-01-01" },
    { to: "9999-12-31" },
    { from: "1969-12-31" },
    { to: "2101-01-01" },
  ])
    expect(() => parseRange(q)).toThrow(BadRequest);
  expect(parseRange({ from: "1970-01-01", to: "2100-12-31" })).toEqual({
    from: "1970-01-01",
    to: "2100-12-31",
  });
});

test("timeseries without from never starts before 1970, whatever the data says", () => {
  const d = db();
  insertRequest(d, { ts: Date.parse("0005-06-01T12:00:00Z"), input: 1 });
  rebuildRollups(d, "all");
  const t = getTimeseries(d, {
    metric: "requests",
    group: "model",
    bucket: "month",
    from: null,
    to: "1970-03-31",
  });
  expect(t.buckets).toEqual(["1970-01-01", "1970-02-01", "1970-03-01"]);
});

test("window timeseries: requests land in their slot; type, project and model groups; bad args", () => {
  const d = db();
  const t0 = at("2026-10-14");
  const M = 60_000;
  session(d, "s1", "-proj", "/home/u/proj");
  insertRequest(d, { session_id: "s1", ts: t0, input: 1, cost_usd: 1, cost_input: 1 });
  insertRequest(d, { session_id: "s1", ts: t0 + 4 * M, output: 2, cost_usd: 2, cost_output: 2 });
  insertRequest(d, { ts: t0 + 5 * M, input: 4 });
  insertRequest(d, { ts: t0 + 15 * M, input: 99 }); // at toMs: excluded
  const q = { fromMs: t0, toMs: t0 + 15 * M, stepMs: 5 * M } as const;
  const byType = getWindowTimeseries(d, { ...q, metric: "tokens", group: "type" });
  expect(byType.buckets).toEqual([t0, t0 + 5 * M, t0 + 10 * M].map(String));
  const vals = Object.fromEntries(byType.series.map((s) => [s.key, s.values]));
  expect(vals.input).toEqual([1, 4, 0]);
  expect(vals.output).toEqual([2, 0, 0]);
  const cost = getWindowTimeseries(d, { ...q, metric: "cost", group: "type" });
  expect(cost.series.find((s) => s.key === "output")?.values).toEqual([2, 0, 0]);
  const byProject = getWindowTimeseries(d, { ...q, metric: "tokens", group: "project" });
  expect(byProject.series.map((s) => [s.label, s.values])).toEqual([
    ["(none)", [0, 4, 0]],
    ["proj", [3, 0, 0]],
  ]);
  expect(getWindowTimeseries(d, { ...q, metric: "requests", group: "model" }).series).toEqual([
    { key: "claude-opus-5-5", label: "claude-opus-5-5", values: [2, 1, 0] },
  ]);
  insertRequest(d, { session_id: "s1", agent_id: "a1", ts: t0 + 10 * M, input: 7 });
  d.run("insert into agents (agent_id, description) values ('a1', 'Review branch')");
  const bySessionAgent = getWindowTimeseries(d, {
    ...q,
    metric: "tokens",
    group: "agent",
    sessionId: "s1",
  });
  expect(bySessionAgent.series.map((s) => [s.label, s.values])).toEqual([
    ["Review branch", [0, 0, 7]],
    ["Main agent", [3, 0, 0]], // the other session's input 4 is filtered out
  ]);
  for (const bad of [
    { ...q, stepMs: 0 },
    { ...q, toMs: q.fromMs },
    { ...q, fromMs: Number.NaN },
    { ...q, stepMs: 1 }, // too many buckets
  ])
    expect(() => getWindowTimeseries(d, { ...bad, metric: "tokens", group: "type" })).toThrow(
      BadRequest,
    );
});
