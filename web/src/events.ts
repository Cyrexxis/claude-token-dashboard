import type { QueryKey } from "@tanstack/react-query";

export type LiveEvent = "usage.updated" | "prices.updated" | "ingest.status";
export const LIVE_EVENTS: LiveEvent[] = ["usage.updated", "prices.updated", "ingest.status"];

const AGGREGATES: QueryKey[] = [["summary"], ["timeseries"], ["sessions"], ["status"], ["sources"]];

/** Query keys (prefixes) an SSE event makes stale. */
export function keysToInvalidate(event: LiveEvent, data: unknown): QueryKey[] {
  if (event === "ingest.status") return [["status"], ["sources"]];
  if (event === "prices.updated") return [...AGGREGATES, ["session"], ["prices"]];
  const ids = (data as { sessionIds?: unknown } | null)?.sessionIds;
  const sessions = Array.isArray(ids) ? ids.map((id) => ["session", String(id)]) : [];
  return [...AGGREGATES, ...sessions];
}
