import { test } from "node:test";
import assert from "node:assert/strict";
import {
  open, accruedUnharvested, creditLimit, remaining, spend, harvest,
  requiredPrincipal, creditsPerYieldDollar, priceAfter, DEFAULT_PARAMS,
} from "./ledger.ts";

const close = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

test("fee stack is 0.855 of yield, so 0.0385 of principal at 4.5% APY", () => {
  close(creditsPerYieldDollar(), 0.855);
  close(0.045 * creditsPerYieldDollar(), 0.038475);
});

test("required principal matches the unit economics table", () => {
  // docs/04-unit-economics.md rounds these
  const rows: [number, number][] = [[10, 3_119], [50, 15_595], [200, 62_378], [500, 155_945], [10_000, 3_118_908]];
  for (const [monthly, expected] of rows) close(requiredPrincipal(monthly, 0.045), expected, 1);
});

test("full coverage needs about 26x the monthly budget", () => {
  close(requiredPrincipal(1, 0.045) / 1, 311.89, 0.01);
  close(requiredPrincipal(1, 0.045) / 12, 25.99, 0.01);
});

test("fresh deposit has zero limit", () => {
  const p = open(100_000, 1);
  assert.equal(creditLimit(p, 1), 0);
});

test("demo: 100k USDC, six months at 4.5% APY", () => {
  // hackathon/PLAN.md and deck/outline.md quote these. APY already compounds, so half a year is 1.045^0.5, not 4.5% / 2.
  const p = open(100_000, 1);
  const price = priceAfter(1, 0.045, 0.5);
  close(accruedUnharvested(p, price), 2_225.2, 0.1); // gross yield
  close(creditLimit(p, price), 1_902.6, 0.1);        // credit across all keys after fees
  close(creditLimit(p, price) / 3, 634.2, 0.1);      // per key, three developer keys
  close(p.shares * price - accruedUnharvested(p, price), 100_000); // principal intact
});

test("spend cannot exceed the limit", () => {
  const p = open(100_000, 1);
  assert.throws(() => spend(p, 1, 1), /over limit/);
  const q = spend(p, 100, 1.01);
  close(remaining(q, 1.01), 1_000 * 0.855 - 100);
});

test("harvest removes only yield shares; principal is intact", () => {
  const p = open(100_000, 1);
  const { position, usd } = harvest(p, 1.05);
  close(usd, 5_000);
  close(position.shares * 1.05, 100_000);
  close(creditLimit(position, 1.05), 5_000 * 0.855); // limit survives harvest
});

test("vault loss floors accrued yield at zero instead of going negative", () => {
  const p = open(100_000, 1);
  assert.equal(accruedUnharvested(p, 0.98), 0);
  assert.equal(remaining(p, 0.98), 0);
});

test("params are swappable per rail", () => {
  const noRailFee = { ...DEFAULT_PARAMS, railFee: 0 }; // e.g. an on-chain rail with no top-up fee
  close(requiredPrincipal(10, 0.045, noRailFee), 10 * 12 / (0.045 * 0.9), 1e-6);
});
