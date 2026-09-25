import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLimits, toolBudgetUsd, usageMicro, type KeyInput } from "../limits.ts";
import { HACKATHON_PARAMS, DEFAULT_PARAMS } from "../../engine/ledger.ts";

const H = HACKATHON_PARAMS;
const key = (hash: string, weight: number, usageTotal = 0, baseline = 0, toolSpent = 0): KeyInput =>
  ({ hash, weight, usageTotal, baseline, toolSpent });

test("equal weights split the credit evenly and limits are cumulative", () => {
  const out = computeLimits(2_225.25, [key("a", 1, 10, 10), key("b", 1), key("c", 1)], H, false);
  for (const l of out) assert.equal(Math.round(l.budget * 100), 74_175);
  assert.equal(out[0].limit, 10 + 741.75); // usage before this period stays in the cumulative limit
});

test("a key's unused share does not flow to the others", () => {
  const out = computeLimits(300, [key("a", 1, 100), key("b", 1, 0)], H, false);
  assert.equal(out[0].remaining, 50);
  assert.equal(out[1].remaining, 150);
});

test("tool spend comes out of the same key budget", () => {
  const [l] = computeLimits(100, [key("a", 1, 20, 0, 30)], H, false);
  assert.equal(l.spent, 50);
  assert.equal(l.remaining, 50);
  assert.equal(toolBudgetUsd(l, H), 50);
});

test("frozen vaults pin every key at its current usage", () => {
  const out = computeLimits(1_000, [key("a", 1, 7), key("b", 1, 3)], H, true);
  assert.deepEqual(out.map((l) => l.limit), [7, 3]);
});

test("zero weights and negative yield open nothing", () => {
  assert.equal(computeLimits(100, [key("a", 0, 5)], H, false)[0].limit, 5);
  assert.equal(computeLimits(-5, [key("a", 1, 5)], H, false)[0].limit, 5);
});

test("the rail fee scales credit and settlement usage", () => {
  const [l] = computeLimits(100, [key("a", 1, 19, 0, 0)], DEFAULT_PARAMS, false);
  assert.ok(Math.abs(l.budget - 95) < 1e-9);
  assert.equal(usageMicro([key("a", 1, 19, 0, 1)], DEFAULT_PARAMS), 21_000_000n); // 19/0.95 + 1
});

test("settlement usage in USDC base units", () => {
  assert.equal(usageMicro([key("a", 1, 510, 10, 0.25), key("b", 1, 0)], H), 500_250_000n);
});
