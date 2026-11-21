import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/config";
import {
  type InstallDeps,
  installedProgram,
  programDir,
  setup,
  uninstall,
  unitEnv,
  unitFile,
  unitPath,
  update,
} from "../src/install";

const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

type Answer = { code: number; out?: string };
function fake(
  over: {
    answer?: string | null;
    respond?: (cmd: string) => Answer | undefined;
    programPath?: string | null;
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "td-install-"));
  const env = { HOME: home, TD_CONFIG: join(home, "cfg", "config.json") };
  const winAppData = join(home, "winappdata");
  const calls: string[] = [];
  const d: InstallDeps & { calls: string[]; winPath: string; reload: () => void } = {
    env,
    config: loadConfig(env),
    platform: { kind: "wsl", host: "h", distro: "Ubuntu" },
    repoDir: "/repo",
    bunPath: "/bin/bun",
    programPath: over.programPath ?? null,
    run: (cmd) => {
      const c = cmd.join(" ");
      calls.push(c);
      const r = over.respond?.(c);
      if (r) return { code: r.code, out: r.out ?? "" };
      if (cmd[0] === "cmd.exe") return { code: 0, out: "C:\\Users\\U\\AppData\\Roaming\r\n" };
      if (cmd[0] === "wslpath") return { code: 0, out: `${winAppData}\n` };
      if (c.includes("is-active")) return { code: 3, out: "inactive" };
      return { code: 0, out: "" };
    },
    ask: () => (over.answer === undefined ? "3" : over.answer),
    log: () => {},
    portFree: () => true,
    sleep: () => {},
    calls,
    winPath: join(winAppData, "token-dashboard", "server.json"),
    reload: () => {
      d.config = loadConfig(env);
    },
  };
  return d;
}

test("unitFile quotes paths and env", () => {
  expect(
    unitFile({
      bunPath: "/h/my bun/bun",
      repoDir: "/r e/td",
      env: { TD_PORT: "47999", TD_DATA_DIR: "/d", HOME: "/h" },
    }),
  ).toBe(`[Unit]
Description=Token Dashboard

[Service]
ExecStart="/h/my bun/bun" "/r e/td/server/src/cli.ts" serve
WorkingDirectory=/r e/td
Environment="TD_PORT=47999"
Environment="TD_DATA_DIR=/d"
Restart=on-failure

[Install]
WantedBy=default.target
`);
});

test("setup both writes both files, config key, unit and starts", () => {
  const d = fake();
  setup(d);
  const linux = d.config.connectionPath;
  expect(read(linux)).toEqual({
    serverLocation: "wsl",
    start: ["systemctl", "--user", "start", "token-dashboard"],
    url: `http://127.0.0.1:${d.config.port}`,
    protocol: 1,
  });
  expect(read(d.winPath)).toEqual({
    serverLocation: "wsl",
    start: ["wsl.exe", "-d", "Ubuntu", "--", "systemctl", "--user", "start", "token-dashboard"],
    url: `http://127.0.0.1:${d.config.port}`,
    protocol: 1,
  });
  expect(read(d.config.configPath).connectionFiles).toEqual([linux, d.winPath]);
  expect(existsSync(unitPath(d.env))).toBe(true);
  const order = [
    "bun run build:web",
    "systemctl --user daemon-reload",
    "systemctl --user enable token-dashboard",
    "systemctl --user restart token-dashboard",
    `curl -sf http://127.0.0.1:${d.config.port}/api/health`,
  ].map((c) => d.calls.indexOf(c));
  expect(order.every((i) => i >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
});

test("windows-only deletes the default linux file", () => {
  const d = fake({ answer: "2" });
  mkdirSync(dirname(d.config.connectionPath), { recursive: true });
  writeFileSync(d.config.connectionPath, "{}");
  setup(d);
  expect(existsSync(d.config.connectionPath)).toBe(false);
  expect(existsSync(d.winPath)).toBe(true);
  expect(read(d.config.configPath).connectionFiles).toEqual([d.winPath]);
});

test("switching from both to WSL only deletes the windows file", () => {
  const d = fake({ answer: "3" });
  setup(d);
  expect(existsSync(d.winPath)).toBe(true);
  d.reload();
  d.ask = () => "1";
  setup(d);
  expect(existsSync(d.winPath)).toBe(false);
  expect(existsSync(d.config.connectionPath)).toBe(true);
});

test("linux outside WSL does not ask", () => {
  const d = fake();
  d.platform = { kind: "linux", host: "h", distro: null };
  d.ask = () => {
    throw new Error("asked");
  };
  setup(d);
  expect(read(d.config.connectionPath).serverLocation).toBe("linux");
  expect(read(d.config.configPath).connectionFiles).toEqual([d.config.connectionPath]);
  expect(d.calls.some((c) => c.startsWith("cmd.exe"))).toBe(false);
});

test("busy port fails before writing anything", () => {
  const d = fake();
  d.portFree = () => false;
  expect(() => setup(d)).toThrow(/port \d+ is in use/);
  expect(existsSync(d.config.connectionPath)).toBe(false);
  expect(d.calls).not.toContain("bun run build:web");
});

test("rerun with service active skips the port check", () => {
  const d = fake({ respond: (c) => (c.includes("is-active") ? { code: 0 } : undefined) });
  d.portFree = () => false;
  setup(d);
  expect(existsSync(d.config.connectionPath)).toBe(true);
});

test("web build failure writes nothing", () => {
  const d = fake({ respond: (c) => (c === "bun run build:web" ? { code: 1 } : undefined) });
  expect(() => setup(d)).toThrow("web build failed");
  expect(existsSync(d.config.connectionPath)).toBe(false);
  expect(existsSync(d.winPath)).toBe(false);
});

test("unknown choice fails before writing anything", () => {
  const d = fake({ answer: "7" });
  expect(() => setup(d)).toThrow("unknown choice: 7");
  expect(existsSync(d.config.connectionPath)).toBe(false);
});

test("health never answers", () => {
  const d = fake({ respond: (c) => (c.startsWith("curl") ? { code: 7 } : undefined) });
  expect(() => setup(d)).toThrow(/journalctl --user -u token-dashboard/);
  expect(d.calls.filter((c) => c.startsWith("curl"))).toHaveLength(20);
});

test("config.json keeps user keys", () => {
  const d = fake();
  mkdirSync(dirname(d.config.configPath), { recursive: true });
  writeFileSync(d.config.configPath, JSON.stringify({ subscriptionMonthlyUsd: 100 }));
  setup(d);
  expect(read(d.config.configPath)).toEqual({
    subscriptionMonthlyUsd: 100,
    connectionFiles: [d.config.connectionPath, d.winPath],
  });
});

test("missing Windows APPDATA fails before writing anything", () => {
  const d = fake({ respond: (c) => (c.startsWith("wslpath") ? { code: 1 } : undefined) });
  expect(() => setup(d)).toThrow("cannot find the Windows %APPDATA% folder");
  expect(existsSync(d.config.connectionPath)).toBe(false);
});

test("update requires an installed unit", () => {
  expect(() => update(fake())).toThrow("not installed; run: bun run setup");
});

test("update installs, rebuilds, restarts, checks health", () => {
  const d = fake();
  setup(d);
  d.calls.length = 0;
  update(d);
  expect(d.calls).toEqual([
    "bun install",
    "bun run build:web",
    "systemctl --user restart token-dashboard",
    `curl -sf http://127.0.0.1:${d.config.port}/api/health`,
  ]);
});

test("uninstall removes files, unit and key", () => {
  const d = fake();
  mkdirSync(dirname(d.config.configPath), { recursive: true });
  writeFileSync(d.config.configPath, JSON.stringify({ subscriptionMonthlyUsd: 100 }));
  mkdirSync(dirname(d.config.dbPath), { recursive: true });
  writeFileSync(d.config.dbPath, "db");
  setup(d);
  d.reload();
  uninstall(d);
  expect(existsSync(d.config.connectionPath)).toBe(false);
  expect(existsSync(d.winPath)).toBe(false);
  expect(existsSync(unitPath(d.env))).toBe(false);
  expect(read(d.config.configPath)).toEqual({ subscriptionMonthlyUsd: 100 });
  expect(d.calls).toContain("systemctl --user disable --now token-dashboard");
  expect(existsSync(d.config.dbPath)).toBe(true);
});

test("uninstall when never installed does not fail", () => {
  const d = fake({ respond: (c) => (c.includes("disable") ? { code: 1 } : undefined) });
  uninstall(d);
  expect(existsSync(d.config.configPath)).toBe(false);
});

test("setup announces the long steps before running them", () => {
  const d = fake();
  const seen: string[] = [];
  d.log = (l) => seen.push(`log:${l}`);
  const run = d.run;
  d.run = (cmd, o) => {
    seen.push(`run:${cmd.join(" ")}`);
    return run(cmd, o);
  };
  setup(d);
  const build = seen.indexOf("run:bun run build:web");
  expect(seen[build - 1]).toBe("log:building the web UI…");
  const restart = seen.indexOf("run:systemctl --user daemon-reload");
  expect(seen[restart - 1]).toBe("log:installing and starting the token-dashboard service…");
});

test("unitFile escapes systemd specifiers, quotes and backslashes", () => {
  const unit = unitFile({
    bunPath: "/b/bun",
    repoDir: "/r",
    env: { TD_CONFIG: '/a/50%/"q"\\x', HOME: "/h" },
  });
  expect(unit).toContain('Environment="TD_CONFIG=/a/50%%/\\"q\\"\\\\x"\n');
});

// --- program mode ---
function program(d: { env: Record<string, string | undefined> }, bytes = "NEW") {
  const p = join(d.env.HOME as string, "src-program");
  writeFileSync(p, bytes);
  return p;
}
const progFake = (over: Parameters<typeof fake>[0] = {}) => {
  const home = mkdtempSync(join(tmpdir(), "td-prog-"));
  const p = join(home, "src-program");
  writeFileSync(p, "NEW");
  return fake({ ...over, programPath: p });
};
const healthFails = (c: string) => (c.includes("/api/health") ? { code: 22 } : undefined);

test("program unitFile has no WorkingDirectory", () => {
  expect(unitFile({ program: "/h/p rog", env: { TD_PORT: "1" } })).toBe(`[Unit]
Description=Token Dashboard

[Service]
ExecStart="/h/p rog" serve
Environment="TD_PORT=1"
Restart=on-failure

[Install]
WantedBy=default.target
`);
});

test("unitEnv reads back what unitFile wrote", () => {
  const e = { TD_PORT: "1", TD_DATA_DIR: '/a "b" %c\\d' };
  expect(unitEnv(unitFile({ program: "/p", env: e }))).toEqual(e);
});

test("program setup copies itself, skips the web build, unit points at the copy", () => {
  const d = progFake();
  setup(d);
  const dest = installedProgram(d.env);
  expect(readFileSync(dest, "utf8")).toBe("NEW");
  expect(statSync(dest).mode & 0o777).toBe(0o755);
  expect(d.calls.some((c) => c.includes("build:web"))).toBe(false);
  expect(readFileSync(unitPath(d.env), "utf8")).toContain(`ExecStart="${dest}" serve`);
});

test("program setup replaces a checkout unit", () => {
  const d = fake({ respond: (c) => (c.includes("is-active") ? { code: 0 } : undefined) });
  setup(d);
  expect(readFileSync(unitPath(d.env), "utf8")).toContain("WorkingDirectory");
  d.programPath = program(d);
  setup(d);
  const unit = readFileSync(unitPath(d.env), "utf8");
  expect(unit).not.toContain("WorkingDirectory");
  expect(unit).toContain("serve");
  expect(unit).toContain(installedProgram(d.env));
});

test("setup from the installed program does not copy itself", () => {
  const d = fake();
  const dest = installedProgram(d.env);
  mkdirSync(programDir(d.env), { recursive: true });
  writeFileSync(dest, "SAME");
  d.programPath = dest;
  setup(d);
  expect(readFileSync(dest, "utf8")).toBe("SAME");
  expect(existsSync(`${dest}.prev`)).toBe(false);
});

test("second program setup keeps the old program as .prev", () => {
  const d = progFake();
  setup(d);
  writeFileSync(d.programPath as string, "NEWER");
  setup(d);
  const dest = installedProgram(d.env);
  expect(readFileSync(dest, "utf8")).toBe("NEWER");
  expect(readFileSync(`${dest}.prev`, "utf8")).toBe("NEW");
});

test("update keeps the unit's environment", () => {
  const d = progFake();
  d.env.TD_PORT = "47999";
  setup(d);
  d.env.TD_PORT = "1";
  update(d);
  expect(readFileSync(unitPath(d.env), "utf8")).toContain('Environment="TD_PORT=47999"');
});

test("update restores .prev when health fails", () => {
  const d = progFake();
  setup(d);
  const dest = installedProgram(d.env);
  // only the new program fails its health check
  d.run = (
    (run) => (cmd: string[], o?: { cwd?: string }) =>
      cmd[0] === "curl" && readFileSync(dest, "utf8") === "BAD"
        ? { code: 22, out: "" }
        : run(cmd, o)
  )(d.run);
  writeFileSync(d.programPath as string, "BAD");
  d.calls.length = 0;
  expect(() => update(d)).toThrow("previous version restored");
  expect(readFileSync(dest, "utf8")).toBe("NEW");
  expect(d.calls.filter((c) => c.endsWith("restart token-dashboard"))).toHaveLength(2);
});

test("update says so when the restored version does not start either", () => {
  const d = progFake();
  setup(d);
  d.run = (
    (run) => (cmd: string[], o?: { cwd?: string }) =>
      cmd[0] === "curl" ? { code: 22, out: "" } : run(cmd, o)
  )(d.run);
  writeFileSync(d.programPath as string, "BAD");
  expect(() => update(d)).toThrow("the previous version did not start either");
  expect(readFileSync(installedProgram(d.env), "utf8")).toBe("NEW");
});

test("update over a checkout install restores the old unit on failure", () => {
  // health fails while the new program is installed, and answers again after the rollback
  const d = fake({
    respond: (c) => (existsSync(installedProgram(d.env)) ? healthFails(c) : undefined),
  });
  const unit = unitPath(d.env);
  mkdirSync(dirname(unit), { recursive: true });
  const old = unitFile(d);
  writeFileSync(unit, old);
  d.programPath = program(d);
  expect(() => update(d)).toThrow("previous version restored");
  expect(readFileSync(unit, "utf8")).toBe(old);
  expect(existsSync(installedProgram(d.env))).toBe(false);
});

test("update over a checkout install: a failing restart restores the old state", () => {
  let restarts = 0;
  const d = fake({
    respond: (c) =>
      c.endsWith("restart token-dashboard") && restarts++ === 0 ? { code: 1 } : undefined,
  });
  const unit = unitPath(d.env);
  mkdirSync(dirname(unit), { recursive: true });
  const old = unitFile(d);
  writeFileSync(unit, old);
  d.programPath = program(d);
  expect(() => update(d)).toThrow("previous version restored");
  expect(readFileSync(unit, "utf8")).toBe(old);
  expect(existsSync(installedProgram(d.env))).toBe(false);
});

test("checkout setup removes a leftover program folder", () => {
  const d = fake();
  mkdirSync(programDir(d.env), { recursive: true });
  writeFileSync(installedProgram(d.env), "x");
  setup(d);
  expect(existsSync(programDir(d.env))).toBe(false);
});

test("uninstall removes the program folder", () => {
  const d = progFake();
  setup(d);
  uninstall(d);
  expect(existsSync(programDir(d.env))).toBe(false);
});

test("update from the installed program does not roll back to an older .prev", () => {
  const d = fake();
  const dest = installedProgram(d.env);
  mkdirSync(programDir(d.env), { recursive: true });
  writeFileSync(dest, "CURRENT");
  writeFileSync(`${dest}.prev`, "OLDER");
  const unit = unitPath(d.env);
  mkdirSync(dirname(unit), { recursive: true });
  const old = unitFile(d);
  writeFileSync(unit, old);
  d.programPath = dest;
  d.run = (
    (run) => (cmd: string[], o?: { cwd?: string }) =>
      cmd[0] === "curl" ? { code: 22, out: "" } : run(cmd, o)
  )(d.run);
  expect(() => update(d)).toThrow("update failed");
  expect(readFileSync(dest, "utf8")).toBe("CURRENT");
  expect(readFileSync(unit, "utf8")).toBe(old);
});

test("a failed copy leaves the installed program and no temp file", () => {
  const d = fake();
  const dest = installedProgram(d.env);
  mkdirSync(programDir(d.env), { recursive: true });
  writeFileSync(dest, "KEEP");
  d.programPath = join(d.env.HOME as string, "missing-program");
  expect(() => setup(d)).toThrow();
  expect(readFileSync(dest, "utf8")).toBe("KEEP");
  expect(readdirSync(programDir(d.env))).toEqual(["token-dashboard"]);
});
