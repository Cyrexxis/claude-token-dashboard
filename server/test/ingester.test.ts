import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PriceFile } from "@td/shared";
import shipped from "../../prices/prices.json";
import { openDatabase } from "../src/db/database";
import { bus, type UsageUpdated } from "../src/events";
import { ensureSource, ingestFiles, type Root } from "../src/ingest/ingester";
import { buildPriceTable } from "../src/pricing/engine";
import { all, one } from "./db-helpers";
import {
  agentName,
  aiTitle,
  assistant,
  costState,
  customTitle,
  NOON,
  tag,
  usage,
  user,
} from "./lines";

const table = buildPriceTable(shipped as PriceFile, null);
const HOUR = 3_600_000;

function setup() {
  const rootPath = mkdtempSync(join(tmpdir(), "td-ingest-"));
  const db = openDatabase(":memory:");
  const root: Root = { kind: "linux", rootPath, host: "testhost", distro: null, poll: false };
  const sourceId = ensureSource(db, root);
  const file = (rel: string, lines: string[]) => {
    const p = join(rootPath, "projects", "-home-u-proj", rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, lines.map((l) => `${l}\n`).join(""));
    return p;
  };
  const ingest = (...paths: string[]) => ingestFiles(db, sourceId, rootPath, paths, table);
  return { db, rootPath, sourceId, file, ingest };
}
const count = (db: Database) => one<{ n: number }>(db, "select count(*) n from requests").n;
const session = (db: Database, id = "s1") =>
  one<Record<string, unknown>>(db, "select * from sessions where id = ?", id);

test("ensureSource is idempotent per root path", () => {
  const { db, rootPath, sourceId } = setup();
  expect(
    ensureSource(db, { kind: "linux", rootPath, host: "testhost", distro: null, poll: false }),
  ).toBe(sourceId);
});

test("multi-line response counted once", async () => {
  const { db, file, ingest } = setup();
  const line = assistant({ usage: usage(5, 7) });
  const r = await ingest(file("s1.jsonl", [line, line, line]));
  expect(r.newRequests).toBe(1);
  expect(count(db)).toBe(1);
  expect(
    one(db, "select session_id, input, output, cost_usd, price_period_id, unpriced from requests"),
  ).toEqual({
    session_id: "s1",
    input: 5,
    output: 7,
    cost_usd: (5 * 4 + 7 * 20) / 1e6,
    price_period_id: "claude-opus-5-5@release@shipped",
    unpriced: 0,
  });
  expect(one(db, "select cost_input, cost_output, cost_cache_read from requests")).toEqual({
    cost_input: (5 * 4) / 1e6,
    cost_output: (7 * 20) / 1e6,
    cost_cache_read: 0,
  });
  expect(session(db)).toMatchObject({
    project: "-home-u-proj",
    cwd: "/home/user/demo",
    entrypoint: "cli",
    cc_version: "2.1.309",
    first_ts: NOON,
    last_ts: NOON,
  });
});

test("resumed session copying lines into a second file → no double count", async () => {
  const { db, file, ingest } = setup();
  const a = file("s1.jsonl", [assistant({ messageId: "m1" }), assistant({ messageId: "m2" })]);
  const b = file("s2.jsonl", [
    assistant({ sessionId: "s2", messageId: "m1" }),
    assistant({ sessionId: "s2", messageId: "m3" }),
  ]);
  const r = await ingest(a, b);
  expect(r.newRequests).toBe(3);
  expect(count(db)).toBe(3);
  expect(
    one(
      db,
      "select f.path from requests r join files f on f.id = r.file_id where message_id = 'm1'",
    ),
  ).toEqual({ path: a });
});

test("later line with more output replaces; less output does not", async () => {
  const { db, file, ingest } = setup();
  await ingest(
    file("s1.jsonl", [
      assistant({ usage: usage(1, 10) }),
      assistant({ usage: usage(1, 50) }),
      assistant({ usage: usage(1, 5) }),
    ]),
  );
  expect(one(db, "select output, cost_usd from requests")).toEqual({
    output: 50,
    cost_usd: (4 + 50 * 20) / 1e6,
  });
});

test("subagent file links to parent session with agent_id", async () => {
  const { db, file, ingest } = setup();
  await ingest(
    file("s1.jsonl", [assistant(), agentName("s1", "Parent name")]),
    file("s1/subagents/agent-a1.jsonl", [
      assistant({ messageId: "sub1", isSidechain: true }),
      agentName("s1", "Subagent name"),
    ]),
  );
  expect(
    one(db, "select session_id, agent_id, is_sidechain from requests where message_id = 'sub1'"),
  ).toEqual({ session_id: "s1", agent_id: "a1", is_sidechain: 1 });
  expect(one(db, "select agent_id from requests where message_id = 'msg_1'")).toEqual({
    agent_id: null,
  });
  expect(session(db)).toMatchObject({ agent_name: "Parent name", project: "-home-u-proj" });
});

test("sub-agent meta file names the agent; a missing one is retried on the next pass", async () => {
  const { db, file, ingest } = setup();
  const a1 = file("s1/subagents/agent-a1.jsonl", [
    assistant({ messageId: "sub1", isSidechain: true }),
  ]);
  file("s1/subagents/agent-a1.meta.json", [
    JSON.stringify({ agentType: "general-purpose", description: " Review branch " }),
  ]);
  const a2 = file("s1/subagents/agent-a2.jsonl", [
    assistant({ messageId: "sub2", isSidechain: true }),
  ]);
  await ingest(a1, a2);
  file("s1/subagents/agent-a2.meta.json", [JSON.stringify({ agentType: "Explore" })]);
  await ingest(a2); // transcript unchanged, meta now present
  expect(all(db, "select * from agents order by agent_id")).toEqual([
    { agent_id: "a1", agent_type: "general-purpose", description: "Review branch" },
    { agent_id: "a2", agent_type: "Explore", description: null },
  ]);
});

test("custom title wins over an ai-title written after it", async () => {
  const { db, file, ingest } = setup();
  await ingest(file("s1.jsonl", [customTitle("s1", "Mine"), aiTitle("s1", "Auto")]));
  expect(
    one(db, "select title, ai_title, coalesce(title, ai_title) display from sessions"),
  ).toEqual({ title: "Mine", ai_title: "Auto", display: "Mine" });
});

test('repeated agent-name lines keep one value; tag "" clears tag', async () => {
  const { db, file, ingest } = setup();
  const p = file("s1.jsonl", [
    agentName("s1", "n"),
    agentName("s1", "n"),
    agentName("s1", "n"),
    tag("s1", "work"),
    user("s1", NOON),
  ]);
  await ingest(p);
  expect(session(db)).toMatchObject({ agent_name: "n", tag: "work" });
  appendFileSync(p, `${tag("s1", "")}\n`);
  await ingest(p);
  expect(session(db)).toMatchObject({ agent_name: "n", tag: null });
  expect(one(db, "select count(*) n from sessions")).toEqual({ n: 1 });
});

test("append, partial line completed later, truncation and replacement", async () => {
  const { db, file, ingest } = setup();
  const lines = ["m1", "m2", "m3", "m4"].map((id) => assistant({ messageId: id }));
  const p = file("s1.jsonl", []);
  writeFileSync(p, `${lines[0]}\n${lines[1]}\n${lines[2].slice(0, 30)}`);
  await ingest(p);
  expect(count(db)).toBe(2);
  appendFileSync(p, `${lines[2].slice(30)}\n${lines[3]}\n`);
  await ingest(p);
  expect(count(db)).toBe(4);
  const replacement = `${p}.new`;
  writeFileSync(replacement, lines.map((l) => `${l}\n`).join(""));
  renameSync(replacement, p); // new inode
  expect((await ingest(p)).newRequests).toBe(0);
  const size = Bun.file(p).size;
  expect(one(db, "select offset, size from files")).toEqual({ offset: size, size });
  truncateSync(p, lines[0].length + 1);
  expect((await ingest(p)).newRequests).toBe(0);
  expect(count(db)).toBe(4);
  expect(one(db, "select offset, size from files")).toEqual({
    offset: lines[0].length + 1,
    size: lines[0].length + 1,
  });
});

test("re-run adds 0 rows", async () => {
  const { db, file, ingest } = setup();
  const p = file("s1.jsonl", [assistant({ messageId: "m1" }), assistant({ messageId: "m2" })]);
  expect((await ingest(p)).newRequests).toBe(2);
  const again = await ingest(p);
  expect(again).toEqual({ newRequests: 0, sessionIds: [], from: null, to: null, errors: 0 });
  expect(count(db)).toBe(2);
});

test("cost-state: per process, later snapshot replaces, session total = sum of latest", async () => {
  const { db, file, ingest } = setup();
  const opus = (costUSD: number) => ({
    "claude-opus-5-5": {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD,
    },
  });
  const A = NOON;
  const B = NOON + 5 * HOUR;
  const p = file("s1.jsonl", [
    costState({ startTime: A, totalDuration: 1000, modelUsage: opus(1) }),
    costState({ startTime: A, totalDuration: 9000, modelUsage: opus(2) }),
    costState({ startTime: A, totalDuration: 5000, modelUsage: opus(1.5) }), // older snapshot: ignored
    costState({ startTime: B, totalDuration: 1000, modelUsage: opus(0.5) }),
  ]);
  const r = await ingest(p);
  expect(r.sessionIds).toEqual(["s1"]);
  expect(all(db, "select start_time, ts, cost_usd from cost_states order by start_time")).toEqual([
    { start_time: A, ts: A + 9000, cost_usd: 2 },
    { start_time: B, ts: B + 1000, cost_usd: 0.5 },
  ]);
  expect(one(db, "select sum(cost_usd) total from cost_states where session_id = 's1'")).toEqual({
    total: 2.5,
  });
});

test("malformed lines are counted and the rest is ingested", async () => {
  const { db, file, ingest } = setup();
  const r = await ingest(
    file("s1.jsonl", [assistant({ messageId: "m1" }), "{bad", "", assistant({ messageId: "m2" })]),
  );
  expect(r.errors).toBe(1);
  expect(count(db)).toBe(2);
  const f = one<{ error_count: number; last_error: string }>(
    db,
    "select error_count, last_error from files",
  );
  expect(f.error_count).toBe(1);
  expect(f.last_error).toContain("invalid JSON");
});

test("deleted file is skipped, not an error", async () => {
  const { db, file, ingest, rootPath } = setup();
  const r = await ingest(
    join(rootPath, "projects", "-home-u-proj", "gone.jsonl"),
    file("s1.jsonl", [assistant()]),
  );
  expect(r.errors).toBe(0);
  expect(r.newRequests).toBe(1);
  expect(count(db)).toBe(1);
});

test("emits usage.updated with sessionIds and range; rollups match", async () => {
  const { db, file, ingest } = setup();
  const events: UsageUpdated[] = [];
  const on = (e: UsageUpdated) => events.push(e);
  bus.on("usage.updated", on);
  await ingest(
    file("s1.jsonl", [assistant({ messageId: "m1", ts: NOON, usage: usage(1, 100) })]),
    file("s2.jsonl", [
      assistant({ sessionId: "s2", messageId: "m2", ts: NOON + 24 * HOUR, usage: usage(1, 200) }),
    ]),
  );
  await ingest(file("s1.jsonl", [assistant({ messageId: "m1", ts: NOON })])); // nothing new → no event
  bus.off("usage.updated", on);
  expect(events).toEqual([{ sessionIds: ["s1", "s2"], from: NOON, to: NOON + 24 * HOUR }]);
  expect(one(db, "select sum(output) s, sum(request_count) n from daily_rollups")).toEqual({
    s: 300,
    n: 2,
  });
  expect(one(db, "select count(*) n from daily_rollups")).toEqual({ n: 2 });
});

test("unknown model stored with unpriced = 1 and cost_usd NULL", async () => {
  const { db, file, ingest } = setup();
  await ingest(file("s1.jsonl", [assistant({ model: "claude-new-9" })]));
  expect(one(db, "select cost_usd, price_period_id, unpriced from requests")).toEqual({
    cost_usd: null,
    price_period_id: null,
    unpriced: 1,
  });
});
