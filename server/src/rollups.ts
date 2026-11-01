import type { Database } from "bun:sqlite";

const DAY = "date(r.ts / 1000, 'unixepoch', 'localtime')";
const INSERT = `
  INSERT INTO daily_rollups (day, source_id, model, project, input, output, cache_read, cache_write_5m,
    cache_write_1h, thinking, web_search, web_fetch, cost_usd, request_count, cost_input, cost_output,
    cost_cache_read, cost_cache_write_5m, cost_cache_write_1h, cost_web_search)
  SELECT ${DAY}, r.source_id, r.model, COALESCE(s.project, ''), SUM(r.input), SUM(r.output), SUM(r.cache_read),
    SUM(r.cache_write_5m), SUM(r.cache_write_1h), SUM(r.thinking), SUM(r.web_search), SUM(r.web_fetch),
    TOTAL(r.cost_usd), COUNT(*), TOTAL(r.cost_input), TOTAL(r.cost_output), TOTAL(r.cost_cache_read),
    TOTAL(r.cost_cache_write_5m), TOTAL(r.cost_cache_write_1h), TOTAL(r.cost_web_search)
  FROM requests r LEFT JOIN sessions s ON s.id = r.session_id`;
const GROUP = "GROUP BY 1, 2, 3, 4";

/** Rebuild daily_rollups for every server-local day touched by [from, to] (ms), or for all days. */
export function rebuildRollups(db: Database, range: { from: number; to: number } | "all"): void {
  db.transaction(() => {
    if (range === "all") {
      db.run("DELETE FROM daily_rollups");
      db.run(`${INSERT} ${GROUP}`);
      return;
    }
    const firstDay = "date(?1 / 1000, 'unixepoch', 'localtime')";
    const lastDay = "date(?2 / 1000, 'unixepoch', 'localtime')";
    db.run(`DELETE FROM daily_rollups WHERE day BETWEEN ${firstDay} AND ${lastDay}`, [
      range.from,
      range.to,
    ]);
    // Local-day bounds in UTC ms, so the ts index is used.
    db.run(
      `${INSERT} WHERE r.ts >= CAST(strftime('%s', ${firstDay}, 'utc') AS INTEGER) * 1000
         AND r.ts < CAST(strftime('%s', ${lastDay}, '+1 day', 'utc') AS INTEGER) * 1000 ${GROUP}`,
      [range.from, range.to],
    );
  })();
}

/** Rollup days follow the process timezone; after a change every day must be rebuilt, not just new ones. */
export function ensureRollupTimezone(db: Database): void {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const stored = db
    .query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'rollup_timezone'")
    .get()?.value;
  if (stored === tz) return;
  db.transaction(() => {
    if (stored !== undefined) rebuildRollups(db, "all");
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('rollup_timezone', ?)", [tz]);
  })();
}
