import { stat } from "node:fs/promises";

export type FileStat = { fileKey: string; size: number; mtimeMs: number };
export type FileState = FileStat & { offset: number };

const CHUNK = 8 * 1024 * 1024;
const NL = 0x0a;
const decoder = new TextDecoder();

/** Rejects with ENOENT when the file is gone. */
export async function statFile(path: string): Promise<FileStat> {
  const s = await stat(path);
  return { fileKey: `${s.dev}:${s.ino}`, size: s.size, mtimeMs: Math.floor(s.mtimeMs) };
}

/** Same file and size → skip; new file, replacement or truncation → from 0; otherwise continue at the offset. */
export function planRead(
  prev: FileState | null,
  cur: FileStat,
): { skip: true } | { skip: false; start: number } {
  if (!prev || prev.fileKey !== cur.fileKey || cur.size < prev.offset)
    return { skip: false, start: 0 };
  if (cur.size === prev.size) return { skip: true };
  return { skip: false, start: prev.offset };
}

/**
 * Complete lines in [start, end), chunk by chunk. Splits on the newline byte so a multi-byte
 * character is never cut; an unterminated last line is left for the next visit.
 */
export async function* readLines(
  path: string,
  start: number,
  end: number,
  chunkSize = CHUNK,
): AsyncGenerator<{ lines: string[]; endOffset: number }> {
  const file = Bun.file(path);
  let carry = new Uint8Array(0);
  let carryStart = start; // file offset of carry[0]
  for (let pos = start; pos < end; ) {
    const bytes = await file.slice(pos, Math.min(pos + chunkSize, end)).bytes();
    if (!bytes.length) break; // file shrank while reading
    pos += bytes.length;
    const buf = new Uint8Array(carry.length + bytes.length);
    buf.set(carry);
    buf.set(bytes, carry.length);
    const lines: string[] = [];
    let lineStart = 0;
    for (let i = buf.indexOf(NL); i !== -1; i = buf.indexOf(NL, lineStart)) {
      const end = i > lineStart && buf[i - 1] === 0x0d ? i - 1 : i;
      lines.push(decoder.decode(buf.subarray(lineStart, end)));
      lineStart = i + 1;
    }
    carry = buf.slice(lineStart);
    carryStart += lineStart;
    if (lines.length) yield { lines, endOffset: carryStart };
  }
}
