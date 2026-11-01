import { type FSWatcher, statSync, watch } from "node:fs";
import { join } from "node:path";
import { listTranscripts } from "../ingest/discovery";
import type { Root } from "../ingest/ingester";

/** Jobs run one at a time, in order; a failing job does not block later ones. */
export function createQueue(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>) => {
    const run = tail.then(job);
    tail = run.catch(() => {});
    return run;
  };
}

export type WatchOptions = {
  roots: Root[];
  onPaths: (root: Root, paths: string[]) => void;
  pollIntervalMs: number;
  debounceMs?: number;
  rescanMs?: number;
  fullGlobMs?: number;
};

const DAY = 24 * 3_600_000;

/** inotify for local roots; stat polling for /mnt/c roots, where 9P delivers no change events. */
export function startWatching(opts: WatchOptions): { stop(): void } {
  const { debounceMs = 250, rescanMs = 300_000, fullGlobMs = 60_000 } = opts;
  const watchers: FSWatcher[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];
  const timeouts = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;
  const report = (root: Root, paths: string[]) => {
    if (!stopped && paths.length) opts.onPaths(root, paths);
  };

  for (const root of opts.roots) {
    if (!root.poll) {
      const projects = join(root.rootPath, "projects");
      const pending = new Set<string>();
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        watchers.push(
          watch(projects, { recursive: true }, (_event, name) => {
            if (!name?.endsWith(".jsonl")) return;
            pending.add(join(projects, name));
            if (timer) return;
            timer = setTimeout(() => {
              if (timer) timeouts.delete(timer);
              timer = null;
              const paths = [...pending];
              pending.clear();
              report(root, paths);
            }, debounceMs);
            timeouts.add(timer);
          }),
        );
      } catch {} // projects/ does not exist yet: the safety rescan picks it up
      timers.push(setInterval(() => report(root, listTranscripts(root.rootPath)), rescanMs));
      continue;
    }

    // shortcut: sync stats on the event loop, fine for a few hundred files; move to async if /mnt/c gets slow.
    const known = new Map<string, string>(); // path → "size:mtime"
    const sig = (p: string) => {
      try {
        const s = statSync(p);
        return { key: `${s.size}:${s.mtimeMs}`, hot: Date.now() - s.mtimeMs < DAY };
      } catch {
        return null;
      }
    };
    const record = (p: string) => {
      const s = sig(p);
      if (s) known.set(p, s.key);
      else known.delete(p);
      return s;
    };
    const pollHot = () => {
      const changed = [...known.keys()].filter((p) => {
        const before = known.get(p);
        const s = record(p);
        return s?.hot && s.key !== before;
      });
      report(root, changed);
    };
    // Report every file, like the local rescan: DB offsets skip unchanged ones, and writes missed
    // before seeding or lost to a failed ingest are retried here.
    const fullGlob = () => {
      const paths = listTranscripts(root.rootPath);
      for (const p of paths) record(p);
      report(root, paths);
    };
    for (const p of listTranscripts(root.rootPath)) record(p);
    timers.push(setInterval(pollHot, opts.pollIntervalMs));
    timers.push(setInterval(fullGlob, fullGlobMs));
  }

  return {
    stop() {
      stopped = true;
      for (const w of watchers) w.close();
      for (const t of timers) clearInterval(t);
      for (const t of timeouts) clearTimeout(t);
    },
  };
}
