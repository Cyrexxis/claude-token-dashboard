import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database";
import { projectKey, rekeyProjects, repoRoot, toLocal } from "../src/ingest/project";
import { one } from "./db-helpers";

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "td-proj-")));
  const repo = join(base, "repo");
  mkdirSync(join(repo, "sub"), { recursive: true });
  git(repo, "init", "-q");
  git(
    repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "x",
  );
  git(repo, "worktree", "add", "-q", join(repo, ".claude/worktrees/feat"));
  git(repo, "worktree", "add", "-q", join(base, "repo-sibling"));
  return { base, repo };
}

test("repoRoot: repo, subfolder, nested and sibling worktrees, deleted worktree, outside git", () => {
  const { base, repo } = fixture();
  expect(repoRoot(repo)).toBe(repo);
  expect(repoRoot(join(repo, "sub"))).toBe(repo);
  expect(repoRoot(join(repo, ".claude/worktrees/feat"))).toBe(repo);
  expect(repoRoot(join(base, "repo-sibling"))).toBe(repo);
  expect(repoRoot(join(repo, ".claude/worktrees/gone"))).toBe(repo); // removed: its parent is still the repo
  mkdirSync(join(base, "plain"));
  expect(repoRoot(join(base, "plain"))).toBeNull();
  expect(projectKey(join(base, "plain"), "-folder")).toBe(join(base, "plain"));
  expect(projectKey(null, "-folder")).toBe("-folder");
  rmSync(base, { recursive: true, force: true });
});

test("projectKey and toLocal turn Windows paths into WSL paths", () => {
  expect(toLocal("V:\\music\\x")).toBe("/mnt/v/music/x");
  expect(projectKey("C:\\nowhere-td-test", null)).toBe("/mnt/c/nowhere-td-test");
});

test("rekeyProjects re-keys sessions on every call and rebuilds rollups", () => {
  const { base, repo } = fixture();
  const db = openDatabase(":memory:");
  const wt = join(base, "repo-sibling");
  db.run("insert into sessions (id, project, cwd) values ('s1', '-enc-sibling', ?)", [wt]);
  db.run(
    "insert into sessions (id, project, cwd) values ('s2', 'C:\\nowhere-td-test', 'C:\\nowhere-td-test')",
  );
  db.run("insert into requests (message_id, session_id, ts, model) values ('r1', 's1', 0, 'm')");
  expect(rekeyProjects(db).sort()).toEqual(["s1", "s2"]);
  expect(one(db, "select project from sessions where id = 's1'")).toEqual({ project: repo });
  expect(one(db, "select project, cwd from sessions where id = 's2'")).toEqual({
    project: "/mnt/c/nowhere-td-test",
    cwd: "/mnt/c/nowhere-td-test",
  });
  expect(one(db, "select project from daily_rollups")).toEqual({ project: repo });
  db.run("update sessions set project = 'stale' where id = 's1'");
  expect(rekeyProjects(db)).toEqual(["s1"]);
  expect(rekeyProjects(db)).toEqual([]);
  rmSync(base, { recursive: true, force: true });
});

test("rekeyProjects keeps the saved project of a deleted folder, in WSL form", () => {
  const { base, repo } = fixture();
  const db = openDatabase(":memory:");
  db.run("insert into sessions (id, project, cwd) values ('s1', ?, ?)", [repo, join(repo, "sub")]);
  db.run("insert into sessions (id, project, cwd) values ('s2', 'Q:\\gone', 'Q:\\gone\\sub')");
  rmSync(repo, { recursive: true, force: true });
  expect(rekeyProjects(db)).toEqual(["s2"]);
  expect(one(db, "select project from sessions where id = 's1'")).toEqual({ project: repo });
  expect(one(db, "select project, cwd from sessions where id = 's2'")).toEqual({
    project: "/mnt/q/gone",
    cwd: "/mnt/q/gone/sub",
  });
  rmSync(base, { recursive: true, force: true });
});
