import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SERVER_VERSION } from "../version";
import m0001 from "./migrations/0001_init.sql" with { type: "text" };
import m0002 from "./migrations/0002_cost_by_type.sql" with { type: "text" };
import m0003 from "./migrations/0003_agents.sql" with { type: "text" };

// Imported as text so the SQL is embedded in the compiled program. Append new migrations; never edit old ones.
const MIGRATIONS = [m0001, m0002, m0003];
export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA synchronous = NORMAL");
  db.transaction(() => {
    const current =
      db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    for (const sql of MIGRATIONS.slice(current)) db.run(sql);
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.run(
      "INSERT INTO installations (created_at, server_version, schema_version) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM installations)",
      [Date.now(), SERVER_VERSION, SCHEMA_VERSION],
    );
    db.run("UPDATE installations SET schema_version = ?, server_version = ?", [
      SCHEMA_VERSION,
      SERVER_VERSION,
    ]);
  })();
  return db;
}
