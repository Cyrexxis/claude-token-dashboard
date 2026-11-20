import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { rebuildRollups } from "../rollups";

// Cleared by rekeyProjects, so a `git init` after a dir's first session is picked up on demand.
const cache = new Map<string, string | null>();

/** A Windows path seen from WSL: C:\Users\me\x -> /mnt/c/Users/me/x. */
export function toLocal(p: string): string {
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

/** Project key of a session: its repo, else its (WSL) cwd, else Claude's encoded project folder. */
export const projectKey = (cwd: string | null, folder: string | null): string | null =>
  (cwd && (repoRoot(cwd) ?? toLocal(cwd))) || folder;

/** On demand: re-detect every session's repo and store WSL paths, then rebuild the rollups. */
export function rekeyProjects(db: Database): string[] {
  cache.clear();
  const rows = db
    .query<{ id: string; cwd: string; project: string | null }, []>(
      "SELECT id, cwd, project FROM sessions WHERE cwd IS NOT NULL",
    )
    .all();
  // A deleted folder (or unmounted drive) can't be re-detected: keep its saved project, in WSL form.
  const next = (r: (typeof rows)[number]) =>
    r.project && !existsSync(toLocal(r.cwd)) ? toLocal(r.project) : projectKey(r.cwd, null);
  const changed = rows
    .map((r) => ({ ...r, next: next(r) }))
    .filter((r) => toLocal(r.cwd) !== r.cwd || r.next !== r.project);
  if (changed.length === 0) return [];
  db.transaction(() => {
    const set = db.query("UPDATE sessions SET project = ?, cwd = ? WHERE id = ?");
    for (const r of changed) set.run(r.next, toLocal(r.cwd), r.id);
    rebuildRollups(db, "all");
  })();
  return changed.map((r) => r.id);
}
