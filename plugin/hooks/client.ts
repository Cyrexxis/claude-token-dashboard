import type { EngineInterface } from "claude-code";

type $ = EngineInterface;
/** `server.json`, written by the server's `serve` (SPEC §11.3). Mirrors `ConnectionFile` in shared/. */
export type Connection = { url: string; protocol: number; start?: string[] };

const PROTOCOL = "1";
const QUEUE_KEY = "queue";
const QUEUE_MAX = 200;

/** Next to config.json: `TD_CONFIG`'s folder, else the platform's config folder (as the server's loadConfig). */
export async function connectionPath($: $): Promise<string | null> {
  const td = await $.env.get("TD_CONFIG");
  if (td) return td.replace(/[^/\\]*$/, "server.json");
  if ((await $.env.get("OS")) === "Windows_NT") {
    const appData = await $.env.get("APPDATA");
    return appData ? `${appData}\\token-dashboard\\server.json` : null;
  }
  const home = await $.env.get("HOME");
  return home ? `${home}/.config/token-dashboard/server.json` : null;
}

export async function readConnection($: $): Promise<Connection | null> {
  const path = await connectionPath($);
  if (!path) return null;
  try {
    const c = JSON.parse(String(await $.fs.read(path))) as Partial<Connection>;
    if (typeof c.url !== "string" || !/^https?:\/\//.test(c.url)) return null;
    const start =
      Array.isArray(c.start) && c.start.every((a) => typeof a === "string") ? c.start : undefined;
    return { url: c.url.replace(/\/$/, ""), protocol: Number(c.protocol), start };
  } catch {
    return null; // missing or unreadable: the mod stays silent
  }
}

/** One request to the server; null on any failure (unreachable, non-2xx). */
export async function send(
  $: $,
  conn: Connection,
  path: string,
  body?: unknown,
): Promise<string | null> {
  try {
    const r = await $.http.fetch(`${conn.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "X-TD-Protocol": PROTOCOL, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return r.ok ? r.text : null;
  } catch {
    return null;
  }
}

export async function readQueue($: $): Promise<string[]> {
  const q = await $.store.get(QUEUE_KEY);
  return Array.isArray(q) ? q.filter((x): x is string => typeof x === "string") : [];
}

export function writeQueue($: $, q: string[]): Promise<void> {
  return $.store.set(QUEUE_KEY, q);
}

/** Adds a session awaiting an ingest trigger: each session once, newest last, oldest dropped past the cap. */
export function enqueue(q: string[], sessionId: string): string[] {
  return [...q.filter((x) => x !== sessionId), sessionId].slice(-QUEUE_MAX);
}
