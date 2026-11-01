import { expect, test } from "bun:test";
import shipped from "../../prices/prices.json";
import { validatePriceFile } from "../src/prices";

const rates = { input: 1, output: 2, cache_read: 0.1, cache_write_5m: 1.25, cache_write_1h: 2 };
const period = (o: object = {}) => ({
  effective_from: null,
  effective_to: null,
  per_mtok: rates,
  long_context: null,
  modifiers: { speed: {}, inference_geo: {} },
  ...o,
});
const file = (o: object = {}, model: object = {}) => ({
  schema: 1,
  updated: "2026-11-01",
  currency: "USD",
  models: [{ id: "m1", match: ["m1", "m1-*"], periods: [period()], ...model }],
  server_tools: [],
  ...o,
});

test("shipped prices.json is valid", () => {
  expect(validatePriceFile(shipped)).toMatchObject({ ok: true });
});

test("a minimal file is valid", () => expect(validatePriceFile(file()).ok).toBe(true));

test("rejects wrong schema, negative price, bad date, overlapping periods, '*' not at end", () => {
  const bad = [
    file({ schema: 2 }),
    file({}, { periods: [period({ per_mtok: { ...rates, input: -1 } })] }),
    file({}, { periods: [period({ effective_from: "2026-13-01" })] }),
    file(
      {},
      {
        periods: [period({ effective_to: "2026-06-01" }), period({ effective_from: "2026-05-01" })],
      },
    ),
    file({}, { match: ["claude-*-x"] }),
  ];
  for (const b of bad) expect(validatePriceFile(b).ok).toBe(false);
});

test("adjacent periods do not overlap", () => {
  const ok = file(
    {},
    { periods: [period({ effective_to: "2026-06-01" }), period({ effective_from: "2026-06-01" })] },
  );
  expect(validatePriceFile(ok).ok).toBe(true);
});

test("errors name the path", () => {
  const r = validatePriceFile(
    file({}, { periods: [period({ per_mtok: { ...rates, input: -1 } })] }),
  );
  expect(r.ok ? [] : r.errors[0]).toContain("models[0].periods[0].per_mtok.input");
});

test("rejects duplicate model ids", () => {
  const m = { id: "m1", match: ["m1"], periods: [period()] };
  const r = validatePriceFile(file({ models: [m, { ...m, match: ["m1b"] }] }));
  expect(r.ok ? [] : r.errors.join()).toContain("duplicate model id");
});
