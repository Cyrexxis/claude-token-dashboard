import type { On } from "claude-code";
import { type Engine, expect, mock, test } from "claude-code/testing";

const URL_ = "http://127.0.0.1:1";
const CONN = JSON.stringify({ url: URL_, protocol: 1 });

type Sent = { url: string; method?: string; headers?: Record<string, string>; body?: unknown };
type Ran = { exitCode: number; stdout?: string; stderr?: string };
type Run = (argv: string[], init?: { cwd?: string }) => Ran;

/** The engine beneath the mod: connection file, server, store and clock, all in memory. */
function world(
  on: On,
  opts: {
    conn?: string | null;
    up?: boolean;
    queue?: string[];
    health?: string;
    env?: Record<string, string>;
    run?: Run;
    asks?: string[];
  } = {},
) {
  const sent: Sent[] = [];
  const toasts: string[] = [];
  const runs: string[][] = [];
  const asked: string[] = [];
  const asks = [...(opts.asks ?? [])];
  const store: Record<string, unknown> = opts.queue ? { queue: opts.queue } : {};
  const server = { up: opts.up ?? true };
  const file = { conn: opts.conn === undefined ? CONN : opts.conn };
  const clock = mock.clock(on, { now: 1_000 });
  mock.env(on, { HOME: "/home/u", ...opts.env });
  on("store.get", (_, e) => ({ value: store[e.key] }));
  on("store.set", (_, e) => {
    store[e.key] = e.value;
    return { value: undefined };
  });
  on("fs.read", (_, e) => {
    if (e.path.endsWith("/.claude-plugin/plugin.json")) return { value: '{"version":"0.4.0"}' };
    if (e.path !== "/home/u/.config/token-dashboard/server.json" || file.conn === null)
      throw new Error("ENOENT");
    return { value: file.conn };
  });
  on("http.fetch", (_, e) => {
    if (!server.up) throw new Error("ECONNREFUSED");
    const init = e.init ?? {};
    sent.push({
      url: e.url,
      method: init.method,
      headers: init.headers as Record<string, string> | undefined,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const text = e.url.endsWith("/api/health")
      ? (opts.health ?? JSON.stringify({ ok: true, version: "0.3.0", protocol: 1 }))
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
  on("ui.status", () => ({ value: undefined }));
  on("process.run", (_, e) => {
    runs.push([...e.argv]);
    const r = opts.run?.([...e.argv], e.init) ?? { exitCode: 0 };
    return {
      value: { stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false, ...r },
    };
  });
  // $.ui.ask raises a tool.call of AskUserQuestion: answer from the list, reject once it runs out.
  on("tool.call", { tool: "AskUserQuestion" }, (_, e) => {
    const q = e.questions[0]?.question ?? "";
    asked.push(q);
    const a = asks.shift();
    if (a === undefined) return { deny: "dismissed" };
    return { result: { questions: e.questions, answers: { [q]: a } } };
  });
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.measure", (_, e) => ({ changed: e.changed }));
  on("turn.complete", () => ({ text: "" }));
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  on("command.run", () => ({ text: "engine" }));
  const posts = (path: string) => sent.filter((s) => s.url === `${URL_}${path}`);
  return { sent, posts, toasts, store, server, file, clock, registered, runs, asked };
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

test("status command survives a non-JSON health body", async ($, on) => {
  const w = world(on, { health: "<html>" });
  await start($);
  await w.clock.settle();
  const r = await $.command.run({ command: "token-dashboard", args: "status" } as never);
  expect(r.text).toContain("unexpected response");
});

test("connection re-read after a failed send", async ($, on) => {
  const w = world(on, { up: false });
  await start($);
  await w.clock.advance(10_000);
  await $.turn.complete(turnEnd);
  await w.clock.settle();
  const other = "http://127.0.0.1:2";
  w.file.conn = JSON.stringify({ url: other, protocol: 1 });
  w.server.up = true;
  await $.turn.complete(turnEnd);
  await w.clock.settle();
  expect(w.sent.filter((s) => s.url === `${other}/api/v1/ingest/trigger`).length).toBeGreaterThan(
    0,
  );
});

test("status command prints unreachable hint", async ($, on) => {
  const w = world(on, { up: false });
  await start($);
  await w.clock.advance(10_000);
  const r = await $.command.run({ command: "token-dashboard", args: "status" } as never);
  expect(r.text).toContain("not reachable");
  expect(r.text).toContain("run /token-dashboard setup");
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

const TMP = "/tmp/td1";
const PROG = `${TMP}/token-dashboard-linux-x64`;
const BASE = "https://github.com/Cyrexxis/claude-token-dashboard/releases/download/v0.4.0/";
const INSTALLED = "/home/u/.local/share/token-dashboard/bin/token-dashboard";
const WSL = { WSL_DISTRO_NAME: "Ubuntu" };

/** A machine where every step of the install works; `over` replaces the step whose argv contains its key. */
const machine =
  (over: Record<string, Ran> = {}): Run =>
  (argv, init) => {
    const line = argv.join(" ");
    const key = Object.keys(over).find((k) => line.includes(k));
    if (key) return over[key] as Ran;
    if (line === "uname -m") return { exitCode: 0, stdout: "x86_64\n" };
    if (line === "mktemp -d") return { exitCode: 0, stdout: `${TMP}\n` };
    if (argv[0] === "sha256sum") return { exitCode: init?.cwd === TMP ? 0 : 1 };
    if (argv[0] === PROG) return { exitCode: 0, stdout: `program ${argv[1]} ran\n` };
    return { exitCode: 0 };
  };
const cmd = ($: Engine, args: string) =>
  $.command.run({ command: "token-dashboard", args } as never) as Promise<{ text: string }>;
const lines = (w: { runs: string[][] }) => w.runs.map((a) => a.join(" "));

test("setup downloads, verifies and runs the program", async ($, on) => {
  const w = world(on, { env: WSL, asks: ["Both", "Install"], run: machine() });
  const r = await cmd($, "setup");
  expect(w.asked).toEqual([
    "Which Claude Code sessions should find the dashboard?",
    "Download Token Dashboard v0.4.0 (linux-x64), install it as the systemd user service token-dashboard and start it?",
  ]);
  expect(lines(w)).toEqual([
    "systemctl --user show-environment",
    "uname -m",
    "mktemp -d",
    `curl -fsSL -o ${PROG} ${BASE}token-dashboard-linux-x64`,
    `curl -fsSL -o ${TMP}/checksums.txt ${BASE}checksums.txt`,
    "sha256sum -c --ignore-missing checksums.txt",
    `chmod +x ${PROG}`,
    `${PROG} setup --connection-files both`,
    `rm -rf ${TMP}`,
  ]);
  expect(r.text).toBe("program setup ran");
});

test("TD_RELEASE_URL replaces the download base", async ($, on) => {
  const w = world(on, {
    env: { TD_RELEASE_URL: "file:///rel/" },
    asks: ["Install"],
    run: machine(),
  });
  await cmd($, "setup");
  expect(lines(w)).toContain(`curl -fsSL -o ${PROG} file:///rel/token-dashboard-linux-x64`);
  expect(lines(w)).toContain(`${PROG} setup --connection-files wsl`); // outside WSL: no question, the flag is ignored
  expect(w.asked).toHaveLength(1);
});

test("update downloads and runs the program's update", async ($, on) => {
  const w = world(on, { asks: ["Update"], run: machine() });
  const r = await cmd($, "update");
  expect(w.asked).toEqual(["Update Token Dashboard to v0.4.0?"]);
  expect(lines(w)).toContain(`${PROG} update`);
  expect(r.text).toBe("program update ran");
});

test("windows session refuses setup", async ($, on) => {
  const w = world(on, { env: { OS: "Windows_NT" }, run: machine() });
  expect((await cmd($, "setup")).text).toBe("Run /token-dashboard setup in a WSL session.");
  expect(w.runs).toEqual([]);
});

test("404 says the release is not published", async ($, on) => {
  const notFound = { exitCode: 22, stderr: "curl: (22) The requested URL returned error: 404" };
  const w = world(on, { asks: ["Install"], run: machine({ curl: notFound }) });
  const r = await cmd($, "setup");
  expect(r.text).toBe("Release v0.4.0 is not published yet; try again later.");
  expect(lines(w).some((l) => l.startsWith(PROG))).toBe(false);
  expect(lines(w).at(-1)).toBe(`rm -rf ${TMP}`);
});

test("other download failures show curl's error", async ($, on) => {
  const down = { exitCode: 6, stderr: "curl: (6) Could not resolve host" };
  world(on, { asks: ["Install"], run: machine({ curl: down }) });
  expect((await cmd($, "setup")).text).toBe("Download failed: curl: (6) Could not resolve host");
});

test("checksum mismatch stops before running the program", async ($, on) => {
  const w = world(on, { asks: ["Install"], run: machine({ sha256sum: { exitCode: 1 } }) });
  const r = await cmd($, "setup");
  expect(r.text).toBe("Checksum mismatch: the download was not installed.");
  expect(lines(w).some((l) => l.includes(PROG) && !l.startsWith("curl"))).toBe(false);
  expect(lines(w).at(-1)).toBe(`rm -rf ${TMP}`);
});

test("a failing program run is reported", async ($, on) => {
  const fail = { exitCode: 1, stdout: "port taken", stderr: "" };
  world(on, { asks: ["Install"], run: machine({ [`${PROG} setup`]: fail }) });
  expect((await cmd($, "setup")).text).toBe("Failed: port taken");
});

test("cancel stops before downloading", async ($, on) => {
  const w = world(on, { asks: ["Cancel"], run: machine() });
  expect((await cmd($, "setup")).text).toBe("Cancelled.");
  expect(lines(w)).toEqual(["systemctl --user show-environment", "uname -m"]);
});

test("dismissed dialog downloads nothing", async ($, on) => {
  const w = world(on, { env: WSL, asks: [], run: machine() });
  expect((await cmd($, "setup")).text).toBe(
    "Run /token-dashboard setup in an interactive session.",
  );
  expect(lines(w).some((l) => l.startsWith("curl") || l.startsWith("mktemp"))).toBe(false);
});

test("no systemd user services stops setup", async ($, on) => {
  const w = world(on, { run: machine({ systemctl: { exitCode: 1 } }) });
  expect((await cmd($, "setup")).text).toContain("systemd user services are not available");
  expect(w.runs).toHaveLength(1);
});

test("unsupported CPU stops setup", async ($, on) => {
  world(on, { run: machine({ "uname -m": { exitCode: 0, stdout: "riscv64\n" } }) });
  expect((await cmd($, "setup")).text).toBe("Unsupported CPU: riscv64");
});

test("update when already current says so", async ($, on) => {
  const w = world(on, { health: JSON.stringify({ ok: true, version: "0.4.0", protocol: 1 }) });
  expect((await cmd($, "update")).text).toBe("Already up to date (v0.4.0).");
  expect(w.asked).toEqual([]);
  expect(lines(w)).toEqual(["systemctl --user show-environment"]);
});

test("update never downgrades a newer server", async ($, on) => {
  const health = JSON.stringify({ ok: true, version: "0.5.0", protocol: 1 });
  const w = world(on, { health, asks: ["Update"], run: machine() });
  expect((await cmd($, "update")).text).toBe("Already up to date (v0.5.0).");
  expect(w.asked).toEqual([]);
  expect(lines(w)).toEqual(["systemctl --user show-environment"]);
});

test("uninstall runs the installed program", async ($, on) => {
  const removed = { exitCode: 0, stdout: "removed\n" };
  const w = world(on, {
    asks: ["Uninstall"],
    run: machine({ [`${INSTALLED} uninstall`]: removed }),
  });
  const r = await cmd($, "uninstall");
  expect(w.asked).toEqual(["Uninstall Token Dashboard? The database and settings are kept."]);
  expect(lines(w)).toEqual([
    "systemctl --user show-environment",
    `test -x ${INSTALLED}`,
    `${INSTALLED} uninstall`,
  ]);
  expect(r.text).toBe("removed");
});

test("uninstall of a checkout install points to bun run uninstall", async ($, on) => {
  const w = world(on, { run: machine({ "test -x": { exitCode: 1 } }) });
  const r = await cmd($, "uninstall");
  expect(r.text).toBe("Installed from a checkout: run bun run uninstall there.");
  expect(lines(w)).toContain("test -f /home/u/.config/systemd/user/token-dashboard.service");
});

test("update of a checkout install points to the checkout and downloads nothing", async ($, on) => {
  const w = world(on, { up: false, run: machine({ "test -x": { exitCode: 1 } }) });
  const r = await cmd($, "update");
  expect(r.text).toBe("Installed from a checkout: run git pull and bun run update there.");
  expect(w.asked).toEqual([]);
  expect(lines(w).some((l) => l.startsWith("curl") || l.startsWith("mktemp"))).toBe(false);
});

test("update with nothing installed says so", async ($, on) => {
  world(on, { up: false, run: machine({ "test -": { exitCode: 1 } }) });
  expect((await cmd($, "update")).text).toBe("Token Dashboard is not installed.");
});

test("setup never downgrades a newer server", async ($, on) => {
  const health = JSON.stringify({ ok: true, version: "0.5.0", protocol: 1 });
  const w = world(on, { health, asks: ["Install"], run: machine() });
  expect((await cmd($, "setup")).text).toContain("A newer Token Dashboard (v0.5.0) is running");
  expect(w.asked).toEqual([]);
  expect(lines(w)).toEqual(["systemctl --user show-environment"]);
});

test("uninstall with nothing installed says so", async ($, on) => {
  world(on, { run: machine({ "test -": { exitCode: 1 } }) });
  expect((await cmd($, "uninstall")).text).toBe("Token Dashboard is not installed.");
});

test("older server shows one update toast", async ($, on) => {
  const w = world(on);
  await start($);
  await w.clock.settle();
  await start($);
  await w.clock.settle();
  expect(w.toasts).toEqual(["Token Dashboard v0.4.0 is ready: run /token-dashboard update"]);
});

test("older server over a checkout install: no update toast", async ($, on) => {
  const w = world(on, { run: machine({ "test -x": { exitCode: 1 } }) });
  await start($);
  await w.clock.settle();
  expect(w.toasts).toEqual([]);
});

test("no update toast in a windows session", async ($, on) => {
  const TD_CONFIG = "/home/u/.config/token-dashboard/config.json"; // finds server.json without APPDATA
  const w = world(on, { env: { OS: "Windows_NT", TD_CONFIG } });
  await start($);
  await w.clock.settle();
  expect(w.toasts).toEqual([]);
});
