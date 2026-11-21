import type { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import { errorMessage, type Status } from "@td/shared";
import { createApp } from "./api/app";
import { type Config, loadConfig } from "./config";
import { writeConnectionFile } from "./connection";
import { openDatabase } from "./db/database";
import { embeddedWeb, isProgram } from "./embedded";
import { discoverRoots } from "./ingest/discovery";
import { type InstallDeps, setup, uninstall, update } from "./install";
import { detectPlatform } from "./platform";
import { loadPrices, syncPrices } from "./pricing/load";
import { reprice } from "./pricing/reprice";
import { ensureRollupTimezone, rebuildRollups } from "./rollups";
import { createIngestService, type IngestService } from "./service";
import { getStats } from "./stats";
import { SERVER_VERSION } from "./version";
import { startWatching } from "./watch/watcher";

const USAGE = `usage: token-dashboard <command>

  serve       run the dashboard and keep ingesting transcripts
  status      show whether the dashboard is running, and what it has stored
  scan        ingest new transcript lines once, then exit
  watch       keep ingesting without serving the dashboard
  stats       print tokens and cost by model and source
  reprice     recompute every request's cost from the price table
  setup [--connection-files wsl|windows|both]
              install and start the token-dashboard service
  update      update the installed service
  uninstall   stop and remove the service
  version     print the version`;
const INSTALL = { setup, update, uninstall };

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
  // from source the UI is read from web/dist; the compiled program serves its embedded copy
  const webDir = fileURLToPath(new URL("../../web/dist", import.meta.url));
  const app = createApp({
    db,
    config,
    ingest,
    startedAt: Date.now(),
    webDir,
    webFiles: embeddedWeb(),
  });
  try {
    // idleTimeout 0: SSE connections stay open indefinitely.
    Bun.serve({ hostname: "127.0.0.1", port: config.port, fetch: app.fetch, idleTimeout: 0 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    console.error(`port ${config.port} in use (set TD_PORT)`);
    process.exit(1);
  }
  const url = `http://127.0.0.1:${config.port}`;
  const files = config.connectionFiles ?? [config.connectionPath];
  for (const p of files) {
    try {
      writeConnectionFile(p, url);
    } catch (e) {
      console.error(`connection file ${p}: ${errorMessage(e)}`); // e.g. /mnt/c not mounted
    }
  }
  console.log(`dashboard: ${url} (connection files: ${files.join(", ")})`);
}

function portFree(port: number): boolean {
  try {
    Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() }).stop(true);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") return false;
    throw e;
  }
}

const CONNECTION_CHOICE: Record<string, string> = { wsl: "1", windows: "2", both: "3" };

function installDeps(args: string[]): InstallDeps {
  const i = args.indexOf("--connection-files");
  const flag = i < 0 ? null : (args[i + 1] ?? "");
  if (flag !== null && !(flag in CONNECTION_CHOICE))
    throw new Error(`--connection-files must be wsl, windows or both (got "${flag}")`);
  return {
    env: process.env,
    config: loadConfig(),
    platform: detectPlatform(),
    repoDir: fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, ""),
    bunPath: process.execPath,
    programPath: isProgram() ? process.execPath : null,
    run: (cmd, opts) => {
      const r = Bun.spawnSync(cmd, { cwd: opts?.cwd, stderr: "pipe" });
      return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
    },
    ask: flag === null ? prompt : () => CONNECTION_CHOICE[flag] ?? null,
    log: console.log,
    portFree,
    sleep: Bun.sleepSync,
  };
}

function status(): number {
  const url = `http://127.0.0.1:${loadConfig().port}`;
  console.log(`program: token-dashboard ${SERVER_VERSION}`);
  // curl, like setup's health check: server/src makes no network connections (SPEC §12)
  const r = Bun.spawnSync(["curl", "-sf", `${url}/api/v1/status`]);
  if (r.exitCode !== 0) {
    console.log(`dashboard: not running at ${url}`);
    return 1;
  }
  const s = JSON.parse(r.stdout.toString()) as Status;
  const when = (t: number | null) => (t ? new Date(t).toLocaleString() : "never");
  console.log(
    [
      `dashboard: running at ${url}`,
      `server: version ${s.version}, protocol ${s.protocol}, schema ${s.schemaVersion}`,
      `started: ${when(s.startedAt)}`,
      `database: ${s.dbPath}`,
      `requests stored: ${s.requests}`,
      `last ingest: ${s.ingest.running ? "running now" : when(s.ingest.lastRunAt)}, ${s.ingest.lastFiles} files, ${s.ingest.lastErrors} errors`,
      `unpriced models: ${s.unpricedModels.join(", ") || "none"}`,
    ].join("\n"),
  );
  return 0;
}

async function main(cmd: string | undefined, args: string[]) {
  if (cmd && ["version", "--version", "-v"].includes(cmd)) return console.log(SERVER_VERSION);
  if (cmd && ["help", "--help", "-h"].includes(cmd)) return console.log(USAGE);
  if (cmd === "status") process.exit(status());
  if (
    !cmd ||
    !["scan", "watch", "serve", "stats", "reprice", ...Object.keys(INSTALL)].includes(cmd)
  ) {
    console.error(USAGE);
    process.exit(2);
  }
  if (cmd in INSTALL) {
    try {
      INSTALL[cmd as keyof typeof INSTALL](installDeps(args));
      return;
    } catch (e) {
      console.error(errorMessage(e));
      process.exit(1);
    }
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
        .catch((e) => console.error(`ingest failed: ${errorMessage(e)}`)),
  });
  console.log(`watching ${roots.length} root(s); Ctrl+C to stop`);
  const stop = () => {
    watcher.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop); // systemd stops services with SIGTERM
}

await main(process.argv[2], process.argv.slice(3));
