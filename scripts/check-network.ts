// SPEC §12: the server makes no outbound network connections. Fails CI on network clients in server/src.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PATTERNS = [
  /(?<![.\w])fetch\s*\((?!\s*\)\s*\{)/, // a fetch() call, not a `fetch() {` method definition
  /["'](node:)?(http|https|net|tls|dgram|http2)["']/,
  /\bBun\.connect\b/,
  /\bnew\s+WebSocket\b/,
  /\bXMLHttpRequest\b/,
];

export function findNetworkUse(dir: string): { file: string; line: number; text: string }[] {
  const hits: { file: string; line: number; text: string }[] = [];
  for (const rel of new Bun.Glob("**/*.ts").scanSync(dir)) {
    const file = join(dir, rel);
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((text, i) => {
        if (PATTERNS.some((p) => p.test(text))) hits.push({ file, line: i + 1, text: text.trim() });
      });
  }
  return hits;
}

if (import.meta.main) {
  const hits = findNetworkUse("server/src");
  for (const h of hits) console.error(`${h.file}:${h.line}: ${h.text}`);
  if (hits.length) process.exit(1);
  console.log("check-network: OK");
}
