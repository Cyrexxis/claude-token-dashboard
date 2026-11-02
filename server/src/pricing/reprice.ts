import type { Database } from "bun:sqlite";
import { type PriceTable, priceRequest } from "./engine";

type Row = {
  id: number;
  model: string;
  ts: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
  web_search: number;
  speed: string | null;
};

/** Recompute cost for all requests. Returns rows updated. */
export function reprice(db: Database, table: PriceTable): number {
  // Streamed: the whole table is never held in memory. Updates touch only cost columns, not the scan order.
  const rows = db.query<Row, []>(
    "SELECT id, model, ts, input, output, cache_read, cache_write_5m, cache_write_1h, web_search, speed FROM requests",
  );
  type C = number | null;
  const update = db.query<never, [C, string | null, 0 | 1, C, C, C, C, C, C, number]>(
    `UPDATE requests SET cost_usd = ?, price_period_id = ?, unpriced = ?, cost_input = ?, cost_output = ?,
       cost_cache_read = ?, cost_cache_write_5m = ?, cost_cache_write_1h = ?, cost_web_search = ? WHERE id = ?`,
  );
  let n = 0;
  db.transaction(() => {
    for (const r of rows.iterate()) {
      n++;
      const p = priceRequest(table, {
        model: r.model,
        ts: r.ts,
        input: r.input,
        output: r.output,
        cacheRead: r.cache_read,
        cacheWrite5m: r.cache_write_5m,
        cacheWrite1h: r.cache_write_1h,
        webSearch: r.web_search,
        speed: r.speed,
      });
      if ("unpriced" in p) update.run(null, null, 1, null, null, null, null, null, null, r.id);
      else {
        const c = p.parts;
        update.run(
          p.costUsd,
          p.pricePeriodId,
          0,
          c.input,
          c.output,
          c.cacheRead,
          c.cacheWrite5m,
          c.cacheWrite1h,
          c.webSearch,
          r.id,
        );
      }
    }
  })();
  return n;
}
