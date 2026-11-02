import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { findNetworkUse } from "./check-network";

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "netcheck-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

test("flags fetch and node:http imports", () => {
  const dir = dirWith({
    "a.ts": 'await fetch("http://x");\n',
    "b.ts": 'import http from "node:http";\n',
  });
  const hits = findNetworkUse(dir);
  expect(hits.map((h) => basename(h.file)).sort()).toEqual(["a.ts", "b.ts"]);
  expect(hits[0]?.line).toBe(1);
});

test("ignores clean files and Bun.serve", () => {
  const dir = dirWith({
    "c.ts": "Bun.serve({ fetch() { return new Response(); } });\nconst x = 1;\n",
  });
  expect(findNetworkUse(dir)).toEqual([]);
});

test("server/src is clean", () => expect(findNetworkUse("server/src")).toEqual([]));
