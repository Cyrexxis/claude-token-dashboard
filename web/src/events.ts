import type { QueryKey } from "@tanstack/react-query";

export type LiveEvent = "usage.updated" | "prices.updated" | "ingest.status" | "plan.snapshot";
export const LIVE_EVENTS: LiveEvent[] = [
  "usage.updated",
  "prices.updated",
  "ingest.status",
  "plan.snapshot",
];

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
export function keysToInvalidate(event: LiveEvent, data: unknown): QueryKey[] {
  if (event === "ingest.status") return [["status"], ["sources"]];
  if (event === "plan.snapshot") return [["plan"]];
  if (event === "prices.updated") return [...AGGREGATES, ["session"], ["prices"]];
  const ids = (data as { sessionIds?: unknown } | null)?.sessionIds;
  const sessions = Array.isArray(ids) ? ids.map((id) => ["session", String(id)]) : [];
  return [...AGGREGATES, ...sessions];
}
