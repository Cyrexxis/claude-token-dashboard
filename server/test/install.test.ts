import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/config";
import { type InstallDeps, setup, uninstall, unitFile, unitPath, update } from "../src/install";

const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

type Answer = { code: number; out?: string };
function fake(
  over: { answer?: string | null; respond?: (cmd: string) => Answer | undefined } = {},
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
