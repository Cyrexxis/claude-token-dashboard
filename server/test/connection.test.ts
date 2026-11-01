import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { writeConnectionFile } from "../src/connection";

const tmp = () => mkdtempSync(join(tmpdir(), "td-conn-"));
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

test("writes url and protocol, creating the folder", () => {
  const p = join(tmp(), "nested", "server.json");
  writeConnectionFile(p, "http://127.0.0.1:47811");
  expect(read(p)).toEqual({ url: "http://127.0.0.1:47811", protocol: 1 });
});

test("keeps other keys", () => {
  const p = join(tmp(), "server.json");
  writeFileSync(p, JSON.stringify({ url: "old", protocol: 0, start: ["x"] }));
  writeConnectionFile(p, "http://127.0.0.1:1");
  expect(read(p)).toEqual({ url: "http://127.0.0.1:1", protocol: 1, start: ["x"] });
});

test("broken existing file is replaced", () => {
  const p = join(tmp(), "server.json");
  writeFileSync(p, "{nope");
  writeConnectionFile(p, "http://127.0.0.1:2");
  expect(read(p)).toEqual({ url: "http://127.0.0.1:2", protocol: 1 });
});

test("connectionPath follows TD_CONFIG", () => {
  const h = tmp();
  const d = tmp();
  expect(loadConfig({ HOME: h, TD_CONFIG: join(d, "config.json") }).connectionPath).toBe(
    join(d, "server.json"),
  );
  expect(loadConfig({ HOME: h }).connectionPath).toBe(
    join(h, ".config/token-dashboard/server.json"),
  );
});
