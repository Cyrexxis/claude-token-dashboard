import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type IngestState, validatePriceFile } from "@td/shared";
import type { Config } from "./config";
import { bus } from "./events";
import { listTranscripts } from "./ingest/discovery";
import { ensureSource, type IngestResult, ingestFiles, type Root } from "./ingest/ingester";
import type { PriceTable } from "./pricing/engine";
import { loadPrices, syncPrices } from "./pricing/load";
import { createQueue } from "./watch/watcher";

export type IngestService = {
  scanAll(): Promise<{ files: number; newRequests: number; errors: number }>;
  ingestPaths(root: Root, paths: string[]): Promise<IngestResult>;
  /** The mod's "ingest now": one session's files, or every root when the session is not known yet. */
  ingestSession(sessionId: string): Promise<IngestResult & { files: number }>;
  rescanSource(sourceId: number): Promise<IngestResult | null>;
  saveLocalPrices(
    text: string,
  ): Promise<{ ok: true; repriced: number } | { ok: false; errors: string[] }>;
  state(): IngestState;
  localPricesError(): string | null;
};

/** One queue for every job that writes requests or prices, so they never interleave. */
export function createIngestService(db: Database, config: Config, roots: Root[]): IngestService {
  const queue = createQueue();
  let state: IngestState = { running: false, lastRunAt: null, lastFiles: 0, lastErrors: 0 };
  let localError: string | null = null;

  const job = <T extends { files: number; errors: number }>(
    files: number,
    run: (table: PriceTable, repriced: number) => Promise<T>,
  ): Promise<T> =>
    queue(async () => {
      state = { ...state, running: true };
      bus.emit("ingest.status", { running: true, files, errors: 0 });
      let result: T | undefined;
      try {
        // Prices may have changed (local file edited, another process synced); no-op when the hash matches.
        const prices = await loadPrices(config.localPricesPath);
        localError = prices.localError;
        const { repriced } = syncPrices(db, prices);
        result = await run(prices.table, repriced);
        return result;
      } finally {
        state = {
          running: false,
          lastRunAt: Date.now(),
          lastFiles: result?.files ?? files,
          lastErrors: result?.errors ?? 0,
        };
        bus.emit("ingest.status", {
          running: false,
          files: state.lastFiles,
          errors: state.lastErrors,
        });
      }
    });

  const ingestRoot = async (sourceId: number, rootPath: string, table: PriceTable) => {
    const paths = listTranscripts(rootPath);
    const r = await ingestFiles(db, sourceId, rootPath, paths, table);
    db.run("UPDATE sources SET last_scan_at = ? WHERE id = ?", [Date.now(), sourceId]);
    return { ...r, files: paths.length };
  };

  const scanRoots = async (table: PriceTable) => {
    const total = { files: 0, newRequests: 0, errors: 0 };
    for (const root of roots) {
      const r = await ingestRoot(ensureSource(db, root), root.rootPath, table);
      total.files += r.files;
      total.newRequests += r.newRequests;
      total.errors += r.errors;
    }
    return total;
  };

  return {
    scanAll: () => job(0, scanRoots),

    ingestSession: (sessionId) =>
      job(0, async (table) => {
        const known = db
          .query<{ path: string; source_id: number; root_path: string }, [string]>(
            `SELECT f.path, f.source_id, s.root_path FROM files f JOIN sources s ON s.id = f.source_id
             WHERE f.session_id = ?`,
          )
          .all(sessionId);
        const empty = { sessionIds: [], from: null, to: null };
        if (!known.length) return { ...empty, ...(await scanRoots(table)) };
        const bySource = new Map<number, { rootPath: string; paths: Set<string> }>();
        for (const f of known) {
          const src = bySource.get(f.source_id) ?? { rootPath: f.root_path, paths: new Set() };
          bySource.set(f.source_id, src);
          src.paths.add(f.path);
          // <session>.jsonl has a sibling <session>/ folder holding subagent transcripts, new ones included.
          const dir = f.path.replace(/\.jsonl$/, "");
          if (dir !== f.path && existsSync(dir))
            for (const p of new Bun.Glob("**/*.jsonl").scanSync({ cwd: dir, absolute: true }))
              src.paths.add(p);
        }
        const total = { ...empty, files: 0, newRequests: 0, errors: 0 };
        for (const [sourceId, { rootPath, paths }] of bySource) {
          const r = await ingestFiles(db, sourceId, rootPath, [...paths], table);
          total.files += paths.size;
          total.newRequests += r.newRequests;
          total.errors += r.errors;
        }
        return total;
      }),

    ingestPaths: (root, paths) =>
      job(paths.length, async (table) => ({
        ...(await ingestFiles(db, ensureSource(db, root), root.rootPath, paths, table)),
        files: paths.length,
      })),

    async rescanSource(sourceId) {
      const root = db
        .query<{ root_path: string }, [number]>("SELECT root_path FROM sources WHERE id = ?")
        .get(sourceId);
      if (!root) return null;
      return job(0, async (table) => {
        // Forget read offsets; dedup makes re-reading every line safe.
        db.run(
          "UPDATE files SET offset = 0, file_key = NULL, error_count = 0, last_error = NULL WHERE source_id = ?",
          [sourceId],
        );
        return ingestRoot(sourceId, root.root_path, table);
      });
    },

    async saveLocalPrices(text) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        return { ok: false, errors: [(e as Error).message] };
      }
      const v = validatePriceFile(parsed);
      if (!v.ok) return { ok: false, errors: v.errors };
      const path = config.localPricesPath;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, text);
      renameSync(`${path}.tmp`, path); // atomic: the watcher never reads half a file
      const r = await job(0, async (_table, repriced) => ({ files: 0, errors: 0, repriced }));
      return { ok: true, repriced: r.repriced };
    },

    state: () => state,
    localPricesError: () => localError,
  };
}
