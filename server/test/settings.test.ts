import { expect, test } from "bun:test";
import { BadRequest } from "../src/api/queries";
import { openDatabase } from "../src/db/database";
import { getSettings, saveSettings } from "../src/settings";

test("settings: defaults, saved, estimate needs the feature, validated", () => {
  const db = openDatabase(":memory:");
  expect(getSettings(db)).toEqual({ otherProducts: false, otherEstimate: false, resetPercent: 5 });
  expect(saveSettings(db, { otherProducts: true, otherEstimate: true, resetPercent: 2 })).toEqual({
    otherProducts: true,
    otherEstimate: true,
    resetPercent: 2,
  });
  expect(saveSettings(db, { otherProducts: false, otherEstimate: true, resetPercent: 0 })).toEqual({
    otherProducts: false,
    otherEstimate: false,
    resetPercent: 0,
  });
  const ok = { otherProducts: false, otherEstimate: false, resetPercent: 5 };
  for (const bad of [
    { ...ok, otherProducts: "yes" },
    { ...ok, resetPercent: "5" },
    { ...ok, resetPercent: -1 },
    { ...ok, resetPercent: 101 },
    { otherProducts: false, otherEstimate: false },
    null,
  ])
    expect(() => saveSettings(db, bad)).toThrow(BadRequest);
});
