import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import shipped from "../../prices/prices.json";
import { openDatabase } from "../src/db/database";
import { bus } from "../src/events";
import { loadPrices, syncPrices } from "../src/pricing/load";
import { reprice } from "../src/pricing/reprice";
import { insertRequest, one } from "./db-helpers";

const tmp = () => mkdtempSync(join(tmpdir(), "td-prices-"));
const opusOverride = (input: number) =>
  JSON.stringify({
    schema: 1,
    updated: "2026-11-01",
    currency: "USD",
    server_tools: [],
    models: [
      {
        id: "claude-opus-5-5",
        match: ["claude-opus-5-5"],
        periods: [
          {
            effective_from: null,
            effective_to: null,
            per_mtok: { input, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 },
            long_context: null,
            modifiers: { speed: {}, inference_geo: {} },
          },
        ],
      },
    ],
  });
const periodCount = shipped.models.reduce((n, m) => n + m.periods.length, 0);

test("first sync fills price_periods, reprices and rolls up", async () => {
  const db = openDatabase(":memory:");
  insertRequest(db, { input: 1_000_000, cost_usd: null });
  insertRequest(db, { model: "claude-new-9", input: 5 });
  const r = syncPrices(db, await loadPrices(null));
  expect(r).toEqual({ changed: true, repriced: 2 });
  expect(one(db, "select count(*) n from price_periods")).toEqual({ n: periodCount });
  expect(
    one(
      db,
      "select cost_usd, price_period_id, unpriced from requests where model = 'claude-opus-5-5'",
    ),
  ).toEqual({ cost_usd: 4, price_period_id: "claude-opus-5-5@release@shipped", unpriced: 0 });
  expect(
    one(
      db,
      "select cost_usd, price_period_id, unpriced from requests where model = 'claude-new-9'",
    ),
  ).toEqual({ cost_usd: null, price_period_id: null, unpriced: 1 });
  expect(one(db, "select sum(cost_usd) s from daily_rollups")).toEqual({ s: 4 });
  expect(one(db, "select sum(cost_input) i, sum(cost_output) o from daily_rollups")).toEqual({
    i: 4,
    o: 0,
  });
});

test("unchanged hash is a no-op", async () => {
  const db = openDatabase(":memory:");
  const loaded = await loadPrices(null);
  syncPrices(db, loaded);
  expect(syncPrices(db, loaded)).toEqual({ changed: false, repriced: 0 });
});

test("local file change reprices and emits prices.updated", async () => {
  const db = openDatabase(":memory:");
  const local = join(tmp(), "prices.local.json");
  insertRequest(db, { input: 1_000_000 });
  syncPrices(db, await loadPrices(local)); // missing local file = none
  writeFileSync(local, opusOverride(100));
  const seen: string[] = [];
  const onUpdate = (e: { hash: string }) => seen.push(e.hash);
  bus.on("prices.updated", onUpdate);
  const loaded = await loadPrices(local);
  expect(loaded.localError).toBeNull();
  expect(syncPrices(db, loaded)).toEqual({ changed: true, repriced: 1 });
  bus.off("prices.updated", onUpdate);
  expect(seen).toEqual([loaded.hash]);
  expect(one(db, "select cost_usd, price_period_id from requests")).toEqual({
    cost_usd: 100,
    price_period_id: "claude-opus-5-5@release@local",
  });
  expect(
    one(db, "select origin from price_periods where id = 'claude-opus-5-5@release@local'"),
  ).toEqual({ origin: "local" });
});

test("invalid local file → localError, shipped prices still used", async () => {
  const local = join(tmp(), "prices.local.json");
  writeFileSync(local, '{"schema": 2}');
  const loaded = await loadPrices(local);
  expect(loaded.localError).toContain("schema");
  expect(loaded.table.models.find((m) => m.id === "claude-opus-5-5")?.origin).toBe("shipped");
  writeFileSync(local, "{broken");
  expect((await loadPrices(local)).localError).toBeTruthy();
});

test("reprice prices every request and returns the count", async () => {
  const db = openDatabase(":memory:");
  insertRequest(db, { session_id: "a", input: 1_000_000, cost_usd: null });
  insertRequest(db, { session_id: "b", input: 1_000_000, cost_usd: null });
  expect(reprice(db, (await loadPrices(null)).table)).toBe(2);
  expect(one(db, "select count(*) n from requests where cost_usd is null")).toEqual({ n: 0 });
});
