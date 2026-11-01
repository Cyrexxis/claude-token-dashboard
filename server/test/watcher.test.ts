import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Root } from "../src/ingest/ingester";
import { createQueue, startWatching } from "../src/watch/watcher";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

function root(poll: boolean) {
  const rootPath = mkdtempSync(join(tmpdir(), "td-watch-"));
  const file = join(rootPath, "projects", "p", "s.jsonl");
  mkdirSync(join(rootPath, "projects", "p"), { recursive: true });
  writeFileSync(file, "a\n");
  const r: Root = { kind: "linux", rootPath, host: "h", distro: null, poll };
  return { r, rootPath, file };
}
function watch(r: Root, opts: { pollIntervalMs?: number; fullGlobMs?: number } = {}) {
  const calls: string[][] = [];
  const w = startWatching({
    roots: [r],
    onPaths: (_root, paths) => calls.push(paths),
    pollIntervalMs: opts.pollIntervalMs ?? 50,
    debounceMs: 50,
    fullGlobMs: opts.fullGlobMs,
  });
  stops.push(w.stop);
  return { calls, stop: w.stop };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 1000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(10);
  return cond();
}

test("queue serializes jobs and survives a rejection", async () => {
  const q = createQueue();
  const order: number[] = [];
  let running = 0;
  let max = 0;
  const job =
    (n: number, fail = false) =>
    async () => {
      running++;
      max = Math.max(max, running);
      await sleep(5);
      order.push(n);
      running--;
      if (fail) throw new Error("boom");
      return n;
    };
  const results = await Promise.allSettled([q(job(1)), q(job(2, true)), q(job(3))]);
  expect(order).toEqual([1, 2, 3]);
  expect(max).toBe(1);
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
});

test("watched root reports an appended file within 1s", async () => {
  const { r, file } = root(false);
  const { calls } = watch(r);
  await sleep(50);
  appendFileSync(file, "b\n");
  expect(await until(() => calls.flat().includes(file))).toBe(true);
});

test("watched root reports a new file in a new folder", async () => {
  const { r, rootPath } = root(false);
  const { calls } = watch(r);
  await sleep(50);
  const dir = join(rootPath, "projects", "q", "s2", "subagents");
  mkdirSync(dir, { recursive: true });
  await sleep(50);
  const f = join(dir, "agent-x.jsonl");
  writeFileSync(f, "x\n");
  expect(await until(() => calls.flat().includes(f))).toBe(true);
});

test("polled root reports a changed hot file and a new file", async () => {
  const { r, file, rootPath } = root(true);
  const { calls } = watch(r, { pollIntervalMs: 50, fullGlobMs: 150 });
  await sleep(80);
  expect(calls).toEqual([]); // the hot poll does not report unchanged files
  appendFileSync(file, "b\n");
  expect(await until(() => calls.flat().includes(file))).toBe(true);
  const f2 = join(rootPath, "projects", "p", "new.jsonl");
  writeFileSync(f2, "n\n");
  expect(await until(() => calls.flat().includes(f2))).toBe(true);
});

test("stop() ends all timers and watchers", async () => {
  const w = root(false);
  const p = root(true);
  const a = watch(w.r);
  const b = watch(p.r, { pollIntervalMs: 20 });
  await sleep(50);
  a.stop();
  b.stop();
  appendFileSync(w.file, "z\n");
  appendFileSync(p.file, "z\n");
  await sleep(200);
  expect([...a.calls, ...b.calls]).toEqual([]);
});

test("polled root: the full re-glob reports every file, so changes before seeding are not lost", async () => {
  const { r, file } = root(true);
  // a write that happened after `scan` read the file but before the watcher started
  const { calls } = watch(r, { pollIntervalMs: 1000, fullGlobMs: 100 });
  expect(await until(() => calls.flat().includes(file), 500)).toBe(true);
});
