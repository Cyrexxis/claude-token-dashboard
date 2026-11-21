import { expect, test } from "bun:test";
import { entrySource } from "./build-program";

test("entrySource imports every file and maps it by URL path", () => {
  const s = entrySource("/r", ["index.html", "assets/a.js"]);
  expect(s).toContain('import f1 from "/r/web/dist/assets/a.js" with { type: "file" }');
  expect(s).toContain('"/assets/a.js": f1');
  expect(s.indexOf('await import("/r/server/src/cli.ts")')).toBeGreaterThan(
    s.indexOf("setEmbeddedWeb("),
  );
});
