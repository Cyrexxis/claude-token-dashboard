import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import type { ApiError } from "@td/shared";
import { useEffect } from "react";
import { keysToInvalidate, LIVE_EVENTS } from "./events";

export class HttpError extends Error {
  constructor(
    public status: number,
    public body: ApiError | null,
  ) {
    super(body?.message ?? `HTTP ${status}`);
  }
}

/** GET (or `init`) `/api/v1<path>`; undefined/null params are dropped. */
export async function api<T>(
  path: string,
  params?: Record<string, string | number | null | undefined>,
  init?: RequestInit,
): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {}))
    if (v !== undefined && v !== null) qs.set(k, String(v));
  const res = await fetch(`/api/v1${path}${qs.size ? `?${qs}` : ""}`, init);
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new HttpError(res.status, body);
  return body as T;
}

/** Turns SSE events into query invalidations; refetches everything after a reconnect. */
export function useLiveEvents(client: QueryClient = useQueryClient()): void {
  useEffect(() => {
    const es = new EventSource("/api/v1/events");
    let dropped = false;
    es.onerror = () => {
      dropped = true;
    };
    es.onopen = () => {
      if (dropped) void client.invalidateQueries(); // events may have been missed
      dropped = false;
    };
    for (const event of LIVE_EVENTS)
      es.addEventListener(event, (e) => {
        let data: unknown = null;
        try {
          data = JSON.parse((e as MessageEvent).data);
        } catch {}
        for (const queryKey of keysToInvalidate(event, data))
          void client.invalidateQueries({ queryKey });
      });
    return () => es.close();
  }, [client]);
}
