import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { type Config, loadConfig } from "../src/config";
import { discoverRoots, listTranscripts } from "../src/ingest/discovery";
import { detectPlatform, type Platform } from "../src/platform";

const tmp = () => mkdtempSync(join(tmpdir(), "td-disc-"));
const mkClaude = (dir: string) => {
  mkdirSync(join(dir, "projects"), { recursive: true });
  return dir;
};
const wsl: Platform = { kind: "wsl", host: "pc", distro: "Ubuntu" };

test("config defaults and env overrides", () => {
  const home = tmp();
  const d = loadConfig({ HOME: home });
  expect(d).toMatchObject({
    dataDir: join(home, ".local/share/token-dashboard/data"),
    dbPath: join(home, ".local/share/token-dashboard/data/token-dashboard.db"),
    configPath: join(home, ".config/token-dashboard/config.json"),
    localPricesPath: join(home, ".config/token-dashboard/prices.local.json"),
    port: 47811,
    extraRoots: [],
    pollIntervalMs: 5000,
    windowsRoots: "auto",
    subscriptionMonthlyUsd: null,
  });
  const cfg = join(home, "c.json");
  writeFileSync(
    cfg,
    JSON.stringify({ pollIntervalMs: 1000, windowsRoots: false, extraRoots: ["/x"] }),
  );
  expect(
    loadConfig({ HOME: home, TD_DATA_DIR: "/x", TD_CONFIG: cfg, TD_PORT: "5000" }),
  ).toMatchObject({
    dbPath: "/x/token-dashboard.db",
    configPath: cfg,
    port: 5000,
    pollIntervalMs: 1000,
    windowsRoots: false,
    extraRoots: ["/x"],
  });
  writeFileSync(cfg, JSON.stringify({ subscriptionMonthlyUsd: 200 }));
  expect(loadConfig({ HOME: home, TD_CONFIG: cfg })).toMatchObject({
    localPricesPath: join(home, "prices.local.json"),
    subscriptionMonthlyUsd: 200,
  });
});

test("invalid config file → clear error", () => {
  const home = tmp();
  const cfg = join(home, "c.json");
  writeFileSync(cfg, JSON.stringify({ pollIntervalMs: "fast" }));
  expect(() => loadConfig({ HOME: home, TD_CONFIG: cfg })).toThrow(/pollIntervalMs/);
  writeFileSync(cfg, JSON.stringify({ subscriptionMonthlyUsd: -5 }));
  expect(() => loadConfig({ HOME: home, TD_CONFIG: cfg })).toThrow(/subscriptionMonthlyUsd/);
  writeFileSync(cfg, "{nope");
  expect(() => loadConfig({ HOME: home, TD_CONFIG: cfg })).toThrow(cfg);
});

test("detectPlatform: wsl via env, wsl via procVersion, linux", () => {
  expect(detectPlatform({ WSL_DISTRO_NAME: "Ubuntu" }, "")).toMatchObject({
    kind: "wsl",
    distro: "Ubuntu",
  });
  expect(detectPlatform({}, "Linux version 6.6.87.2-microsoft-standard-WSL2")).toMatchObject({
    kind: "wsl",
    distro: null,
  });
  expect(detectPlatform({}, "Linux version 6.8.0-generic")).toMatchObject({
    kind: "linux",
    distro: null,
  });
  expect(detectPlatform({}, "").host.length).toBeGreaterThan(0);
});

test("WSL discovers local + /mnt/c users, skipping Default/Public", () => {
  const home = tmp();
  const local = mkClaude(join(home, ".claude"));
  const mnt = tmp();
  for (const u of ["alice", "Default", "Public", "All Users", "Default User"])
    mkClaude(join(mnt, "Users", u, ".claude"));
  mkdirSync(join(mnt, "Users", "bob")); // no .claude
  const config = loadConfig({ HOME: home });
  expect(discoverRoots(wsl, config, { HOME: home }, mnt)).toEqual([
    { kind: "wsl", rootPath: local, host: "pc", distro: "Ubuntu", poll: false },
    {
      kind: "windows",
      rootPath: join(mnt, "Users", "alice", ".claude"),
      host: "pc",
      distro: null,
      poll: true,
    },
  ]);
  expect(discoverRoots(wsl, { ...config, windowsRoots: false }, { HOME: home }, mnt)).toHaveLength(
    1,
  );
  expect(discoverRoots({ ...wsl, kind: "linux" }, config, { HOME: home }, mnt)).toHaveLength(1);
});

test("CLAUDE_CONFIG_DIR overrides ~/.claude; missing roots dropped; extraRoots added", () => {
  const home = tmp();
  mkClaude(join(home, ".claude"));
  const custom = mkClaude(join(tmp(), "cc"));
  const extra = mkClaude(join(tmp(), "extra"));
  const config: Config = {
    ...loadConfig({ HOME: home }),
    windowsRoots: false,
    extraRoots: [extra, "/does/not/exist"],
  };
  expect(
    discoverRoots(wsl, config, { HOME: home, CLAUDE_CONFIG_DIR: custom }).map((r) => [
      r.rootPath,
      r.poll,
    ]),
  ).toEqual([
    [custom, false],
    [extra, false],
  ]);
});

test("listTranscripts finds session and subagent files in the sample fixture", () => {
  const root = resolve("fixtures/transcripts/sample");
  expect(
    listTranscripts(root)
      .map((p) => relative(root, p))
      .sort(),
  ).toEqual([
    "projects/-home-user-demo/s1.jsonl",
    "projects/-home-user-demo/s1/subagents/agent-a1.jsonl",
  ]);
  expect(listTranscripts(join(tmp(), "missing"))).toEqual([]);
});
