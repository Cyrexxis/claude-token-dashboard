import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/app";
import { loadConfig } from "../src/config";
import { openDatabase } from "../src/db/database";
import { bus } from "../src/events";
import { rebuildRollups } from "../src/rollups";
import type { IngestService } from "../src/service";
import { SERVER_VERSION } from "../src/version";
import { insertRequest } from "./db-helpers";

const HOST = "127.0.0.1:47811";

function setup(webDir: string | null = null) {
  const home = mkdtempSync(join(tmpdir(), "td-app-"));
  const config = loadConfig({
    HOME: home,
    TD_DATA_DIR: join(home, "data"),
    TD_CONFIG: join(home, "config.json"),
  });
  const db = openDatabase(":memory:");
  db.run("insert into sources (id, kind, host, root_path) values (1, 'wsl', 'pc', '/r')");
  db.run("insert into sessions (id, source_id, first_ts, last_ts) values ('s1', 1, 1, 2)");
  insertRequest(db, { session_id: "s1", input: 5, cost_usd: 1 });
  rebuildRollups(db, "all");
  const calls: string[] = [];
  const ingest: IngestService = {
    scanAll: async () => ({ files: 0, newRequests: 0, errors: 0 }),
    ingestPaths: async () => ({ newRequests: 0, sessionIds: [], from: null, to: null, errors: 0 }),
    rescanSource: async (id) => {
      calls.push(`rescan ${id}`);
      return { newRequests: 0, sessionIds: [], from: null, to: null, errors: 0 };
    },
    saveLocalPrices: async (text) => {
      calls.push(`save ${text}`);
      return text === "bad" ? { ok: false, errors: ["models[0]: bad"] } : { ok: true, repriced: 3 };
    },
    state: () => ({ running: false, lastRunAt: null, lastFiles: 0, lastErrors: 0 }),
    localPricesError: () => null,
  };
  const app = createApp({ db, config, ingest, startedAt: 1, webDir });
  const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    app.request(`http://${HOST}${path}`, { ...init, headers: { host: HOST, ...init.headers } });
  return { app, req, calls };
}

test("health", async () => {
  const r = await setup().req("/api/health");
  expect(await r.json()).toEqual({ ok: true, version: SERVER_VERSION, protocol: 1 });
});

test("summary, timeseries, sessions, sources, prices, status answer 200 with the shared shapes", async () => {
  const { req } = setup();
  expect(await (await req("/api/v1/summary")).json()).toMatchObject({ requests: 1, costUsd: 1 });
  const ts = await (await req("/api/v1/timeseries?metric=cost&group=model&bucket=month")).json();
  expect(ts).toMatchObject({ series: [{ key: "claude-opus-5-5" }] });
  expect(await (await req("/api/v1/sessions?limit=10")).json()).toMatchObject({
    total: 1,
    items: [{ id: "s1" }],
  });
  expect(await (await req("/api/v1/sessions/s1")).json()).toMatchObject({
    session: { id: "s1" },
    requests: [{ input: 5 }],
  });
  expect(await (await req("/api/v1/sources")).json()).toMatchObject([{ id: 1, kind: "wsl" }]);
  expect(await (await req("/api/v1/prices")).json()).toMatchObject({
    localText: null,
    localError: null,
  });
  expect(await (await req("/api/v1/status")).json()).toMatchObject({
    version: SERVER_VERSION,
    requests: 1,
    startedAt: 1,
  });
});

test("cross-site rescan and price save → 403 and nothing queued or written", async () => {
  const { req, calls } = setup();
  const origin = "https://evil.example";
  expect(
    (await req("/api/v1/sources/1/rescan", { method: "POST", headers: { origin } })).status,
  ).toBe(403);
  expect(
    (await req("/api/v1/prices/local", { method: "PUT", body: "{}", headers: { origin } })).status,
  ).toBe(403);
  expect(calls).toEqual([]);
});

test("X-TD-Protocol 2 → 400 protocol; 1 passes", async () => {
  const { req } = setup();
  const r = await req("/api/v1/status", { headers: { "x-td-protocol": "2" } });
  expect(r.status).toBe(400);
  expect(await r.json()).toMatchObject({ error: "protocol" });
  expect((await req("/api/v1/status", { headers: { "x-td-protocol": "1.3" } })).status).toBe(200);
});

test("bad query params → 400; unknown session → 404", async () => {
  const { req } = setup();
  for (const p of [
    "/api/v1/summary?from=2026-13-01",
    "/api/v1/timeseries?metric=x",
    "/api/v1/timeseries?metric=cost&group=type",
    "/api/v1/sessions?limit=abc",
  ]) {
    const r = await req(p);
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: "bad_request" });
  }
  const r = await req("/api/v1/sessions/nope");
  expect(r.status).toBe(404);
  expect(await r.json()).toMatchObject({ error: "not_found" });
});

test("PUT /prices/local: invalid → 400 with errors; valid → repriced", async () => {
  const { req } = setup();
  const bad = await req("/api/v1/prices/local", { method: "PUT", body: "bad" });
  expect(bad.status).toBe(400);
  expect(await bad.json()).toMatchObject({ error: "invalid_prices", errors: ["models[0]: bad"] });
  const ok = await req("/api/v1/prices/local", {
    method: "PUT",
    body: "{}",
    headers: { origin: `http://${HOST}` },
  });
  expect(await ok.json()).toEqual({ ok: true, repriced: 3 });
});

test("rescan unknown source → 404, known → 202", async () => {
  const { req, calls } = setup();
  expect((await req("/api/v1/sources/9/rescan", { method: "POST" })).status).toBe(404);
  const r = await req("/api/v1/sources/1/rescan", { method: "POST" });
  expect(r.status).toBe(202);
  expect(await r.json()).toEqual({ queued: true });
  expect(calls).toEqual(["rescan 1"]);
});

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string) {
  let text = "";
  const dec = new TextDecoder();
  while (!text.includes(needle)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value);
  }
  return text;
}

test("SSE forwards bus events and cleans up on disconnect", async () => {
  const base = bus.listenerCount("usage.updated");
  const res = await setup().req("/api/v1/events");
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  await Bun.sleep(5);
  expect(bus.listenerCount("usage.updated")).toBe(base + 1);
  bus.emit("usage.updated", { sessionIds: ["s1"], from: 1, to: 2 });
  bus.emit("ingest.status", { running: true, files: 1, errors: 0 });
  const text = await readUntil(reader, "event: ingest.status");
  expect(text).toContain("event: usage.updated");
  expect(text).toContain('"sessionIds":["s1"]');
  await reader.cancel();
  await Bun.sleep(10);
  expect(bus.listenerCount("usage.updated")).toBe(base);
  expect(bus.listenerCount("ingest.status")).toBe(0);
  expect(bus.listenerCount("prices.updated")).toBe(0);
});

test("static: 503 without a build, index.html with one", async () => {
  expect((await setup(null).req("/")).status).toBe(503);
  expect((await setup(join(tmpdir(), "td-no-such-dir")).req("/")).status).toBe(503);
  const dir = mkdtempSync(join(tmpdir(), "td-web-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>td</title>");
  const r = await setup(dir).req("/");
  expect(r.status).toBe(200);
  expect(await r.text()).toContain("<title>td</title>");
});

test("wrong Host is rejected before routes and static", async () => {
  const { app } = setup();
  for (const path of ["/api/health", "/", "/api/v1/status"]) {
    const r = await app.request(`http://evil.example:47811${path}`, {
      headers: { host: "evil.example:47811" },
    });
    expect(r.status).toBe(403);
  }
});
