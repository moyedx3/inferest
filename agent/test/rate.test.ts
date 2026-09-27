import { test } from "node:test";
import assert from "node:assert/strict";
import { rateFrom } from "../rate.ts";

const YEAR = 365 * 86_400;
test("a rate needs two samples at different times", () => {
  assert.equal(rateFrom([]), null);
  assert.equal(rateFrom([{ sharePrice: 1_000_000n, at: 1 }]), null);
  assert.equal(rateFrom([{ sharePrice: 1_000_000n, at: 5 }, { sharePrice: 1_010_000n, at: 5 }]), null);
});
test("the rate is annualized from the share price change", () => {
  const r = rateFrom([{ sharePrice: 1_000_000n, at: 0 }, { sharePrice: 1_020_000n, at: YEAR / 2 }]);
  assert.ok(Math.abs(r! - 0.04) < 1e-9, String(r));
});
test("the rate holds at the 1e18 sample scale", () => {
  const a = 10n ** 18n + 12_345n, b = (a * 1_030_000n) / 1_000_000n;
  const r = rateFrom([{ sharePrice: a, at: 0 }, { sharePrice: b, at: YEAR }]);
  assert.ok(Math.abs(r! - 0.03) < 1e-9, String(r));
  const tiny = rateFrom([{ sharePrice: 10n ** 18n, at: 0 }, { sharePrice: 10n ** 18n + 10n ** 9n, at: 86_400 }]);
  assert.ok(Math.abs(tiny! - 365e-9) < 1e-12, String(tiny)); // a growth far below one part in a million still reads
});
