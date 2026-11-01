import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config";
import type { Platform } from "../platform";
import type { Root } from "./ingester";

const SKIP_USERS = new Set(["Default", "Default User", "Public", "All Users"]);
const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Claude data roots to ingest: the local one, Windows users' from WSL (polled, no inotify over 9P), extras. */
export function discoverRoots(
  platform: Platform,
  config: Config,
  env: Record<string, string | undefined> = process.env,
  mntRoot = "/mnt/c",
): Root[] {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const local = env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const roots: Root[] = [
    {
      kind: platform.kind,
      rootPath: local,
      host: platform.host,
      distro: platform.distro,
      poll: false,
    },
  ];
  if (platform.kind === "wsl" && config.windowsRoots === "auto") {
    let users: string[] = [];
    try {
      users = readdirSync(join(mntRoot, "Users"));
    } catch {} // /mnt/c not mounted or not readable
    for (const u of users.filter((u) => !SKIP_USERS.has(u)).sort())
      roots.push({
        kind: "windows",
        rootPath: join(mntRoot, "Users", u, ".claude"),
        host: platform.host,
        distro: null,
        poll: true,
      });
  }
  for (const r of config.extraRoots)
    roots.push({
      kind: platform.kind,
      rootPath: r,
      host: platform.host,
      distro: platform.distro,
      poll: r.startsWith("/mnt/"),
    });
  const seen = new Set<string>();
  return roots.filter((r) => isDir(r.rootPath) && !seen.has(r.rootPath) && seen.add(r.rootPath));
}

/** Absolute paths of all transcripts (sessions and subagents) under a root. */
export function listTranscripts(rootPath: string): string[] {
  const projects = join(rootPath, "projects");
  if (!existsSync(projects)) return [];
  return [...new Bun.Glob("**/*.jsonl").scanSync({ cwd: projects, absolute: true })];
}
