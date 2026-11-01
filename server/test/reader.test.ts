import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FileState, planRead, readLines, statFile } from "../src/ingest/reader";

const tmpFile = (content: string | Uint8Array) => {
  const p = join(mkdtempSync(join(tmpdir(), "td-reader-")), "t.jsonl");
  writeFileSync(p, content);
  return p;
};
async function collect(path: string, start: number, end: number, chunkSize?: number) {
  const lines: string[] = [];
  let endOffset = start;
  for await (const c of readLines(path, start, end, chunkSize)) {
    lines.push(...c.lines);
    endOffset = c.endOffset;
  }
  return { lines, endOffset };
}

test("planRead: skip / append / truncation / replacement", () => {
  const prev: FileState = { fileKey: "1:1", size: 10, offset: 10, mtimeMs: 0 };
  expect(planRead(prev, { fileKey: "1:1", size: 10, mtimeMs: 0 })).toEqual({ skip: true });
  expect(planRead(prev, { fileKey: "1:1", size: 20, mtimeMs: 1 })).toEqual({
    skip: false,
    start: 10,
  });
  expect(planRead(prev, { fileKey: "1:1", size: 5, mtimeMs: 1 })).toEqual({
    skip: false,
    start: 0,
  });
  expect(planRead(prev, { fileKey: "1:2", size: 30, mtimeMs: 1 })).toEqual({
    skip: false,
    start: 0,
  });
  expect(planRead(null, { fileKey: "1:1", size: 30, mtimeMs: 1 })).toEqual({
    skip: false,
    start: 0,
  });
});

test("statFile gives dev:ino key and size; missing file rejects with ENOENT", async () => {
  const s = await statFile(tmpFile("abc\n"));
  expect(s.size).toBe(4);
  expect(s.fileKey).toMatch(/^\d+:\d+$/);
  expect(statFile("/nonexistent/x.jsonl")).rejects.toMatchObject({ code: "ENOENT" });
});

test("partial last line is left for later", async () => {
  expect(await collect(tmpFile("a\nb\nc"), 0, 5)).toEqual({ lines: ["a", "b"], endOffset: 4 });
});

test("reads from an offset to a given end only", async () => {
  expect(await collect(tmpFile("aa\nbb\ncc\n"), 3, 6)).toEqual({ lines: ["bb"], endOffset: 6 });
});

test("multi-byte char across chunk boundary decodes intact", async () => {
  const p = tmpFile("é€😀\n".repeat(50));
  const size = (await statFile(p)).size;
  const { lines, endOffset } = await collect(p, 0, size, 7);
  expect(lines).toHaveLength(50);
  expect(lines.every((l) => l === "é€😀")).toBe(true);
  expect(endOffset).toBe(size);
});

test("lines spanning chunks are joined", async () => {
  const long = "x".repeat(25);
  expect(await collect(tmpFile(`${long}\nshort\n`), 0, 32, 4)).toEqual({
    lines: [long, "short"],
    endOffset: 32,
  });
});

test("CRLF line endings are trimmed", async () => {
  expect((await collect(tmpFile("a\r\nb\r\n"), 0, 6)).lines).toEqual(["a", "b"]);
});
