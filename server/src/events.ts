import { EventEmitter } from "node:events";
import type { IngestStatus, PlanSnapshotPoint, PricesUpdated, UsageUpdated } from "@td/shared";

export type { IngestStatus, PricesUpdated, UsageUpdated };

// In-process bus; phase 2 forwards these to SSE clients.
export const bus = new EventEmitter<{
  "usage.updated": [UsageUpdated];
  "ingest.status": [IngestStatus];
  "prices.updated": [PricesUpdated];
  "plan.snapshot": [PlanSnapshotPoint];
}>();
