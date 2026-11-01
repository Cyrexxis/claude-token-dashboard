import { dateMs, type PerMtok, type PriceFile, type PricePeriod } from "@td/shared";

export type PriceInput = {
  model: string;
  ts: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  webSearch: number;
  speed: string | null;
};
export type PriceResult = { costUsd: number; pricePeriodId: string } | { unpriced: true };
export type Origin = "shipped" | "local";
export type TablePeriod = {
  id: string;
  modelId: string;
  from: number | null;
  to: number | null;
  origin: Origin;
  period: PricePeriod;
};
export type PriceTable = {
  models: { id: string; match: string[]; origin: Origin; periods: TablePeriod[] }[];
  webSearch: { from: number | null; to: number | null; perRequest: number }[];
};

const inSpan = (ts: number, from: number | null, to: number | null) =>
  (from === null || ts >= from) && (to === null || ts < to);

function toModels(file: PriceFile, origin: Origin): PriceTable["models"] {
  return file.models.map((m) => ({
    id: m.id,
    match: m.match,
    origin,
    periods: m.periods.map((p) => ({
      id: `${m.id}@${p.effective_from ?? "release"}@${origin}`,
      modelId: m.id,
      from: dateMs(p.effective_from),
      to: dateMs(p.effective_to),
      origin,
      period: p,
    })),
  }));
}

/** Local entries replace shipped ones with the same id; new local ids go first so they win matching. */
export function buildPriceTable(shipped: PriceFile, local: PriceFile | null): PriceTable {
  const localModels = local ? toModels(local, "local") : [];
  const localIds = new Map(localModels.map((m) => [m.id, m]));
  const merged = toModels(shipped, "shipped").map((m) => localIds.get(m.id) ?? m);
  const added = localModels.filter((m) => !merged.includes(m));
  const tools = [...(local?.server_tools ?? []), ...shipped.server_tools];
  const webSearch = tools.find((t) => t.name === "web_search");
  return {
    models: [...added, ...merged],
    webSearch: (webSearch?.periods ?? []).map((p) => ({
      from: dateMs(p.effective_from),
      to: dateMs(p.effective_to ?? null),
      perRequest: p.per_request,
    })),
  };
}

const matches = (pattern: string, model: string) =>
  pattern.endsWith("*") ? model.startsWith(pattern.slice(0, -1)) : model === pattern;

export function priceRequest(table: PriceTable, req: PriceInput): PriceResult {
  const model = table.models.find((m) => m.match.some((p) => matches(p, req.model)));
  const tp = model?.periods.find((p) => inSpan(req.ts, p.from, p.to));
  if (!tp) return { unpriced: true };
  const { period } = tp;
  const prompt = req.input + req.cacheRead + req.cacheWrite5m + req.cacheWrite1h;
  const r: PerMtok =
    period.long_context && prompt > period.long_context.threshold_input_tokens
      ? period.long_context.per_mtok
      : period.per_mtok;
  const tokens =
    req.input * r.input +
    req.output * r.output + // thinking is already inside output
    req.cacheRead * r.cache_read +
    req.cacheWrite5m * r.cache_write_5m +
    req.cacheWrite1h * r.cache_write_1h;
  const speedMod = req.speed && req.speed !== "standard" ? period.modifiers.speed[req.speed] : null;
  if (speedMod === undefined) return { unpriced: true }; // e.g. fast mode on a model without a known fast price
  const speed = speedMod?.multiplier ?? 1;
  const perSearch = table.webSearch.find((p) => inSpan(req.ts, p.from, p.to))?.perRequest ?? 0;
  return { costUsd: (tokens * speed) / 1e6 + req.webSearch * perSearch, pricePeriodId: tp.id };
}
