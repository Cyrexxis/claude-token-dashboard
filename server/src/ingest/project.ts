import type { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { rebuildRollups } from "../rollups";

// shortcut: never invalidated, so a `git init` after a dir's first session keeps the cwd key until restart.
const cache = new Map<string, string | null>();

/** A Windows path seen from WSL: C:\Users\me\x -> /mnt/c/Users/me/x. */
function toLocal(p: string): string {
  const m = process.platform === "win32" ? null : /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? `/mnt/${m[1]?.toLowerCase()}/${m[2]?.replaceAll("\\", "/")}` : p;
}

function find(start: string): string | null {
  for (let dir = start; ; dir = dirname(dir)) {
    const git = join(dir, ".git");
    try {
      if (statSync(git).isDirectory()) return dir;
      const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(git, "utf8"))?.[1];
      if (gitdir) {
        // Linked worktree: <repo>/.git/worktrees/<name> (or <repo>.git/worktrees/<name> when bare).
        const common = /^(.*)[\\/]worktrees[\\/][^\\/]+$/.exec(resolve(dir, toLocal(gitdir)))?.[1];
        if (!common) return dir; // submodule: its own repo
        return basename(common) === ".git" ? dirname(common) : common;
      }
    } catch {} // no .git here (or the cwd itself is gone: its parents still count)
    if (dirname(dir) === dir) return null;
  }
}

/** Main checkout of the git repo holding cwd, so worktrees and subfolders count as the repo; null outside git. */
export function repoRoot(cwd: string): string | null {
  if (!cache.has(cwd)) cache.set(cwd, find(toLocal(cwd)));
  return cache.get(cwd) ?? null;
}

/** Project key of a session: its repo, else its cwd, else Claude's encoded project folder. */
export const projectKey = (cwd: string | null, folder: string | null): string | null =>
  (cwd && repoRoot(cwd)) || cwd || folder;

/** Once: re-key sessions stored under Claude's encoded folder names, then rebuild the rollups. */
export function ensureProjectKeys(db: Database): void {
  if (db.query("SELECT 1 FROM settings WHERE key = 'project_keys'").get()) return;
  const rows = db
    .query<{ cwd: string }, []>("SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL")
    .all();
  db.transaction(() => {
    const set = db.query("UPDATE sessions SET project = ? WHERE cwd = ?");
    for (const { cwd } of rows) set.run(projectKey(cwd, null), cwd);
    rebuildRollups(db, "all");
    db.run("INSERT INTO settings (key, value) VALUES ('project_keys', 'git')");
  })();
}
