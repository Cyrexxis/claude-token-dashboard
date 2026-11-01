import { expect, test } from "bun:test";
import type { PriceFile } from "@td/shared";
import shipped from "../../prices/prices.json";
import { buildPriceTable, type PriceInput, priceRequest } from "../src/pricing/engine";
import { NOON } from "./lines";

const table = buildPriceTable(shipped as PriceFile, null);
const base: PriceInput = {
  model: "claude-opus-5-5",
  ts: NOON,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  webSearch: 0,
  speed: null,
};
const priced = (o: Partial<PriceInput>, t = table) => {
  const r = priceRequest(t, { ...base, ...o });
  if ("unpriced" in r) throw new Error(`unpriced: ${o.model}`);
  return r;
};
const cost = (o: Partial<PriceInput>) => priced(o).costUsd;
const periodId = (model: string) => priced({ model }).pricePeriodId;

const rates = { input: 1, output: 2, cache_read: 0.1, cache_write_5m: 1.25, cache_write_1h: 2 };
const localFile = (models: PriceFile["models"]): PriceFile => ({
  schema: 1,
  updated: "2026-11-01",
  currency: "USD",
  models,
  server_tools: [],
});
const period = (from: string | null, to: string | null, input: number) => ({
  effective_from: from,
  effective_to: to,
  per_mtok: { ...rates, input },
  long_context: null,
  modifiers: { speed: {}, inference_geo: {} },
});

test("Opus 5.5 oracle", () => {
  expect(cost({ input: 178, output: 73415, cacheRead: 8961590, cacheWrite1h: 195092 })).toBeCloseTo(
    4.822066,
    6,
  );
});

test("Haiku 5.5 + web search oracle", () => {
  expect(cost({ model: "claude-haiku-5-5", input: 41080, output: 4515, webSearch: 2 })).toBeCloseTo(
    0.0263655,
    7,
  );
});

test("Sonnet 5.5 oracle (subagent tokens from a real cost-state)", () => {
  expect(
    cost({
      model: "claude-sonnet-5-5",
      input: 8,
      output: 1488,
      cacheRead: 30886,
      cacheWrite5m: 11700,
    }),
  ).toBeCloseTo(0.0472346, 7);
});

test("long context switches above 100K, not at", () => {
  const at = { model: "claude-haiku-5-5", input: 60_000, cacheRead: 40_000, output: 1_000_000 };
  expect(cost(at)).toBeCloseTo((60_000 * 0.1 + 40_000 * 0.01 + 1_000_000 * 0.5) / 1e6, 9);
  const above = { ...at, cacheWrite5m: 1 };
  expect(cost(above)).toBeCloseTo(
    (60_000 * 0.5 + 40_000 * 0.05 + 1 * 0.625 + 1_000_000 * 2.5) / 1e6,
    9,
  );
});

test("fast speed doubles Opus 5.5 token cost, not the web search fee", () => {
  expect(cost({ input: 1_000_000, output: 1_000_000, speed: "fast", webSearch: 1 })).toBeCloseTo(
    8 + 40 + 0.01,
    9,
  );
  expect(cost({ input: 1_000_000, speed: "standard" })).toBeCloseTo(4, 9);
});

test("dated ids match the right family", () => {
  expect(periodId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5@release@shipped");
  expect(periodId("claude-opus-4-5-20251101")).toBe("claude-opus-4-5@release@shipped");
  expect(periodId("claude-opus-4-20250514")).toBe("claude-opus-4@release@shipped");
  expect(periodId("claude-opus-4-1-20250805")).toBe("claude-opus-4-1@release@shipped");
  expect(periodId("claude-sonnet-4-20250514")).toBe("claude-sonnet-4@release@shipped");
  expect(periodId("claude-3-5-haiku-20241022")).toBe("claude-3-5-haiku@release@shipped");
  expect(periodId("claude-mythos-5-1")).toBe("claude-fable-5-1@release@shipped");
});

test("period boundary: effective_to is exclusive", () => {
  const t = buildPriceTable(
    shipped as PriceFile,
    localFile([
      {
        id: "m1",
        match: ["m1"],
        periods: [period(null, "2026-06-01", 1), period("2026-06-01", null, 2)],
      },
    ]),
  );
  const at = (iso: string) => priced({ model: "m1", ts: Date.parse(iso), input: 1_000_000 }, t);
  expect(at("2026-05-31T23:59:59.999Z")).toEqual({ costUsd: 1, pricePeriodId: "m1@release@local" });
  expect(at("2026-06-01T00:00:00Z")).toEqual({ costUsd: 2, pricePeriodId: "m1@2026-06-01@local" });
});

test("timestamp before the first period → unpriced", () => {
  const t = buildPriceTable(
    shipped as PriceFile,
    localFile([{ id: "m1", match: ["m1"], periods: [period("2026-06-01", null, 2)] }]),
  );
  expect(priceRequest(t, { ...base, model: "m1", ts: Date.parse("2026-01-01T00:00:00Z") })).toEqual(
    { unpriced: true },
  );
});

test("unknown model → unpriced", () => {
  expect(priceRequest(table, { ...base, model: "claude-new-9" })).toEqual({ unpriced: true });
});

test("local override wins", () => {
  const t = buildPriceTable(
    shipped as PriceFile,
    localFile([
      { id: "claude-opus-5-5", match: ["claude-opus-5-5"], periods: [period(null, null, 100)] },
    ]),
  );
  expect(priced({ input: 1_000_000 }, t)).toEqual({
    costUsd: 100,
    pricePeriodId: "claude-opus-5-5@release@local",
  });
  expect(t.models.filter((m) => m.id === "claude-opus-5-5")).toHaveLength(1);
});

test("new local ids are matched before shipped patterns", () => {
  const t = buildPriceTable(
    shipped as PriceFile,
    localFile([
      {
        id: "claude-opus-5-5-preview",
        match: ["claude-opus-5-5-preview"],
        periods: [period(null, null, 7)],
      },
    ]),
  );
  expect(priced({ model: "claude-opus-5-5-preview", input: 1_000_000 }, t).costUsd).toBe(7);
});

test("Opus 5 and Opus 4.8 fast mode is 2x", () => {
  expect(
    cost({ model: "claude-opus-5", input: 1_000_000, output: 1_000_000, speed: "fast" }),
  ).toBeCloseTo(10 + 50, 9);
  expect(
    cost({ model: "claude-opus-4-8", input: 1_000_000, output: 1_000_000, speed: "fast" }),
  ).toBeCloseTo(10 + 50, 9);
});

test("a speed without a price modifier is unpriced, not silently 1x", () => {
  expect(
    priceRequest(table, { ...base, model: "claude-opus-4-6", input: 1, speed: "fast" }),
  ).toEqual({ unpriced: true });
  expect(
    "costUsd" in
      priceRequest(table, { ...base, model: "claude-opus-4-6", input: 1, speed: "standard" }),
  ).toBe(true);
});
