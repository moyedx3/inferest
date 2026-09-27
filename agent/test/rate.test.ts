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
