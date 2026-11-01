import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDatabase } from "../src/db/database";
import { bus } from "../src/events";
import { discoverRoots } from "../src/ingest/discovery";
import { detectPlatform } from "../src/platform";
import { createIngestService } from "../src/service";
import { one } from "./db-helpers";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "td-svc-"));
  const claude = join(home, "claude");
  cpSync("fixtures/transcripts/sample", claude, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ windowsRoots: false }));
  const env = {
    HOME: home,
    TD_DATA_DIR: join(home, "data"),
    TD_CONFIG: join(home, "config.json"),
    CLAUDE_CONFIG_DIR: claude,
  };
  const config = loadConfig(env);
  const db = openDatabase(":memory:");
  const roots = discoverRoots(detectPlatform(env), config, env);
  return { db, config, svc: createIngestService(db, config, roots) };
}

const priceFile = (input: number) =>
  JSON.stringify({
    schema: 1,
    updated: "2026-11-01",
    currency: "USD",
    models: [
      {
        id: "claude-new-9",
        match: ["claude-new-9"],
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
    server_tools: [],
  });

test("scanAll ingests the fixture; rescanSource re-reads it without new rows", async () => {
  const { db, svc } = setup();
  expect(await svc.scanAll()).toMatchObject({ files: 2, newRequests: 3 });
  const sourceId = one<{ id: number }>(db, "select id from sources").id;
  db.run("update files set error_count = 9");
  expect(await svc.rescanSource(sourceId)).toMatchObject({ newRequests: 0 });
  expect(one(db, "select min(offset) > 0 as read, max(error_count) as errs from files")).toEqual({
    read: 1,
    errs: 1,
  });
  expect(svc.state()).toMatchObject({ running: false, lastFiles: 2 });
  expect(svc.state().lastRunAt).toBeNumber();
});

test("rescanSource unknown id → null", async () => {
  expect(await setup().svc.rescanSource(999)).toBeNull();
});

test("jobs never overlap", async () => {
  const { svc } = setup();
  await svc.scanAll(); // creates source 1
  const flags: boolean[] = [];
  const on = (s: { running: boolean }) => flags.push(s.running);
  bus.on("ingest.status", on);
  try {
    await Promise.all([svc.scanAll(), svc.saveLocalPrices(priceFile(1)), svc.rescanSource(1)]);
  } finally {
    bus.off("ingest.status", on);
  }
  expect(flags).toEqual([true, false, true, false, true, false]);
});

test("valid local prices: written, repriced, prices.updated emitted", async () => {
  const { db, config, svc } = setup();
  await svc.scanAll();
  let updated = 0;
  const on = () => updated++;
  bus.on("prices.updated", on);
  try {
    const r = await svc.saveLocalPrices(priceFile(2));
    expect(r).toMatchObject({ ok: true });
    expect((r as { repriced: number }).repriced).toBeGreaterThan(0);
  } finally {
    bus.off("prices.updated", on);
  }
  expect(updated).toBe(1);
  expect(readFileSync(config.localPricesPath, "utf8")).toBe(priceFile(2));
  expect(existsSync(`${config.localPricesPath}.tmp`)).toBe(false);
  expect(one(db, "select count(*) n from price_periods where origin = 'local'")).toEqual({ n: 1 });
  expect(svc.localPricesError()).toBeNull();
});

test("invalid local prices → errors with paths, file untouched", async () => {
  const { config, svc } = setup();
  writeFileSync(config.localPricesPath, priceFile(1));
  const r = await svc.saveLocalPrices(priceFile(-1));
  expect(r.ok).toBe(false);
  expect((r as { errors: string[] }).errors.join()).toContain("per_mtok.input");
  expect(readFileSync(config.localPricesPath, "utf8")).toBe(priceFile(1));
});

test("broken JSON → one parse error", async () => {
  const r = await setup().svc.saveLocalPrices("{nope");
  expect(r.ok).toBe(false);
  expect((r as { errors: string[] }).errors).toHaveLength(1);
});
