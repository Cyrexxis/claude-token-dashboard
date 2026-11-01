import type { Database } from "bun:sqlite";
import { loadConfig } from "./config";
import { openDatabase } from "./db/database";
import { bus } from "./events";
import { discoverRoots, listTranscripts } from "./ingest/discovery";
import { ensureSource, ingestFiles, type Root } from "./ingest/ingester";
import { detectPlatform } from "./platform";
import type { PriceTable } from "./pricing/engine";
import { loadPrices, syncPrices } from "./pricing/load";
import { reprice } from "./pricing/reprice";
import { ensureRollupTimezone, rebuildRollups } from "./rollups";
import { getStats } from "./stats";
import { createQueue, startWatching } from "./watch/watcher";

const USAGE = "usage: cli.ts <scan|watch|stats|reprice>";

async function prepare() {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const prices = await loadPrices(config.localPricesPath);
  if (prices.localError) console.error(`local prices ignored: ${prices.localError}`);
  syncPrices(db, prices);
  ensureRollupTimezone(db);
  return { config, db, table: prices.table };
}

async function scan(db: Database, table: PriceTable, roots: Root[]) {
  const sources = new Map<Root, number>();
  let files = 0;
  let added = 0;
  let errors = 0;
  for (const root of roots) {
    const sourceId = ensureSource(db, root);
    sources.set(root, sourceId);
    const paths = listTranscripts(root.rootPath);
    const r = await ingestFiles(db, sourceId, root.rootPath, paths, table);
    db.run("UPDATE sources SET last_scan_at = ? WHERE id = ?", [Date.now(), sourceId]);
    files += paths.length;
    added += r.newRequests;
    errors += r.errors;
  }
  console.log(`scanned ${files} files, +${added} requests, ${errors} errors`);
  return sources;
}

const usd = (n: number) => `$${n.toFixed(6)}`;

async function main(cmd: string | undefined) {
  if (!cmd || !["scan", "watch", "stats", "reprice"].includes(cmd)) {
    console.error(USAGE);
    process.exit(2);
  }
  const { config, db, table } = await prepare();

  if (cmd === "stats") {
    const s = getStats(db);
    console.log("By model");
    console.table(s.byModel.map((m) => ({ ...m, costUsd: usd(m.costUsd) })));
    console.log("By source");
    console.table(s.bySource.map((m) => ({ ...m, costUsd: usd(m.costUsd) })));
    console.log(`Unpriced models: ${s.unpricedModels.join(", ") || "none"}`);
    console.log(
      "Transcript cost vs cost-state (difference = side requests without transcript lines)",
    );
    console.table(
      s.costStateComparison.map((c) => ({
        session: c.sessionId,
        model: c.model,
        transcript: usd(c.transcriptCostUsd),
        costState: usd(c.costStateUsd),
        diff: usd(c.costStateUsd - c.transcriptCostUsd),
      })),
    );
    return;
  }
  if (cmd === "reprice") {
    const n = reprice(db, table);
    rebuildRollups(db, "all");
    console.log(`repriced ${n} requests`);
    return;
  }

  const roots = discoverRoots(detectPlatform(), config);
  const sources = await scan(db, table, roots);
  if (cmd === "scan") return;

  const queue = createQueue();
  const watcher = startWatching({
    roots,
    pollIntervalMs: config.pollIntervalMs,
    onPaths: (root, paths) =>
      void queue(async () => {
        bus.emit("ingest.status", { running: true, files: paths.length, errors: 0 });
        // Prices may have changed since start (local file edited, or another process synced); no-op when the hash matches.
        const prices = await loadPrices(config.localPricesPath);
        syncPrices(db, prices);
        const r = await ingestFiles(
          db,
          sources.get(root) ?? ensureSource(db, root),
          root.rootPath,
          paths,
          prices.table,
        );
        bus.emit("ingest.status", { running: false, files: paths.length, errors: r.errors });
        console.log(
          `${new Date().toISOString()} ${root.rootPath}: +${r.newRequests} requests, ${r.errors} errors`,
        );
      }).catch((e) => console.error(`ingest failed: ${(e as Error).message}`)),
  });
  console.log(`watching ${roots.length} root(s); Ctrl+C to stop`);
  process.on("SIGINT", () => {
    watcher.stop();
    db.close();
    process.exit(0);
  });
}

await main(process.argv[2]);
