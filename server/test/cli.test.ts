import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase } from "../src/db/database";
import { getStats } from "../src/stats";
import { assistant, usage } from "./lines";

function env() {
  const home = mkdtempSync(join(tmpdir(), "td-cli-"));
  const claude = join(home, "claude");
  cpSync("fixtures/transcripts/sample", claude, { recursive: true });
  const config = join(home, "config.json");
  writeFileSync(config, JSON.stringify({ windowsRoots: false }));
  return {
    HOME: home,
    TD_DATA_DIR: join(home, "data"),
    CLAUDE_CONFIG_DIR: claude,
    TD_CONFIG: config,
  };
}
function cli(e: Record<string, string>, ...args: string[]) {
  const r = Bun.spawnSync(["bun", "server/src/cli.ts", ...args], {
    env: { TZ: "UTC", ...process.env, ...e },
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

test("scan ingests the fixture, re-scan adds 0", () => {
  const e = env();
  const first = cli(e, "scan");
  expect(first.code).toBe(0);
  expect(first.out).toContain("scanned 2 files, +3 requests, 1 errors");
  const second = cli(e, "scan");
  expect(second.out).toContain("+0 requests, 0 errors");
  const db = openDatabase(join(e.TD_DATA_DIR, "token-dashboard.db"));
  expect(db.query("select count(*) n from requests").get()).toEqual({ n: 3 });
  expect(db.query("select last_scan_at is not null as scanned from sources").get()).toEqual({
    scanned: 1,
  });
});

test("getStats: models, sources, unpriced and the cost-state comparison", () => {
  const e = env();
  cli(e, "scan");
  const db = openDatabase(join(e.TD_DATA_DIR, "token-dashboard.db"));
  db.run(
    "insert into requests (message_id, ts, model, unpriced) values ('x', 1, 'claude-new-9', 1)",
  );
  const s = getStats(db);
  expect(s.byModel.find((m) => m.model === "claude-opus-5-5")).toMatchObject({
    requests: 2,
    input: 110,
    output: 1500,
    cacheRead: 5000,
  });
  expect(s.byModel.find((m) => m.model === "claude-opus-5-5")?.costUsd).toBeCloseTo(0.03144, 9);
  expect(s.bySource).toEqual([expect.objectContaining({ label: "cli", requests: 3 })]);
  expect(s.unpricedModels).toEqual(["claude-new-9"]);
  expect(s.costStateComparison).toHaveLength(1);
  expect(s.costStateComparison[0]).toMatchObject({
    sessionId: "s1",
    model: "claude-opus-5-5",
    costStateUsd: 0.03144,
  });
  expect(s.costStateComparison[0]?.transcriptCostUsd).toBeCloseTo(0.03144, 9);
});

test("stats prints models, sources and the cost-state comparison", () => {
  const e = env();
  cli(e, "scan");
  const r = cli(e, "stats");
  expect(r.code).toBe(0);
  for (const s of ["claude-opus-5-5", "claude-haiku-5-5", "cli", "s1", "0.031440"])
    expect(r.out).toContain(s);
});

test("reprice recomputes every request", () => {
  const e = env();
  cli(e, "scan");
  expect(cli(e, "reprice").out).toContain("repriced 3 requests");
});

test("unknown command exits 2", () => {
  const r = cli(env(), "nope");
  expect(r.code).toBe(2);
  expect(r.err).toContain("usage");
  for (const c of ["setup", "update", "uninstall"]) expect(r.err).toContain(c);
});

test("version and help print to stdout and exit 0", () => {
  const e = env();
  const v = cli(e, "--version");
  expect(v.code).toBe(0);
  expect(v.out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  const h = cli(e, "--help");
  expect(h.code).toBe(0);
  expect(h.out).toContain("usage: token-dashboard");
  expect(h.out).toContain("status");
});

test("status exits 1 when no dashboard is running", () => {
  const busy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = String(busy.port);
  busy.stop(true); // a port that was just free
  const r = cli({ ...env(), TD_PORT: port }, "status");
  expect(r.code).toBe(1);
  expect(r.out).toContain(`not running at http://127.0.0.1:${port}`);
});

test("serve writes every listed connection file", async () => {
  const e = env();
  const dir = dirname(e.TD_CONFIG);
  const files = [join(dir, "a", "server.json"), join(dir, "b", "server.json")];
  writeFileSync(e.TD_CONFIG, JSON.stringify({ windowsRoots: false, connectionFiles: files }));
  const port = 47900 + Math.floor(Math.random() * 1000);
  const child = Bun.spawn(["bun", "server/src/cli.ts", "serve"], {
    env: { TZ: "UTC", ...process.env, ...e, TD_PORT: String(port) },
    stdout: "ignore",
    stderr: "inherit",
  });
  try {
    const deadline = Date.now() + 5000;
    while (!files.every((f) => existsSync(f)) && Date.now() < deadline) await Bun.sleep(50);
  } finally {
    child.kill();
    await child.exited;
  }
  for (const f of files)
    expect(JSON.parse(readFileSync(f, "utf8")).url).toBe(`http://127.0.0.1:${port}`);
  expect(existsSync(join(dir, "server.json"))).toBe(false);
});

test("a timezone change rebuilds all rollup days", () => {
  const e = env();
  cli({ ...e, TZ: "UTC" }, "scan"); // fixture responses are at 12:00 UTC on 2026-10-15
  const file = join(e.CLAUDE_CONFIG_DIR, "projects/-home-user-demo/s1.jsonl");
  appendFileSync(
    file,
    `${assistant({ messageId: "msg_new", requestId: "req_new", ts: Date.parse("2026-10-15T13:00:00Z") })}\n`,
  );
  cli({ ...e, TZ: "Pacific/Kiritimati" }, "scan"); // UTC+14: every response falls on 2026-10-16
  const db = openDatabase(join(e.TD_DATA_DIR, "token-dashboard.db"));
  expect(db.query("select distinct day from daily_rollups").all()).toEqual([{ day: "2026-10-16" }]);
  expect(db.query("select sum(request_count) n from daily_rollups").get()).toEqual({ n: 4 });
});

async function readUntil(
  stream: ReadableStream<Uint8Array>,
  pattern: RegExp,
  ms = 5000,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  const deadline = Date.now() + ms;
  try {
    while (!pattern.test(out) && Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        Bun.sleep(deadline - Date.now()).then(() => null),
      ]);
      if (!next || next.done) break;
      out += decoder.decode(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return out;
}

test("watch prices new rows with a price file changed while it runs", async () => {
  const e = env();
  const child = Bun.spawn(["bun", "server/src/cli.ts", "watch"], {
    env: { TZ: "UTC", ...process.env, ...e },
    stdout: "pipe",
    stderr: "inherit",
  });
  try {
    expect(await readUntil(child.stdout, /watching/)).toContain("watching");
    const local = join(dirname(e.TD_CONFIG), "prices.local.json"); // next to TD_CONFIG
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(
      local,
      JSON.stringify({
        schema: 1,
        updated: "2026-11-01",
        currency: "USD",
        server_tools: [],
        models: [
          {
            id: "claude-new-9",
            match: ["claude-new-9"],
            periods: [
              {
                effective_from: null,
                effective_to: null,
                per_mtok: {
                  input: 1,
                  output: 0,
                  cache_read: 0,
                  cache_write_5m: 0,
                  cache_write_1h: 0,
                },
                long_context: null,
                modifiers: { speed: {}, inference_geo: {} },
              },
            ],
          },
        ],
      }),
    );
    const file = join(e.CLAUDE_CONFIG_DIR, "projects/-home-user-demo/s1.jsonl");
    appendFileSync(
      file,
      `${assistant({ messageId: "msg_new", requestId: "req_new", model: "claude-new-9", usage: usage(1_000_000, 0) })}\n`,
    );
    expect(await readUntil(child.stdout, /\+1 requests/)).toContain("+1 requests");
  } finally {
    child.kill();
    await child.exited;
  }
  const db = openDatabase(join(e.TD_DATA_DIR, "token-dashboard.db"));
  expect(
    db.query("select cost_usd, unpriced from requests where message_id = 'msg_new'").get(),
  ).toEqual({ cost_usd: 1, unpriced: 0 });
});

test("a scan killed mid-file leaves rollups that match requests after the next scan", async () => {
  const e = env();
  const file = join(e.CLAUDE_CONFIG_DIR, "projects/-home-user-demo/big.jsonl");
  const day1 = Date.parse("2026-10-14T12:00:00Z");
  const day2 = Date.parse("2026-10-15T12:00:00Z");
  // ~40 MB, several 8 MiB chunks; the first ~3 MB are on day 1, all later chunks on day 2
  const lines: string[] = [];
  for (let i = 0; i < 60_000; i++)
    lines.push(
      assistant({
        sessionId: "big",
        messageId: `big_${i}`,
        requestId: `r_${i}`,
        ts: (i < 5_000 ? day1 : day2) + i,
      }),
    );
  writeFileSync(file, `${lines.join("\n")}\n`);
  const size = Bun.file(file).size;
  const dbPath = join(e.TD_DATA_DIR, "token-dashboard.db");
  const child = Bun.spawn(["bun", "server/src/cli.ts", "scan"], {
    env: { TZ: "UTC", ...process.env, ...e },
    stdout: "ignore",
    stderr: "ignore",
  });
  let killedAt = -1;
  for (let t = 0; t < 2000 && killedAt < 0; t++) {
    await Bun.sleep(2);
    try {
      const db = new Database(dbPath, { readonly: true });
      const row = db.query("select offset from files where path = ?").get(file) as {
        offset: number;
      } | null;
      db.close();
      if (row && row.offset > 0 && row.offset < size) {
        child.kill("SIGKILL");
        killedAt = row.offset;
      }
    } catch {} // db not created yet
  }
  await child.exited;
  expect(killedAt).toBeGreaterThan(0); // the kill really happened mid-file
  cli(e, "scan");
  const db = openDatabase(dbPath);
  const sums = db
    .query(
      `select (select count(*) from requests) r, (select sum(request_count) from daily_rollups) k`,
    )
    .get() as { r: number; k: number };
  expect(sums.k).toBe(sums.r);
  expect(sums.r).toBe(60_000 + 3);
});

test("serve answers health while it scans, then serves the API", async () => {
  const e = env();
  const port = String(40000 + Math.floor(Math.random() * 10000));
  const child = Bun.spawn(["bun", "server/src/cli.ts", "serve"], {
    env: { TZ: "UTC", ...process.env, ...e, TD_PORT: port },
    stdout: "pipe",
    stderr: "inherit",
  });
  try {
    const out = await readUntil(child.stdout, /watching/);
    expect(out).toContain(`dashboard: http://127.0.0.1:${port}`);
    expect(out).toContain("+3 requests");
    const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);
    expect(await (await get("/api/health")).json()).toMatchObject({ ok: true, protocol: 1 });
    expect(await (await get("/api/v1/summary")).json()).toMatchObject({ requests: 3 });
    const st = Bun.spawnSync(["bun", "server/src/cli.ts", "status"], {
      env: { ...process.env, ...e, TD_PORT: port },
    });
    expect(st.exitCode).toBe(0);
    expect(st.stdout.toString()).toContain(`running at http://127.0.0.1:${port}`);
    expect(st.stdout.toString()).toContain("requests stored: 3");
  } finally {
    child.kill();
    await child.exited;
  }
});

test("serve on a busy port exits 1 with a clear message", async () => {
  const e = env();
  const busy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
  try {
    const r = Bun.spawnSync(["bun", "server/src/cli.ts", "serve"], {
      env: { TZ: "UTC", ...process.env, ...e, TD_PORT: String(busy.port) },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(`port ${busy.port} in use (set TD_PORT)`);
  } finally {
    busy.stop(true);
  }
});
