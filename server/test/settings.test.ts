import { expect, test } from "bun:test";
import { BadRequest } from "../src/api/queries";
import { openDatabase } from "../src/db/database";
import { getSettings, saveSettings } from "../src/settings";

test("settings: off by default, saved, estimate needs the feature, booleans only", () => {
  const db = openDatabase(":memory:");
  expect(getSettings(db)).toEqual({ otherProducts: false, otherEstimate: false });
  expect(saveSettings(db, { otherProducts: true, otherEstimate: true })).toEqual({
    otherProducts: true,
    otherEstimate: true,
  });
  expect(saveSettings(db, { otherProducts: false, otherEstimate: true })).toEqual({
    otherProducts: false,
    otherEstimate: false,
  });
  expect(() => saveSettings(db, { otherProducts: "yes", otherEstimate: false })).toThrow(
    BadRequest,
  );
  expect(() => saveSettings(db, null)).toThrow(BadRequest);
});
