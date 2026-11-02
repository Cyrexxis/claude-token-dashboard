import { expect, test } from "bun:test";
import { forFilter } from "../src/paging";

test("forFilter: a new filter starts at page 0, and so does going back to an old one", () => {
  let s = { key: "a", page: 3 };
  s = forFilter(s, "b");
  expect(s).toEqual({ key: "b", page: 0 });
  s = forFilter(s, "a");
  expect(s).toEqual({ key: "a", page: 0 });
});

test("forFilter: the same filter keeps the same object (no render loop)", () => {
  const s = { key: "a", page: 2 };
  expect(forFilter(s, "a")).toBe(s);
});
