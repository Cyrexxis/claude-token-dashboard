import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Config = {
  dataDir: string;
  dbPath: string;
  configPath: string;
  localPricesPath: string;
  connectionPath: string;
  port: number;
  extraRoots: string[];
  pollIntervalMs: number;
  windowsRoots: "auto" | false;
  subscriptionMonthlyUsd: number | null;
};
type Env = Record<string, string | undefined>;

/** Defaults per SPEC §13, overridden by TD_* env vars and the optional config.json. */
export function loadConfig(env: Env = process.env): Config {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const win = process.platform === "win32";
  const dataRoot =
    win && env.LOCALAPPDATA
      ? join(env.LOCALAPPDATA, "token-dashboard")
      : join(home, ".local/share/token-dashboard");
  const configRoot =
    win && env.APPDATA
      ? join(env.APPDATA, "token-dashboard")
      : join(home, ".config/token-dashboard");
  const dataDir = env.TD_DATA_DIR ?? join(dataRoot, "data");
  const configPath = env.TD_CONFIG ?? join(configRoot, "config.json");
  const file = readConfigFile(configPath);
  const port = env.TD_PORT ? Number(env.TD_PORT) : 47811;
  if (!Number.isInteger(port) || port <= 0 || port > 65535)
    throw new Error(`TD_PORT is not a valid port: ${env.TD_PORT}`);
  return {
    dataDir,
    dbPath: join(dataDir, "token-dashboard.db"),
    configPath,
    // Next to config.json, so TD_CONFIG isolates every config file.
    localPricesPath: join(dirname(configPath), "prices.local.json"),
    connectionPath: join(dirname(configPath), "server.json"),
    port,
    extraRoots: file.extraRoots ?? [],
    pollIntervalMs: file.pollIntervalMs ?? 5000,
    windowsRoots: file.windowsRoots ?? "auto",
    subscriptionMonthlyUsd: file.subscriptionMonthlyUsd ?? null,
  };
}

function readConfigFile(
  path: string,
): Partial<
  Pick<Config, "extraRoots" | "pollIntervalMs" | "windowsRoots" | "subscriptionMonthlyUsd">
> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`${path}: ${(e as Error).message}`);
  }
  const c = (raw ?? {}) as Record<string, unknown>;
  const bad = (k: string, want: string) => new Error(`${path}: "${k}" must be ${want}`);
  if (
    c.extraRoots !== undefined &&
    !(Array.isArray(c.extraRoots) && c.extraRoots.every((r) => typeof r === "string"))
  )
    throw bad("extraRoots", "an array of paths");
  if (
    c.pollIntervalMs !== undefined &&
    !(typeof c.pollIntervalMs === "number" && c.pollIntervalMs >= 100)
  )
    throw bad("pollIntervalMs", "a number >= 100");
  if (c.windowsRoots !== undefined && c.windowsRoots !== "auto" && c.windowsRoots !== false)
    throw bad("windowsRoots", '"auto" or false');
  if (
    c.subscriptionMonthlyUsd !== undefined &&
    !(typeof c.subscriptionMonthlyUsd === "number" && c.subscriptionMonthlyUsd >= 0)
  )
    throw bad("subscriptionMonthlyUsd", "a number >= 0");
  return c as Partial<Config>;
}
