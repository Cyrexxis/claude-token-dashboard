import type { Database } from "bun:sqlite";

export type Stats = {
  byModel: {
    model: string;
    requests: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    costUsd: number;
  }[];
  bySource: {
    kind: string;
    host: string;
    label: "cli" | "desktop";
    requests: number;
    costUsd: number;
  }[];
  unpricedModels: string[];
  costStateComparison: {
    sessionId: string;
    model: string;
    transcriptCostUsd: number;
    costStateUsd: number;
  }[];
};

export function getStats(db: Database): Stats {
  return {
    byModel: db
      .query<Stats["byModel"][number], []>(
        `SELECT model, COUNT(*) requests, SUM(input) input, SUM(output) output, SUM(cache_read) cacheRead,
           SUM(cache_write_5m) cacheWrite5m, SUM(cache_write_1h) cacheWrite1h, TOTAL(cost_usd) costUsd
         FROM requests GROUP BY model ORDER BY costUsd DESC, model`,
      )
      .all(),
    bySource: db
      .query<Stats["bySource"][number], []>(
        `SELECT so.kind, so.host, CASE WHEN se.entrypoint = 'claude-desktop' THEN 'desktop' ELSE 'cli' END label,
           COUNT(*) requests, TOTAL(r.cost_usd) costUsd
         FROM requests r JOIN sources so ON so.id = r.source_id LEFT JOIN sessions se ON se.id = r.session_id
         GROUP BY 1, 2, 3 ORDER BY costUsd DESC`,
      )
      .all(),
    unpricedModels: db
      .query<{ model: string }, []>(
        "SELECT DISTINCT model FROM requests WHERE unpriced = 1 ORDER BY model",
      )
      .all()
      .map((r) => r.model),
    // cost-state covers side requests (titles, web summaries) that have no transcript line.
    costStateComparison: db
      .query<Stats["costStateComparison"][number], []>(
        `SELECT c.session_id sessionId, c.model, SUM(c.cost_usd) costStateUsd,
           (SELECT TOTAL(r.cost_usd) FROM requests r WHERE r.session_id = c.session_id AND r.model = c.model) transcriptCostUsd
         FROM cost_states c GROUP BY c.session_id, c.model ORDER BY c.session_id, c.model`,
      )
      .all(),
  };
}
