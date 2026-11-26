import type { Database } from "bun:sqlite";
import type { Settings } from "@td/shared";
import { BadRequest } from "./api/queries";

const KEYS: Record<keyof Settings, string> = {
  otherProducts: "other_products",
  otherEstimate: "other_estimate",
  resetPercent: "reset_percent",
};
const RESET_PERCENT = 5;

/** User settings kept in the settings table; switches off by default. */
export function getSettings(db: Database): Settings {
  const get = (key: string) =>
    db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)
      ?.value;
  return {
    otherProducts: get(KEYS.otherProducts) === "1",
    otherEstimate: get(KEYS.otherEstimate) === "1",
    resetPercent: Number(get(KEYS.resetPercent) ?? RESET_PERCENT),
  };
}

export function saveSettings(db: Database, body: unknown): Settings {
  const b = (body ?? {}) as Record<string, unknown>;
  for (const k of ["otherProducts", "otherEstimate"])
    if (typeof b[k] !== "boolean") throw new BadRequest(`${k} must be a boolean`);
  const p = b.resetPercent;
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 100)
    throw new BadRequest("resetPercent must be a number 0–100");
  const s = b as Settings;
  const set = db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  db.transaction(() => {
    set.run(KEYS.otherProducts, s.otherProducts ? "1" : "0");
    // The estimate only refines the feature: it can't be on without it.
    set.run(KEYS.otherEstimate, s.otherProducts && s.otherEstimate ? "1" : "0");
    set.run(KEYS.resetPercent, String(p));
  })();
  return getSettings(db);
}
