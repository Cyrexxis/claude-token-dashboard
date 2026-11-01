import type { On } from "claude-code";
import { type Engine, expect, mock, test } from "claude-code/testing";

const URL_ = "http://127.0.0.1:1";
const CONN = JSON.stringify({ url: URL_, protocol: 1 });

type Sent = { url: string; method?: string; headers?: Record<string, string>; body?: unknown };

/** The engine beneath the mod: connection file, server, store and clock, all in memory. */
function world(on: On, opts: { conn?: string | null; up?: boolean; queue?: string[] } = {}) {
  const sent: Sent[] = [];
  const toasts: string[] = [];
  const store: Record<string, unknown> = opts.queue ? { queue: opts.queue } : {};
  const server = { up: opts.up ?? true };
  const clock = mock.clock(on, { now: 1_000 });
  mock.env(on, { HOME: "/home/u" });
  on("store.get", (_, e) => ({ value: store[e.key] }));
  on("store.set", (_, e) => {
    store[e.key] = e.value;
    return { value: undefined };
  });
  on("fs.read", (_, e) => {
    const conn = opts.conn === undefined ? CONN : opts.conn;
    if (e.path !== "/home/u/.config/token-dashboard/server.json" || conn === null)
      throw new Error("ENOENT");
    return { value: conn };
  });
  on("http.fetch", (_, e) => {
    if (!server.up) throw new Error("ECONNREFUSED");
    const init = e.init ?? {};
    sent.push({
      url: e.url,
      method: init.method,
      headers: init.headers as Record<string, string> | undefined,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    const text = e.url.endsWith("/api/health")
      ? JSON.stringify({ ok: true, version: "0.3.0", protocol: 1 })
      : e.url.endsWith("/api/v1/status")
        ? JSON.stringify({
            version: "0.3.0",
            unpricedModels: ["claude-x"],
            ingest: { lastRunAt: 1, lastErrors: 2 },
            requests: 42,
          })
        : "{}";
    return { value: { status: 200, ok: true, headers: {}, text } };
  });
  on("session.id", () => ({ value: "s1" }));
  const registered: string[] = [];
  on("command.register", (_, e) => {
    registered.push(e.name);
    return { value: { command: e.name } };
  });
  on("classic.SessionStart", () => ({}));
  on("ui.toast", (_, e) => {
    toasts.push(String((e as { text: string }).text));
    return { value: undefined };
  });
  on("process.run", () => ({
    value: {
      exitCode: 0,
      stdout: "",
      stderr: "",
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.measure", (_, e) => ({ changed: e.changed }));
  on("turn.complete", () => ({ text: "" }));
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  on("command.run", () => ({ text: "engine" }));
  const posts = (path: string) => sent.filter((s) => s.url === `${URL_}${path}`);
  return { sent, posts, toasts, store, server, clock, registered };
}

const start = ($: Engine) =>
  $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
const turnEnd = {
  answer: "",
  durationMs: 1,
  isAborted: false,
  turnId: "t1",
  reason: "answer",
} as never;
const WINDOWS = [
  { kind: "five_hour", percentUsed: 12.5, resetsAt: "2026-10-15T17:00:00Z" },
  { kind: "seven_day", percentUsed: 40, resetsAt: "2026-10-20T17:00:00Z" },
];
const measure = (changed: string[], rateLimits = WINDOWS) =>
  ({ context: {}, rateLimits, cost: { usd: 1.5 }, changed }) as never;

test("measure posts the windows", async ($, on) => {
  const w = world(on);
  await start($);
  await $.session.measure(measure(["rateLimits", "cost"]));
  await w.clock.settle();
  const [p] = w.posts("/api/v1/plan-snapshots");
  expect(p?.method).toBe("POST");
  expect(p?.headers?.["X-TD-Protocol"]).toBe("1");
  expect(p?.body).toEqual({ windows: WINDOWS, sessionCostUsd: 1.5 });
});

test("measure with only context changed sends nothing", async ($, on) => {
  const w = world(on);
  await start($);
  await $.session.measure(measure(["context"]));
  await $.session.measure(measure(["rateLimits"], []));
  await w.clock.settle();
  expect(w.posts("/api/v1/plan-snapshots")).toEqual([]);
});

test("turn end posts the trigger", async ($, on) => {
  const w = world(on);
  await start($);
  await $.turn.complete(turnEnd);
  await w.clock.settle();
  expect(w.posts("/api/v1/ingest/trigger").map((p) => p.body)).toEqual([{ sessionId: "s1" }]);
});

test("server down → trigger queued, snapshot dropped", async ($, on) => {
  const w = world(on, { up: false });
  await start($);
  await w.clock.advance(10_000);
  await $.turn.complete(turnEnd);
  await $.session.measure(measure(["rateLimits"]));
  await w.clock.settle();
  expect(w.store.queue).toEqual(["s1"]);
  expect(w.sent).toEqual([]);
});

test("queue flushed on next start", async ($, on) => {
  const w = world(on, { queue: ["s1", "s2"] });
  await start($);
  await w.clock.settle();
  expect(w.posts("/api/v1/ingest/trigger").map((p) => p.body)).toEqual([
    { sessionId: "s1" },
    { sessionId: "s2" },
  ]);
  expect(w.store.queue).toEqual([]);
});

test("queue keeps each session once and at most 200", async ($, on) => {
  const many = Array.from({ length: 200 }, (_, i) => `x${i}`);
  const w = world(on, { up: false, queue: many });
  await start($);
  await w.clock.advance(10_000);
  await $.turn.complete(turnEnd);
  await $.turn.complete(turnEnd);
  await w.clock.settle();
  const q = w.store.queue as string[];
  expect(q).toHaveLength(200);
  expect(q.at(-1)).toBe("s1");
  expect(q[0]).toBe("x1");
});

test("no server.json → one toast, no fetch", async ($, on) => {
  const w = world(on, { conn: null });
  await start($);
  await $.turn.complete(turnEnd);
  await $.turn.complete(turnEnd);
  await w.clock.settle();
  expect(w.sent).toEqual([]);
  expect(w.toasts).toHaveLength(1);
});

test("status command reports the server", async ($, on) => {
  const w = world(on);
  await start($);
  await w.clock.settle();
  const r = await $.command.run({ command: "token-dashboard", args: "status" } as never);
  expect(r.text).toContain("0.3.0");
  expect(r.text).toContain("claude-x");
  expect(r.text).toContain(URL_);
});

test("status command prints unreachable hint", async ($, on) => {
  const w = world(on, { up: false });
  await start($);
  await w.clock.advance(10_000);
  const r = await $.command.run({ command: "token-dashboard", args: "status" } as never);
  expect(r.text).toContain("not reachable");
  expect(r.text).toContain("bun run serve");
});

test("open command prints the link", async ($, on) => {
  const w = world(on);
  await start($);
  const r = await $.command.run({ command: "token-dashboard", args: "open" } as never);
  expect(r.text).toContain(URL_);
  expect(w.toasts).toEqual([]);
});

test("/clear keeps the command: registered again on the new session", async ($, on) => {
  const w = world(on);
  await start($);
  expect(w.registered).toEqual(["token-dashboard"]);
  await $.classic.SessionStart({ source: "clear" } as never);
  await w.clock.settle();
  expect(w.registered).toEqual(["token-dashboard", "token-dashboard"]);
});
