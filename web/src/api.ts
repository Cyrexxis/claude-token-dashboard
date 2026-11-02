import { useQueryClient } from "@tanstack/react-query";
import type { ApiError, LiveEventPayloads } from "@td/shared";
import { useEffect } from "react";
import { keysToInvalidate, LIVE_EVENTS } from "./events";

export class HttpError extends Error {
  override name = "HttpError";
  constructor(
    readonly status: number,
    readonly body: ApiError | null,
    message?: string,
  ) {
    super(message ?? body?.message ?? `HTTP ${status}`);
  }
}

/** The request never got a response: the server is not running or not reachable. */
export class NetworkError extends Error {
  override name = "NetworkError";
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
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}${qs.size ? `?${qs}` : ""}`, init);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new NetworkError(e instanceof Error ? e.message : String(e));
  }
  // Every endpoint answers JSON; anything else is a proxy or another service on the port.
  const unexpected = () =>
    new HttpError(res.status, null, `unexpected response (not a token-dashboard server?)`);
  let body: unknown = null;
  const isJson = res.headers.get("content-type")?.includes("json");
  if (isJson)
    try {
      body = await res.json();
    } catch {
      throw unexpected();
    }
  if (!res.ok) throw new HttpError(res.status, body as ApiError | null);
  if (!isJson) throw unexpected();
  return body as T;
}

/** Turns SSE events into query invalidations; refetches everything after a reconnect. */
export function useLiveEvents(): void {
  const client = useQueryClient();
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
        let data: LiveEventPayloads[typeof event] | null = null;
        try {
          data = JSON.parse((e as MessageEvent).data); // the server's own payload (LiveEventPayloads)
        } catch {}
        for (const queryKey of keysToInvalidate(event, data))
          void client.invalidateQueries({ queryKey });
      });
    return () => es.close();
  }, [client]);
}
