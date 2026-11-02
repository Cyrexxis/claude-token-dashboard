import type { QueryKey } from "@tanstack/react-query";
import type { LiveEvent, LiveEventPayloads } from "@td/shared";

export { LIVE_EVENTS, type LiveEvent } from "@td/shared";

// ["plan"]: window tokens and cost are summed from requests, so usage and price changes move them too.
const AGGREGATES: QueryKey[] = [
  ["summary"],
  ["timeseries"],
  ["sessions"],
  ["status"],
  ["sources"],
  ["plan"],
];

/** Query keys (prefixes) an SSE event makes stale. */
export function keysToInvalidate<E extends LiveEvent>(
  event: E,
  data: LiveEventPayloads[E] | null,
): QueryKey[] {
  if (event === "ingest.status") return [["status"], ["sources"]];
  if (event === "plan.snapshot") return [["plan"]];
  if (event === "prices.updated") return [...AGGREGATES, ["session"], ["prices"]];
  // Parsed from the wire: still check the shape before trusting it.
  const ids = (data as LiveEventPayloads["usage.updated"] | null)?.sessionIds;
  const sessions = Array.isArray(ids) ? ids.map((id) => ["session", String(id)]) : [];
  return [...AGGREGATES, ...sessions];
}
