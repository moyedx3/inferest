import { test } from "node:test";
import assert from "node:assert/strict";
import {
  open, accruedYield, creditLimit, remaining, spend, settle,
  requiredPrincipal, priceAfter, DEFAULT_PARAMS,
} from "./ledger.ts";

const close = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

test("required principal matches the unit economics table", () => {
  // docs/04-unit-economics.md rounds these
  const rows: [number, number][] = [[10, 2_807], [50, 14_035], [200, 56_140], [500, 140_351], [10_000, 2_807_018]];
  for (const [monthly, expected] of rows) close(requiredPrincipal(monthly, 0.045), expected, 1);
});

test("full coverage needs about 281x the monthly budget, 23x the annual", () => {
  close(requiredPrincipal(1, 0.045), 280.70, 0.01);
  close(requiredPrincipal(1, 0.045) / 12, 23.39, 0.01);
});

test("fresh deposit has zero limit", () => {
  const p = open(100_000, 1);
  assert.equal(creditLimit(p, 1), 0);
});

test("demo: 100k USDC, six months at 4.5% APY", () => {
  // hackathon/PLAN.md and deck/outline.md quote these. APY already compounds, so half a year is 1.045^0.5, not 4.5% / 2.
  const p = open(100_000, 1);
  const price = priceAfter(1, 0.045, 0.5);
  close(accruedYield(p, price), 2_225.2, 0.1);  // gross yield
  close(creditLimit(p, price), 2_114.0, 0.1);   // credit across all keys, after the rail fee
  close(creditLimit(p, price) / 3, 704.7, 0.1); // per key, three developer keys
});

test("demo settlement: keys spend $500, the rest comes back less 10%", () => {
  const p = open(100_000, 1);
  const price = priceAfter(1, 0.045, 0.5);
  const s = settle(spend(p, 500, price), price);
  close(s.usage, 526.3, 0.1);      // USDC to the rail
  close(s.leftover, 1_698.9, 0.1);
  close(s.fee, 169.9, 0.1);        // to Inferest
  close(s.returned, 1_529.0, 0.1); // stays in the vault
  close(s.pull, 696.2, 0.1);       // all that leaves the customer's position
  close(s.position.principal, 101_529.0, 0.1);
  close(s.position.shares * price, s.position.principal); // next period starts at zero yield
  assert.equal(s.position.spent, 0);
});

test("a customer who uses all its yield pays no fee", () => {
  const p = open(100_000, 1);
  const price = priceAfter(1, 0.045, 0.5);
  const s = settle(spend(p, creditLimit(p, price), price), price);
  close(s.leftover, 0);
  close(s.fee, 0);
  close(s.position.principal, 100_000);
});

test("a customer who uses nothing keeps 90% of its yield", () => {
  const p = open(100_000, 1.0);
  const s = settle(p, 1.05);
  close(s.fee, 500);
  close(s.position.principal, 104_500);
});

test("settlement never takes principal", () => {
  const p = open(100_000, 1);
  for (const used of [0, 0.25, 0.5, 1]) {
    const q = spend(p, creditLimit(p, 1.03) * used, 1.03);
    const s = settle(q, 1.03);
    assert.ok(s.pull <= accruedYield(p, 1.03) + 1e-9);
    assert.ok(s.position.principal >= 100_000 - 1e-9);
  }
});

test("spend cannot exceed the limit", () => {
  const p = open(100_000, 1);
  assert.throws(() => spend(p, 1, 1), /over limit/);
  const q = spend(p, 100, 1.01);
  close(remaining(q, 1.01), 1_000 * 0.95 - 100);
});

test("vault loss floors accrued yield at zero instead of going negative", () => {
  const p = open(100_000, 1);
  assert.equal(accruedYield(p, 0.98), 0);
  assert.equal(remaining(p, 0.98), 0);
});

test("params are swappable per rail", () => {
  const noRailFee = { ...DEFAULT_PARAMS, railFee: 0 }; // e.g. an on-chain rail with no top-up fee
  close(requiredPrincipal(10, 0.045, noRailFee), 10 * 12 / 0.045, 1e-6);
});
