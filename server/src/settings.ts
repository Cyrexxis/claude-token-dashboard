import type { Database } from "bun:sqlite";
import type { Settings } from "@td/shared";
import { BadRequest } from "./api/queries";

const KEYS: Record<keyof Settings, string> = {
  otherProducts: "other_products",
  otherEstimate: "other_estimate",
};

/** User switches kept in the settings table; all off by default. */
export function getSettings(db: Database): Settings {
  const on = (key: string) =>
    db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)
      ?.value === "1";
  return { otherProducts: on(KEYS.otherProducts), otherEstimate: on(KEYS.otherEstimate) };
}

export function saveSettings(db: Database, body: unknown): Settings {
  const b = (body ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(KEYS))
    if (typeof b[k] !== "boolean") throw new BadRequest(`${k} must be a boolean`);
  const s = b as Settings;
  const set = db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  db.transaction(() => {
    set.run(KEYS.otherProducts, s.otherProducts ? "1" : "0");
    // The estimate only refines the feature: it can't be on without it.
    set.run(KEYS.otherEstimate, s.otherProducts && s.otherEstimate ? "1" : "0");
  })();
  return getSettings(db);
}
