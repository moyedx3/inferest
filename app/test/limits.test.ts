import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLimits, companyLimit, toolBudgetUsd, usageMicro, type KeyInput } from "../limits.ts";
import { HACKATHON_PARAMS } from "../../engine/ledger.ts";

const key = (id: string, weight: number, modelSpent = 0, toolSpent = 0, revoked = false): KeyInput =>
  ({ id, weight, revoked, modelSpent, toolSpent });
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("equal weights split the credit evenly", () => {
  const l = computeLimits(2_000, [key("a", 1, 100), key("b", 1)], HACKATHON_PARAMS, false);
  assert.deepEqual(l.map((x) => [x.id, x.budget, x.spent, x.remaining]), [["a", 1000, 100, 900], ["b", 1000, 0, 1000]]);
});

test("a key's unused share does not flow to the others", () => {
  const l = computeLimits(300, [key("a", 1, 100), key("b", 2)], HACKATHON_PARAMS, false);
  close(l[0].budget, 100); close(l[0].remaining, 0);
  close(l[1].budget, 200); close(l[1].remaining, 200);
});

test("tool spend comes out of the same key budget", () => {
  const l = computeLimits(100, [key("a", 1, 10, 5)], HACKATHON_PARAMS, false);
  close(l[0].spent, 15); close(l[0].remaining, 85);
});

test("frozen vaults open nothing but keep spend", () => {
  const l = computeLimits(100, [key("a", 1, 10)], HACKATHON_PARAMS, true);
  assert.equal(l[0].budget, 0); assert.equal(l[0].remaining, 0); assert.equal(l[0].spent, 10);
});

test("revoked keys get no credit but their spend still counts against the pool", () => {
  const l = computeLimits(100, [key("a", 1, 40, 0, true), key("b", 1)], HACKATHON_PARAMS, false);
  assert.equal(l[0].budget, 0); assert.equal(l[0].remaining, 0); assert.equal(l[0].spent, 40);
  close(l[1].budget, 100); close(l[1].remaining, 60);
});

test("zero weights and negative yield open nothing", () => {
  assert.equal(computeLimits(100, [key("a", 0)], HACKATHON_PARAMS, false)[0].remaining, 0);
  assert.equal(computeLimits(-5, [key("a", 1)], HACKATHON_PARAMS, false)[0].remaining, 0);
});

test("the rail fee scales credit and settlement usage", () => {
  const p = { ...HACKATHON_PARAMS, railFee: 0.05 };
  const l = computeLimits(100, [key("a", 1, 19, 10)], p, false);
  close(l[0].budget, 95); close(l[0].spent, 28.5); close(l[0].remaining, 66.5);
  close(toolBudgetUsd(l[0], p), 70);
  assert.equal(usageMicro([key("a", 1, 19, 10)], p), 30_000_000n);
});

test("settlement usage in USDC base units", () => {
  assert.equal(usageMicro([key("a", 1, 1.5, 0.25), key("b", 1, 0.000001)], HACKATHON_PARAMS), 1_750_001n);
});

test("reweighting after spend never opens more than the yield", () => {
  const l = computeLimits(100, [key("a", 1, 100), key("b", 3)], HACKATHON_PARAMS, false);
  close(l[0].remaining + l[1].remaining, 0);
});

test("open credit never exceeds the pool, and scaling is a no-op without overspend", () => {
  const l = computeLimits(100, [key("a", 1, 60), key("b", 1)], HACKATHON_PARAMS, false);
  close(l[0].remaining, 0); close(l[1].remaining, 40);
  const n = computeLimits(100, [key("a", 1, 10), key("b", 1, 10)], HACKATHON_PARAMS, false);
  close(n[0].remaining, 40); close(n[1].remaining, 40);
});

test("the company limit is cumulative usage plus open credit, floored to 4 decimals", () => {
  const l = computeLimits(100, [key("a", 1, 10), key("b", 1)], HACKATHON_PARAMS, false);
  assert.equal(companyLimit(12.34567, l), 102.3456);
  assert.equal(companyLimit(5, []), 5);
});

test("the company limit ignores a non-finite open credit", () => {
  assert.equal(companyLimit(5, [{ id: "a", budget: NaN, spent: 0, remaining: NaN }]), 5);
});
