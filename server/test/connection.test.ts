import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL } from "@td/shared";
import { loadConfig, setConfigKey } from "../src/config";
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

test("extra keys are merged, url/protocol win", () => {
  const p = join(tmp(), "server.json");
  writeFileSync(p, JSON.stringify({ start: ["old"], other: 1 }));
  writeConnectionFile(p, "http://127.0.0.1:3", { start: ["new"], serverLocation: "wsl", url: "x" });
  expect(read(p)).toEqual({
    start: ["new"],
    other: 1,
    serverLocation: "wsl",
    url: "http://127.0.0.1:3",
    protocol: 1,
  });
});

test("connectionFiles is read from config.json", () => {
  const d = tmp();
  const cfg = join(d, "config.json");
  writeFileSync(
    cfg,
    JSON.stringify({ connectionFiles: ["/a/server.json", "/mnt/c/b/server.json"] }),
  );
  expect(loadConfig({ HOME: d, TD_CONFIG: cfg }).connectionFiles).toEqual([
    "/a/server.json",
    "/mnt/c/b/server.json",
  ]);
  expect(loadConfig({ HOME: tmp() }).connectionFiles).toBeNull();
});

test("connectionFiles must be absolute paths", () => {
  const d = tmp();
  const cfg = join(d, "config.json");
  writeFileSync(cfg, JSON.stringify({ connectionFiles: ["relative/server.json"] }));
  expect(() => loadConfig({ HOME: d, TD_CONFIG: cfg })).toThrow(
    '"connectionFiles" must be an array of absolute paths',
  );
});

test("setConfigKey keeps other keys and deletes on undefined", () => {
  const p = join(tmp(), "nested", "config.json");
  setConfigKey(p, "connectionFiles", ["/x"]);
  expect(read(p)).toEqual({ connectionFiles: ["/x"] });
  writeFileSync(p, JSON.stringify({ subscriptionMonthlyUsd: 100, connectionFiles: ["/x"] }));
  setConfigKey(p, "connectionFiles", undefined);
  expect(read(p)).toEqual({ subscriptionMonthlyUsd: 100 });
});

test("connectionFiles must name server.json files", () => {
  const d = tmp();
  const cfg = join(d, "config.json");
  writeFileSync(cfg, JSON.stringify({ connectionFiles: ["/home/u/.bashrc"] }));
  expect(() => loadConfig({ HOME: d, TD_CONFIG: cfg })).toThrow(
    '"connectionFiles" must be an array of absolute paths to server.json files',
  );
});

test("the mod sends the protocol version the server speaks", () => {
  // Read as text: the plugin imports claude-code types the root tsconfig can't resolve.
  const src = readFileSync(join(import.meta.dir, "../../plugin/hooks/client.ts"), "utf8");
  expect(Number(src.match(/const PROTOCOL = "(\d+)"/)?.[1])).toBe(PROTOCOL);
});

test("config.json must hold an object", () => {
  for (const body of ["null", "[]", '"x"']) {
    const d = tmp();
    const cfg = join(d, "config.json");
    writeFileSync(cfg, body);
    expect(() => loadConfig({ HOME: d, TD_CONFIG: cfg })).toThrow("must be a JSON object");
  }
});

test("setConfigKey replaces a config.json holding null", () => {
  const p = join(tmp(), "config.json");
  writeFileSync(p, "null");
  setConfigKey(p, "connectionFiles", ["/x"]);
  expect(read(p)).toEqual({ connectionFiles: ["/x"] });
});
