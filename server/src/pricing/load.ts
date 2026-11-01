import type { Database } from "bun:sqlite";
import { type PriceFile, validatePriceFile } from "@td/shared";
import shippedJson from "../../../prices/prices.json"; // embedded in the compiled program
import { bus } from "../events";
import { rebuildRollups } from "../rollups";
import { buildPriceTable, type PriceTable } from "./engine";
import { reprice } from "./reprice";

export type LoadedPrices = { table: PriceTable; hash: string; localError: string | null };

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

/** Shipped prices plus an optional local override. An invalid local file is ignored and reported. */
export async function loadPrices(localPath: string | null): Promise<LoadedPrices> {
  const shipped = validatePriceFile(shippedJson);
  if (!shipped.ok) throw new Error(`shipped prices.json is invalid: ${shipped.errors.join("; ")}`);
  let local: PriceFile | null = null;
  let localText = "";
  let localError: string | null = null;
  const file = localPath ? Bun.file(localPath) : null;
  if (file && (await file.exists())) {
    try {
      const v = validatePriceFile(JSON.parse(await file.text()));
      if (v.ok) {
        local = v.value;
        localText = JSON.stringify(v.value);
      } else localError = `${localPath}: ${v.errors.join("; ")}`;
    } catch (e) {
      localError = `${localPath}: ${(e as Error).message}`;
    }
  }
  return {
    table: buildPriceTable(shipped.value, local),
    hash: sha256(`${JSON.stringify(shipped.value)}\n${localText}`),
    localError,
  };
}

/** When the price content changed since the last run: replace price_periods, reprice everything, rebuild rollups. */
export function syncPrices(
  db: Database,
  loaded: LoadedPrices,
): { changed: boolean; repriced: number } {
  const stored = db
    .query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'prices_hash'")
    .get()?.value;
  if (stored === loaded.hash) return { changed: false, repriced: 0 };
  let repriced = 0;
  db.transaction(() => {
    db.run("DELETE FROM price_periods");
    const ins = db.query(
      "INSERT INTO price_periods (id, model_id, effective_from, effective_to, origin, values_json) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const m of loaded.table.models)
      for (const p of m.periods)
        ins.run(p.id, p.modelId, p.from, p.to, p.origin, JSON.stringify(p.period));
    repriced = reprice(db, loaded.table);
    rebuildRollups(db, "all");
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('prices_hash', ?)", [loaded.hash]);
  })();
  bus.emit("prices.updated", { hash: loaded.hash });
  return { changed: true, repriced };
}
