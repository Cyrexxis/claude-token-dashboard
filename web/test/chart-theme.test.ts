import { expect, test } from "bun:test";
import { seriesColors } from "../src/chart-theme";

test("token types get their fixed colors in any order", () => {
  expect(seriesColors(["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"])).toEqual([
    "var(--series-4)",
    "var(--series-1)",
    "var(--series-3)",
    "var(--series-5)",
    "var(--series-2)",
  ]);
  expect(seriesColors(["cacheWrite1h", "output"])).toEqual(["var(--series-2)", "var(--series-1)"]);
});

test("other groupings keep the fixed order, even with a type-like name among them", () => {
  expect(seriesColors(["output", "my-app", "other"])).toEqual([
    "var(--series-1)",
    "var(--series-2)",
    "var(--series-other)",
  ]);
  // Inherited object keys are not token types.
  expect(seriesColors(["constructor"])).toEqual(["var(--series-1)"]);
});
