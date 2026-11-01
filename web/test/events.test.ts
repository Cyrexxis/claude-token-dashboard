import { expect, test } from "bun:test";
import { keysToInvalidate } from "../src/events";

test("usage.updated invalidates aggregates and the touched sessions", () => {
  const keys = keysToInvalidate("usage.updated", { sessionIds: ["a", "b"], from: 0, to: 1 });
  expect(keys).toEqual(
    expect.arrayContaining([
      ["summary"],
      ["timeseries"],
      ["sessions"],
      ["status"],
      ["sources"],
      ["session", "a"],
      ["session", "b"],
    ]),
  );
  expect(keys).not.toContainEqual(["prices"]);
});

test("ingest.status touches only status and sources", () => {
  expect(keysToInvalidate("ingest.status", { running: false, files: 1, errors: 0 })).toEqual([
    ["status"],
    ["sources"],
  ]);
});

test("prices.updated touches every cost-bearing key", () => {
  expect(keysToInvalidate("prices.updated", { hash: "x" })).toEqual(
    expect.arrayContaining([
      ["summary"],
      ["timeseries"],
      ["sessions"],
      ["session"],
      ["prices"],
      ["status"],
    ]),
  );
});

test("malformed usage payload does not throw", () => {
  expect(keysToInvalidate("usage.updated", null)).toContainEqual(["summary"]);
});
