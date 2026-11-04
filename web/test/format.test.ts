import { expect, test } from "bun:test";
import {
  autoBucket,
  fmtDuration,
  fmtTokens,
  fmtUsd,
  presetRange,
  sourceLabel,
} from "../src/format";
import { parseHash } from "../src/route";

test("fmtTokens", () => {
  expect(fmtTokens(999)).toBe("999");
  expect(fmtTokens(12_345)).toBe("12.3K");
  expect(fmtTokens(4_500_000)).toBe("4.5M");
  expect(fmtTokens(2.1e9)).toBe("2.1B");
});

test("fmtUsd", () => {
  expect(fmtUsd(null)).toBe("—");
  expect(fmtUsd(0)).toBe("$0.00");
  expect(fmtUsd(0.004)).toBe("$0.004");
  expect(fmtUsd(12.345)).toBe("$12.35");
  expect(fmtUsd(1234.5)).toBe("$1,234.50");
});

test("fmtDuration", () => {
  expect(fmtDuration(59_000)).toBe("59s");
  expect(fmtDuration(3_660_000)).toBe("1h 1m");
  expect(fmtDuration(125_000)).toBe("2m 5s");
  expect(fmtDuration((124 * 60 + 54) * 60_000)).toBe("5d 4h");
  expect(fmtDuration(24 * 3_600_000)).toBe("1d 0h");
  expect(fmtDuration(24 * 3_600_000 - 60_000)).toBe("23h 59m");
});

test("presetRange and autoBucket", () => {
  const t = new Date(2026, 10, 1);
  expect(presetRange("7d", t)).toEqual({ from: "2026-10-26", to: "2026-11-01" });
  expect(presetRange("all", t)).toEqual({ from: null, to: null });
  expect(autoBucket({ from: "2026-10-01", to: "2026-11-01" })).toBe("day");
  expect(autoBucket({ from: "2026-01-01", to: "2026-11-01" })).toBe("week");
  expect(autoBucket({ from: "2024-01-01", to: "2026-11-01" })).toBe("month");
  expect(autoBucket({ from: null, to: null })).toBe("month");
});

test("parseHash", () => {
  expect(parseHash("#/sessions/abc")).toEqual({ view: "sessions", id: "abc" });
  expect(parseHash("#/plan")).toEqual({ view: "plan" });
  expect(parseHash("")).toEqual({ view: "overview" });
  expect(parseHash("#/nope")).toEqual({ view: "overview" });
});

test("parseHash survives a malformed escape", () => {
  expect(parseHash("#/sessions/%E0")).toEqual({ view: "sessions", id: "%E0" });
  expect(parseHash("#/sessions/a%2Fb")).toEqual({ view: "sessions", id: "a/b" });
});

test("sourceLabel", () => {
  expect(sourceLabel("wsl", "claude-desktop")).toBe("wsl · desktop");
  expect(sourceLabel("windows", "cli")).toBe("windows");
  expect(sourceLabel(null, null)).toBe("—");
});
