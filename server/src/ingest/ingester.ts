import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { relative, sep } from "node:path";
import { bus } from "../events";
import { type PriceTable, priceRequest } from "../pricing/engine";
import { rebuildRollups } from "../rollups";
import { type Parsed, parseLine } from "./parse";
import { planRead, readLines, statFile } from "./reader";

export type Root = {
  kind: "wsl" | "linux" | "windows";
  rootPath: string;
  host: string;
  distro: string | null;
  poll: boolean;
};
export type IngestResult = {
  newRequests: number;
  sessionIds: string[];
  from: number | null;
  to: number | null;
  errors: number;
};

export function ensureSource(db: Database, root: Root): number {
  return (
    db
      .query<{ id: number }, [string, string, string | null, string]>(
        `INSERT INTO sources (kind, host, distro, root_path) VALUES (?, ?, ?, ?)
         ON CONFLICT(root_path) DO UPDATE SET kind = excluded.kind, host = excluded.host, distro = excluded.distro
         RETURNING id`,
      )
      .get(root.kind, root.host, root.distro, root.rootPath)?.id ?? 0
  );
}

const SUBAGENT = /[/\\]subagents[/\\]agent-([^/\\]+)\.jsonl$/;

type Response = Extract<Parsed, { kind: "response" }>;
type Meta = Extract<Parsed, { kind: "meta" }>;
type CostState = Extract<Parsed, { kind: "cost-state" }>;

function statements(db: Database) {
  return {
    fileRow: db.query<
      { id: number; file_key: string | null; size: number; offset: number; mtime: number | null },
      [string]
    >("SELECT id, file_key, size, offset, mtime FROM files WHERE path = ?"),
    insertFile: db.query<{ id: number }, [number, string]>(
      "INSERT INTO files (source_id, path) VALUES (?, ?) RETURNING id",
    ),
    startFile: db.query("UPDATE files SET file_key = ?, mtime = ?, offset = ? WHERE id = ?"),
    advance: db.query(
      `UPDATE files SET offset = ?, error_count = error_count + ?, last_error = COALESCE(?, last_error),
         session_id = COALESCE(session_id, ?) WHERE id = ?`,
    ),
    finishFile: db.query("UPDATE files SET size = ?, last_ingest_at = ? WHERE id = ?"),
    agentKnown: db.query<{ one: number }, [string]>("SELECT 1 one FROM agents WHERE agent_id = ?"),
    agent: db.query<unknown, [string, string | null, string | null]>(
      "INSERT OR IGNORE INTO agents (agent_id, agent_type, description) VALUES (?, ?, ?)",
    ),
    fileError: db.query(
      "UPDATE files SET error_count = error_count + 1, last_error = ? WHERE path = ?",
    ),
    request: db.query(
      `INSERT INTO requests (message_id, request_id, session_id, agent_id, ts, model, source_id, file_id,
         input, output, cache_read, cache_write_5m, cache_write_1h, thinking, web_search, web_fetch,
         service_tier, speed, inference_geo, effort, is_sidechain, cost_usd, price_period_id, unpriced, usage_raw_json,
         cost_input, cost_output, cost_cache_read, cost_cache_write_5m, cost_cache_write_1h, cost_web_search)
       VALUES ($messageId, $requestId, $sessionId, $agentId, $ts, $model, $sourceId, $fileId,
         $input, $output, $cacheRead, $cacheWrite5m, $cacheWrite1h, $thinking, $webSearch, $webFetch,
         $serviceTier, $speed, $inferenceGeo, $effort, $isSidechain, $costUsd, $pricePeriodId, $unpriced, $usageRaw,
         $costInput, $costOutput, $costCacheRead, $costCacheWrite5m, $costCacheWrite1h, $costWebSearch)
       ON CONFLICT(message_id, request_id) DO UPDATE SET
         input = excluded.input, output = excluded.output, cache_read = excluded.cache_read,
         cache_write_5m = excluded.cache_write_5m, cache_write_1h = excluded.cache_write_1h,
         thinking = excluded.thinking, web_search = excluded.web_search, web_fetch = excluded.web_fetch,
         service_tier = excluded.service_tier, speed = excluded.speed, inference_geo = excluded.inference_geo,
         cost_usd = excluded.cost_usd, price_period_id = excluded.price_period_id, unpriced = excluded.unpriced,
         usage_raw_json = excluded.usage_raw_json, cost_input = excluded.cost_input,
         cost_output = excluded.cost_output, cost_cache_read = excluded.cost_cache_read,
         cost_cache_write_5m = excluded.cost_cache_write_5m, cost_cache_write_1h = excluded.cost_cache_write_1h,
         cost_web_search = excluded.cost_web_search
       WHERE excluded.output > requests.output`,
    ),
    // Latest non-null wins per column; title and ai_title are separate so an AI title never hides a rename.
    session: db.query(
      `INSERT INTO sessions (id, source_id, project, cwd, entrypoint, cc_version, title, ai_title,
         agent_name, agent_color, agent_setting, tag, first_ts, last_ts)
       VALUES ($id, $sourceId, $project, $cwd, $entrypoint, $version, $title, $aiTitle,
         $agentName, $agentColor, $agentSetting, $tag, $ts, $ts)
       ON CONFLICT(id) DO UPDATE SET
         source_id = COALESCE(source_id, excluded.source_id), project = COALESCE(project, excluded.project),
         cwd = COALESCE(excluded.cwd, cwd), entrypoint = COALESCE(excluded.entrypoint, entrypoint),
         cc_version = COALESCE(excluded.cc_version, cc_version), title = COALESCE(excluded.title, title),
         ai_title = COALESCE(excluded.ai_title, ai_title), agent_name = COALESCE(excluded.agent_name, agent_name),
         agent_color = COALESCE(excluded.agent_color, agent_color),
         agent_setting = COALESCE(excluded.agent_setting, agent_setting),
         tag = CASE WHEN $hasTag THEN excluded.tag ELSE tag END,
         first_ts = MIN(COALESCE(first_ts, excluded.first_ts), COALESCE(excluded.first_ts, first_ts)),
         last_ts = MAX(COALESCE(last_ts, excluded.last_ts), COALESCE(excluded.last_ts, last_ts))`,
    ),
    costState: db.query(
      `INSERT INTO cost_states (session_id, start_time, ts, model, input, output, thinking, cache_read,
         cache_write, web_search, cost_usd, total_cost_usd, has_unknown_model_cost)
       VALUES ($sessionId, $startTime, $ts, $model, $input, $output, $thinking, $cacheRead,
         $cacheWrite, $webSearch, $costUsd, $totalCostUsd, $unknown)
       ON CONFLICT(session_id, start_time, model) DO UPDATE SET
         ts = excluded.ts, input = excluded.input, output = excluded.output, thinking = excluded.thinking,
         cache_read = excluded.cache_read, cache_write = excluded.cache_write, web_search = excluded.web_search,
         cost_usd = excluded.cost_usd, total_cost_usd = excluded.total_cost_usd,
         has_unknown_model_cost = excluded.has_unknown_model_cost
       WHERE excluded.ts > cost_states.ts`,
    ),
  };
}

/** Read new bytes of each file, write responses, session metadata and cost states. */
export async function ingestFiles(
  db: Database,
  sourceId: number,
  rootPath: string,
  paths: string[],
  table: PriceTable,
): Promise<IngestResult> {
  const st = statements(db);
  const sessionIds = new Set<string>();
  let newRequests = 0;
  let errors = 0;
  let from: number | null = null;
  let to: number | null = null;
  const touch = (sessionId: string, ts: number) => {
    sessionIds.add(sessionId);
    from = from === null ? ts : Math.min(from, ts);
    to = to === null ? ts : Math.max(to, ts);
  };

  for (const path of paths) {
    const rel = relative(rootPath, path).split(sep);
    const project = rel[0] === "projects" && rel.length > 2 ? rel[1] : null;
    const agentId = SUBAGENT.exec(path)?.[1] ?? null;
    try {
      if (agentId !== null && !st.agentKnown.get(agentId)) await readAgentMeta(st, path, agentId);
      const cur = await statFile(path);
      const row = st.fileRow.get(path);
      const plan = planRead(
        row?.file_key ? { ...row, fileKey: row.file_key, mtimeMs: row.mtime ?? 0 } : null,
        cur,
      );
      if (plan.skip) continue;
      const fileId = row?.id ?? st.insertFile.get(sourceId, path)?.id ?? 0;
      st.startFile.run(cur.fileKey, cur.mtimeMs, plan.start, fileId);

      for await (const chunk of readLines(path, plan.start, cur.size)) {
        db.transaction(() => {
          let bad = 0;
          let lastError: string | null = null;
          let firstSession: string | null = null;
          let chunkFrom = Number.POSITIVE_INFINITY;
          let chunkTo = Number.NEGATIVE_INFINITY;
          for (const line of chunk.lines) {
            if (!line.trim()) continue;
            const p = parseLine(line);
            if (p.kind === "malformed") {
              bad++;
              lastError = p.error;
              continue;
            }
            if (p.kind === "ignored") continue;
            firstSession ??= p.sessionId;
            if (p.kind === "cost-state") {
              if (writeCostState(st, p)) touch(p.sessionId, p.ts);
              continue;
            }
            writeSession(st, p, sourceId, project, agentId !== null);
            if (p.kind === "response" && writeRequest(st, table, p, agentId, sourceId, fileId)) {
              newRequests++;
              touch(p.sessionId, p.ts);
              chunkFrom = Math.min(chunkFrom, p.ts);
              chunkTo = Math.max(chunkTo, p.ts);
            }
          }
          errors += bad;
          // Same transaction as the rows and the offset: a crash can never leave committed rows without rollups.
          if (chunkFrom <= chunkTo) rebuildRollups(db, { from: chunkFrom, to: chunkTo });
          st.advance.run(chunk.endOffset, bad, lastError, firstSession, fileId);
        })();
      }
      st.finishFile.run(cur.size, Date.now(), fileId);
    } catch (e) {
      errors++;
      st.fileError.run((e as Error).message, path); // no-op when the file was never seen
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        console.error(`ingest ${path}: ${(e as Error).message}`);
    }
  }

  if (from !== null && to !== null) {
    bus.emit("usage.updated", { sessionIds: [...sessionIds], from, to });
  }
  return { newRequests, sessionIds: [...sessionIds], from, to, errors };
}

type St = ReturnType<typeof statements>;

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Names a sub-agent from its sibling meta file; retried on later passes while the file is missing. */
async function readAgentMeta(st: St, path: string, agentId: string): Promise<void> {
  const metaPath = path.replace(/\.jsonl$/, ".meta.json");
  if (!existsSync(metaPath)) return;
  try {
    const m = (await Bun.file(metaPath).json()) as Record<string, unknown> | null;
    st.agent.run(agentId, text(m?.agentType), text(m?.description));
  } catch {
    // Unreadable or half-written meta: only the label suffers, so try again next pass.
  }
}

function writeRequest(
  st: St,
  table: PriceTable,
  p: Response,
  agentId: string | null,
  sourceId: number,
  fileId: number,
): boolean {
  const u = p.usage;
  const price = priceRequest(table, { model: p.model, ts: p.ts, ...u });
  const priced = "unpriced" in price ? null : price;
  return (
    st.request.run({
      messageId: p.messageId,
      requestId: p.requestId,
      sessionId: p.sessionId,
      agentId,
      ts: p.ts,
      model: p.model,
      sourceId,
      fileId,
      input: u.input,
      output: u.output,
      cacheRead: u.cacheRead,
      cacheWrite5m: u.cacheWrite5m,
      cacheWrite1h: u.cacheWrite1h,
      thinking: u.thinking,
      webSearch: u.webSearch,
      webFetch: u.webFetch,
      serviceTier: u.serviceTier,
      speed: u.speed,
      inferenceGeo: u.inferenceGeo,
      effort: p.effort,
      isSidechain: p.isSidechain ? 1 : 0,
      costUsd: priced?.costUsd ?? null,
      pricePeriodId: priced?.pricePeriodId ?? null,
      unpriced: priced ? 0 : 1,
      usageRaw: JSON.stringify(p.usageRaw),
      costInput: priced?.parts.input ?? null,
      costOutput: priced?.parts.output ?? null,
      costCacheRead: priced?.parts.cacheRead ?? null,
      costCacheWrite5m: priced?.parts.cacheWrite5m ?? null,
      costCacheWrite1h: priced?.parts.cacheWrite1h ?? null,
      costWebSearch: priced?.parts.webSearch ?? null,
    } as never).changes > 0
  );
}

function writeSession(
  st: St,
  p: Response | Meta,
  sourceId: number,
  project: string | null,
  isSubagentFile: boolean,
): void {
  // A subagent file shares the parent's sessionId: let it extend the time range, not rename the parent.
  const m = p.kind === "meta" && !isSubagentFile ? p : null;
  st.session.run({
    id: p.sessionId,
    sourceId,
    project,
    cwd: p.cwd,
    entrypoint: p.entrypoint,
    version: p.version,
    title: m?.title ?? null,
    aiTitle: m?.aiTitle ?? null,
    agentName: m?.agentName ?? null,
    agentColor: m?.agentColor ?? null,
    agentSetting: m?.agentSetting ?? null,
    tag: m?.tag ?? null,
    hasTag: m && "tag" in m ? 1 : 0,
    ts: p.ts,
  } as never);
}

function writeCostState(st: St, p: CostState): boolean {
  let changed = false;
  for (const m of p.models) {
    const r = st.costState.run({
      sessionId: p.sessionId,
      startTime: p.startTime,
      ts: p.ts,
      model: m.model,
      input: m.input,
      output: m.output,
      thinking: m.thinking,
      cacheRead: m.cacheRead,
      cacheWrite: m.cacheWrite,
      webSearch: m.webSearch,
      costUsd: m.costUsd,
      totalCostUsd: p.totalCostUsd,
      unknown: p.hasUnknownModelCost ? 1 : 0,
    } as never);
    changed ||= r.changes > 0;
  }
  return changed;
}
