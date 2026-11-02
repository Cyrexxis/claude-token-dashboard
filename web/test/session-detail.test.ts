import { expect, test } from "bun:test";
import { pickStep, slotStart } from "../src/session-math";

const M = 60_000;

test("pickStep: smallest slot keeping a session under 60 bars", () => {
  expect(pickStep(0)).toBe(M);
  expect(pickStep(59 * M)).toBe(M);
  expect(pickStep(60 * M)).toBe(5 * M);
  expect(pickStep(4 * 60 * M)).toBe(5 * M);
  expect(pickStep(10 * 60 * M)).toBe(15 * M);
  expect(pickStep(2 * 24 * 60 * M)).toBe(60 * M);
  expect(pickStep(30 * 24 * 60 * M)).toBe(24 * 60 * M); // longest step even past 60 bars
});

test("slotStart: slots begin on the local clock", () => {
  const ts = new Date(2026, 10, 1, 13, 47, 12).getTime();
  expect(new Date(slotStart(ts, 15 * M)).getMinutes()).toBe(45);
  const day = new Date(slotStart(ts, 24 * 60 * M));
  expect([day.getDate(), day.getHours(), day.getMinutes()]).toEqual([1, 0, 0]);
});
