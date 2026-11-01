import { expect, test } from "bun:test";
import { parseLine } from "../src/ingest/parse";
import {
  agentColor,
  agentName,
  agentSetting,
  aiTitle,
  assistant,
  costState,
  customTitle,
  NOON,
  tag,
  usage,
  user,
} from "./lines";

test("assistant line → response with split cache writes", () => {
  const p = parseLine(
    assistant({
      usage: usage(2, 121, {
        cache_read_input_tokens: 25429,
        cache_creation_input_tokens: 11039,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 11039 },
        output_tokens_details: { thinking_tokens: 37 },
        server_tool_use: { web_search_requests: 1, web_fetch_requests: 2 },
      }),
    }),
  );
  expect(p).toMatchObject({
    kind: "response",
    sessionId: "s1",
    messageId: "msg_1",
    requestId: "req_1",
    ts: NOON,
    model: "claude-opus-5-5",
    isSidechain: false,
    effort: "high",
    cwd: "/home/user/demo",
    entrypoint: "cli",
    version: "2.1.309",
    usage: {
      input: 2,
      output: 121,
      cacheRead: 25429,
      cacheWrite5m: 0,
      cacheWrite1h: 11039,
      thinking: 37,
      webSearch: 1,
      webFetch: 2,
      serviceTier: "standard",
      speed: "standard",
      inferenceGeo: "global",
    },
  });
  if (p.kind === "response")
    expect(p.usageRaw).toMatchObject({ cache_creation_input_tokens: 11039 });
});

test("missing cache_creation breakdown → whole amount is 5m", () => {
  const u: Record<string, unknown> = usage(1, 1, { cache_creation_input_tokens: 500 });
  delete u.cache_creation;
  expect(parseLine(assistant({ usage: u }))).toMatchObject({
    usage: { cacheWrite5m: 500, cacheWrite1h: 0 },
  });
});

test("<synthetic> model and usage-less assistant → meta", () => {
  expect(parseLine(assistant({ model: "<synthetic>" })).kind).toBe("meta");
  expect(parseLine(assistant({ usage: null })).kind).toBe("meta");
});

test("missing requestId → requestId ''", () => {
  expect(parseLine(assistant({ requestId: null }))).toMatchObject({
    kind: "response",
    requestId: "",
  });
});

test("assistant with missing or invalid timestamp → malformed", () => {
  expect(parseLine(assistant({ ts: null })).kind).toBe("malformed");
  expect(parseLine(assistant({ ts: "yesterday" })).kind).toBe("malformed");
});

test("custom-title → meta with title; ai-title → meta with aiTitle", () => {
  expect(parseLine(customTitle("s1", "My session"))).toMatchObject({
    kind: "meta",
    sessionId: "s1",
    title: "My session",
    aiTitle: null,
  });
  expect(parseLine(aiTitle("s1", "Auto name"))).toMatchObject({
    kind: "meta",
    title: null,
    aiTitle: "Auto name",
  });
});

test('agent-name / agent-color / agent-setting / tag lines → meta fields; tag "" → tag null', () => {
  expect(parseLine(agentName("s1", "n"))).toMatchObject({ kind: "meta", agentName: "n" });
  expect(parseLine(agentColor("s1", "blue"))).toMatchObject({ kind: "meta", agentColor: "blue" });
  expect(parseLine(agentSetting("s1", "reviewer"))).toMatchObject({
    kind: "meta",
    agentSetting: "reviewer",
  });
  expect(parseLine(tag("s1", "work"))).toMatchObject({ kind: "meta", tag: "work" });
  expect(parseLine(tag("s1", ""))).toMatchObject({ kind: "meta", tag: null });
  expect("tag" in parseLine(user("s1", NOON))).toBe(false);
});

test("user line → meta with envelope", () => {
  expect(parseLine(user("s1", NOON))).toMatchObject({
    kind: "meta",
    sessionId: "s1",
    ts: NOON,
    cwd: "/home/user/demo",
    version: "2.1.309",
  });
});

test("cost-state → ts = startTime + totalDuration, one entry per model", () => {
  const p = parseLine(costState({ startTime: NOON, totalDuration: 60_000 }));
  expect(p).toMatchObject({
    kind: "cost-state",
    sessionId: "s1",
    startTime: NOON,
    ts: NOON + 60_000,
    totalCostUsd: 4.8484315,
    hasUnknownModelCost: false,
  });
  if (p.kind !== "cost-state") throw new Error("not cost-state");
  expect(p.models).toEqual([
    {
      model: "claude-opus-5-5",
      input: 178,
      output: 73415,
      thinking: 28540,
      cacheRead: 8961590,
      cacheWrite: 195092,
      webSearch: 0,
      costUsd: 4.822066,
    },
    {
      model: "claude-haiku-5-5",
      input: 41080,
      output: 4515,
      thinking: 2293,
      cacheRead: 0,
      cacheWrite: 0,
      webSearch: 2,
      costUsd: 0.0263655,
    },
  ]);
});

test("api-request and lines without sessionId → ignored", () => {
  expect(
    parseLine(
      JSON.stringify({
        type: "api-request",
        sessionId: "s1",
        id: "x",
        timestamp: "2026-10-15T12:00:00Z",
      }),
    ).kind,
  ).toBe("ignored");
  expect(parseLine(JSON.stringify({ type: "file-history-snapshot" })).kind).toBe("ignored");
});

test("broken JSON → malformed", () => expect(parseLine("{not json").kind).toBe("malformed"));

test("non-object JSON → malformed", () => expect(parseLine("[1,2]").kind).toBe("malformed"));
