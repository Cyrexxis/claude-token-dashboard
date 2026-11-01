import type { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import { createApp } from "./api/app";
import { type Config, loadConfig } from "./config";
import { openDatabase } from "./db/database";
import { discoverRoots } from "./ingest/discovery";
import { detectPlatform } from "./platform";
import { loadPrices, syncPrices } from "./pricing/load";
import { reprice } from "./pricing/reprice";
import { ensureRollupTimezone, rebuildRollups } from "./rollups";
import { createIngestService, type IngestService } from "./service";
import { getStats } from "./stats";
import { startWatching } from "./watch/watcher";

const USAGE = "usage: cli.ts <scan|watch|serve|stats|reprice>";

async function prepare() {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const prices = await loadPrices(config.localPricesPath);
  if (prices.localError) console.error(`local prices ignored: ${prices.localError}`);
  syncPrices(db, prices);
  ensureRollupTimezone(db);
  return { config, db, table: prices.table };
}

const usd = (n: number) => `$${n.toFixed(6)}`;

function serve(db: Database, config: Config, ingest: IngestService) {
  // shortcut: served from disk, phase 4 embeds it in the compiled program
  const webDir = fileURLToPath(new URL("../../web/dist", import.meta.url));
  const app = createApp({ db, config, ingest, startedAt: Date.now(), webDir });
  try {
    // idleTimeout 0: SSE connections stay open indefinitely.
    Bun.serve({ hostname: "127.0.0.1", port: config.port, fetch: app.fetch, idleTimeout: 0 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    console.error(`port ${config.port} in use (set TD_PORT)`);
    process.exit(1);
  }
  console.log(`dashboard: http://127.0.0.1:${config.port}`);
}

async function main(cmd: string | undefined) {
  if (!cmd || !["scan", "watch", "serve", "stats", "reprice"].includes(cmd)) {
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
  const ingest = createIngestService(db, config, roots);
  // Listen before the initial scan so health answers while it runs.
  if (cmd === "serve") serve(db, config, ingest);
  const r = await ingest.scanAll();
  console.log(`scanned ${r.files} files, +${r.newRequests} requests, ${r.errors} errors`);
  if (cmd === "scan") return;

  const watcher = startWatching({
    roots,
    pollIntervalMs: config.pollIntervalMs,
    onPaths: (root, paths) =>
      void ingest
        .ingestPaths(root, paths)
        .then((r) =>
          console.log(
            `${new Date().toISOString()} ${root.rootPath}: +${r.newRequests} requests, ${r.errors} errors`,
          ),
        )
        .catch((e) => console.error(`ingest failed: ${(e as Error).message}`)),
  });
  console.log(`watching ${roots.length} root(s); Ctrl+C to stop`);
  process.on("SIGINT", () => {
    watcher.stop();
    db.close();
    process.exit(0);
  });
}

await main(process.argv[2]);
