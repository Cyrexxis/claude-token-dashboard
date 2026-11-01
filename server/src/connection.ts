import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PROTOCOL } from "@td/shared";

/** Writes url + protocol into `server.json`, keeping any other keys (e.g. a `start` from setup). */
export function writeConnectionFile(path: string, url: string): void {
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed;
  } catch {} // missing or broken: start fresh
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    `${path}.tmp`,
    `${JSON.stringify({ ...existing, url, protocol: PROTOCOL }, null, 2)}\n`,
  );
  renameSync(`${path}.tmp`, path);
}
