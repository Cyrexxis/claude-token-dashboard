export type PerMtok = {
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
};
export type PricePeriod = {
  effective_from: string | null; // null = since the model's release
  effective_to: string | null; // exclusive; null = open
  per_mtok: PerMtok;
  long_context: { threshold_input_tokens: number; per_mtok: PerMtok } | null;
  modifiers: {
    speed: Record<string, { multiplier: number }>;
    inference_geo: Record<string, { multiplier: number }>;
  };
};
export type PriceModel = { id: string; match: string[]; notes?: string; periods: PricePeriod[] };
export type ServerTool = {
  name: string;
  periods: { effective_from: string | null; effective_to?: string | null; per_request: number }[];
};
export type PriceFile = {
  schema: 1;
  updated: string;
  currency: "USD";
  models: PriceModel[];
  server_tools: ServerTool[];
};

const RATE_KEYS = ["input", "output", "cache_read", "cache_write_5m", "cache_write_1h"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-MM-DD" → UTC midnight ms; null stays null; invalid → NaN. */
export function dateMs(d: string | null): number | null {
  if (d === null) return null;
  if (!DATE.test(d)) return Number.NaN;
  const ms = Date.parse(`${d}T00:00:00Z`);
  if (Number.isNaN(ms)) return ms;
  return new Date(ms).toISOString().startsWith(d) ? ms : Number.NaN; // rejects 2026-02-31
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

export function validatePriceFile(
  x: unknown,
): { ok: true; value: PriceFile } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const err = (path: string, msg: string) => errors.push(`${path}: ${msg}`);
  const num = (v: unknown, path: string) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) err(path, "must be a number >= 0");
  };
  const date = (v: unknown, path: string) => {
    if (v !== null && (typeof v !== "string" || Number.isNaN(dateMs(v))))
      err(path, "must be YYYY-MM-DD or null");
  };
  const noOverlap = (ps: { effective_from?: unknown; effective_to?: unknown }[], path: string) => {
    const spans = ps
      .map((p) => [
        dateMs((p.effective_from as string) ?? null) ?? -Infinity,
        dateMs((p.effective_to as string) ?? null) ?? Infinity,
      ])
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++)
      if (spans[i][0] < spans[i - 1][1]) err(path, "periods overlap");
  };
  const rates = (v: unknown, path: string) => {
    if (!isObj(v)) {
      err(path, "must be an object");
      return;
    }
    for (const k of RATE_KEYS) num(v[k], `${path}.${k}`);
  };

  if (!isObj(x)) return { ok: false, errors: ["$: must be an object"] };
  if (x.schema !== 1) err("schema", "must be 1");
  if (x.currency !== "USD") err("currency", 'must be "USD"');
  if (typeof x.updated !== "string") err("updated", "must be a string");
  if (!Array.isArray(x.models)) err("models", "must be an array");
  if (!Array.isArray(x.server_tools)) err("server_tools", "must be an array");

  const ids = new Set<unknown>();
  (Array.isArray(x.models) ? x.models : []).forEach((m: unknown, i: number) => {
    if (isObj(m) && ids.has(m.id)) err(`models[${i}].id`, `duplicate model id ${String(m.id)}`);
    if (isObj(m)) ids.add(m.id);
    const mp = `models[${i}]`;
    if (!isObj(m)) {
      err(mp, "must be an object");
      return;
    }
    if (typeof m.id !== "string" || !m.id) err(`${mp}.id`, "must be a non-empty string");
    if (!Array.isArray(m.match) || !m.match.length) err(`${mp}.match`, "must be a non-empty array");
    else
      m.match.forEach((p: unknown, j: number) => {
        if (typeof p !== "string" || !p || p.slice(0, -1).includes("*"))
          err(`${mp}.match[${j}]`, "exact id or a single trailing '*'");
      });
    if (!Array.isArray(m.periods) || !m.periods.length) {
      err(`${mp}.periods`, "must be a non-empty array");
      return;
    }
    m.periods.forEach((p: unknown, j: number) => {
      const pp = `${mp}.periods[${j}]`;
      if (!isObj(p)) {
        err(pp, "must be an object");
        return;
      }
      date(p.effective_from, `${pp}.effective_from`);
      date(p.effective_to, `${pp}.effective_to`);
      rates(p.per_mtok, `${pp}.per_mtok`);
      if (p.long_context !== null) {
        if (!isObj(p.long_context)) err(`${pp}.long_context`, "must be an object or null");
        else {
          num(p.long_context.threshold_input_tokens, `${pp}.long_context.threshold_input_tokens`);
          rates(p.long_context.per_mtok, `${pp}.long_context.per_mtok`);
        }
      }
      if (!isObj(p.modifiers)) {
        err(`${pp}.modifiers`, "must be an object");
        return;
      }
      for (const kind of ["speed", "inference_geo"] as const) {
        const mods = p.modifiers[kind];
        if (!isObj(mods)) err(`${pp}.modifiers.${kind}`, "must be an object");
        else
          for (const [k, v] of Object.entries(mods))
            num(isObj(v) ? v.multiplier : undefined, `${pp}.modifiers.${kind}.${k}.multiplier`);
      }
    });
    noOverlap(m.periods.filter(isObj), `${mp}.periods`);
  });

  (Array.isArray(x.server_tools) ? x.server_tools : []).forEach((t: unknown, i: number) => {
    const tp = `server_tools[${i}]`;
    if (!isObj(t)) {
      err(tp, "must be an object");
      return;
    }
    if (typeof t.name !== "string") err(`${tp}.name`, "must be a string");
    if (!Array.isArray(t.periods)) {
      err(`${tp}.periods`, "must be an array");
      return;
    }
    t.periods.forEach((p: unknown, j: number) => {
      if (!isObj(p)) {
        err(`${tp}.periods[${j}]`, "must be an object");
        return;
      }
      date(p.effective_from, `${tp}.periods[${j}].effective_from`);
      date(p.effective_to ?? null, `${tp}.periods[${j}].effective_to`);
      num(p.per_request, `${tp}.periods[${j}].per_request`);
    });
    noOverlap(t.periods.filter(isObj), `${tp}.periods`);
  });

  return errors.length ? { ok: false, errors } : { ok: true, value: x as PriceFile };
}
