import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PROTOCOL } from "@td/shared";

/** Writes url + protocol (and `extra`, e.g. setup's `start`) into `server.json`, keeping other keys. */
export function writeConnectionFile(
  path: string,
  url: string,
  extra: Record<string, unknown> = {},
): void {
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed;
  } catch {} // missing or broken: start fresh
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    `${path}.tmp`,
    `${JSON.stringify({ ...existing, ...extra, url, protocol: PROTOCOL }, null, 2)}\n`,
  );
  renameSync(`${path}.tmp`, path);
}
