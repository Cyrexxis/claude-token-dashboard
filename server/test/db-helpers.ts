import type { Database } from "bun:sqlite";

export type Req = Partial<{
  message_id: string;
  request_id: string;
  session_id: string;
  ts: number;
  model: string;
  source_id: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
  thinking: number;
  web_search: number;
  web_fetch: number;
  speed: string;
  cost_usd: number | null;
  agent_id: string;
  unpriced: number;
}>;

let n = 0;
export function insertRequest(db: Database, r: Req): void {
  const row = {
    message_id: `m${++n}`,
    request_id: "r",
    ts: Date.parse("2026-10-15T12:00:00Z"),
    model: "claude-opus-5-5",
    input: 0,
    output: 0,
    ...r,
  };
  const cols = Object.keys(row);
  db.query(
    `insert into requests (${cols.join(",")}) values (${cols.map((c) => `$${c}`).join(",")})`,
  ).run(row as never);
}

export const all = <T>(db: Database, sql: string, ...params: unknown[]) =>
  db.query(sql).all(...(params as never[])) as T[];
export const one = <T>(db: Database, sql: string, ...params: unknown[]) =>
  db.query(sql).get(...(params as never[])) as T;
