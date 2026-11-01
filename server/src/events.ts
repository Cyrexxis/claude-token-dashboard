import { EventEmitter } from "node:events";

export type UsageUpdated = { sessionIds: string[]; from: number; to: number };
export type IngestStatus = { running: boolean; files: number; errors: number };
export type PricesUpdated = { hash: string };

// In-process bus; phase 2 forwards these to SSE clients.
export const bus = new EventEmitter<{
  "usage.updated": [UsageUpdated];
  "ingest.status": [IngestStatus];
  "prices.updated": [PricesUpdated];
}>();
