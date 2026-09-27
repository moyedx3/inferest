import { test } from "node:test";
import assert from "node:assert/strict";
import { OwnerCooldown } from "../cooldown.ts";

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const T = 1_800_000_000_000;

test("the first call proceeds", () => {
  const c = new OwnerCooldown({ reportMs: 3_600_000, settleMs: 86_400_000 });
  assert.equal(c.check("report", A, T), 0);
});

test("a second call inside the window answers the seconds left, rounded up", () => {
  const c = new OwnerCooldown({ reportMs: 3_600_000, settleMs: 86_400_000 });
  c.check("report", A, T);
  assert.equal(c.check("report", A, T), 3600);
  assert.equal(c.check("report", A, T + 1), 3600); // 3599.999 s left rounds up
  assert.equal(c.check("report", A, T + 1_000), 3599);
  assert.equal(c.check("report", A, T + 3_599_999), 1);
});

test("a refused call does not restart the window", () => {
  const c = new OwnerCooldown({ reportMs: 3_600_000, settleMs: 86_400_000 });
  c.check("report", A, T);
  c.check("report", A, T + 1_800_000);
  assert.equal(c.check("report", A, T + 3_600_000), 0);
});

test("a call after the window proceeds and starts a new one", () => {
  const c = new OwnerCooldown({ reportMs: 3_600_000, settleMs: 86_400_000 });
  c.check("report", A, T);
  assert.equal(c.check("report", A, T + 3_600_000), 0);
  assert.equal(c.check("report", A, T + 3_600_001), 3600);
});

test("kinds and vaults are independent", () => {
  const c = new OwnerCooldown({ reportMs: 3_600_000, settleMs: 86_400_000 });
  assert.equal(c.check("report", A, T), 0);
  assert.equal(c.check("settle", A, T), 0);
  assert.equal(c.check("report", B, T), 0);
  assert.equal(c.check("settle", B, T), 0);
  assert.equal(c.check("report", A, T), 3600);
  assert.equal(c.check("settle", B, T), 86_400);
});

test("the two windows come from the constructor", () => {
  const c = new OwnerCooldown({ reportMs: 10_000, settleMs: 20_000 });
  c.check("report", A, T);
  c.check("settle", A, T);
  assert.equal(c.check("report", A, T), 10);
  assert.equal(c.check("settle", A, T), 20);
  assert.equal(c.check("report", A, T + 10_000), 0);
  assert.equal(c.check("settle", A, T + 10_000), 10);
});
