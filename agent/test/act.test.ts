import { test } from "node:test";
import assert from "node:assert/strict";
import { planActions } from "../act.ts";

const ctx = { vault: "0xv1", currentTarget: "0xa", vaultsByTarget: { "0xa": "0xv1", "0xb": "0xv2" }, vaultShares: 10n, walletUsdc: 500_000_000n };

test("a deposit and paper trades plan in order", () => {
  const steps = planActions({ note: "", split: { action: "deposit", amountUsdc: 100 }, source: { action: "stay", target: null }, trades: [{ side: "buy", asset: "ETH", sizeUsdc: 50, price: 4000, reasoning: "r" }] }, ctx);
  assert.deepEqual(steps.map((s) => s.kind), ["approve", "deposit", "paper_open"]);
  assert.equal((steps[1] as { amount: bigint }).amount, 100_000_000n);
});
test("a source move reuses an existing vault over that target and re-keys it", () => {
  const steps = planActions({ note: "", split: { action: "hold", amountUsdc: 0 }, source: { action: "move", target: "0xb" }, trades: [] }, ctx);
  assert.deepEqual(steps.map((s) => s.kind), ["redeem_all", "approve", "deposit", "rekey"]);
  assert.equal((steps[1] as { vault: string }).vault, "0xv2");
});
test("a source move to a new target creates and registers a vault first", () => {
  const steps = planActions({ note: "", split: { action: "hold", amountUsdc: 0 }, source: { action: "move", target: "0xc" }, trades: [] }, ctx);
  assert.deepEqual(steps.map((s) => s.kind), ["redeem_all", "create_vault", "accept", "register", "approve", "deposit", "rekey"]);
});
test("a withdrawal redeems the shares worth the amount", () => {
  const steps = planActions({ note: "", split: { action: "withdraw", amountUsdc: 50 }, source: { action: "stay", target: null }, trades: [] }, ctx);
  assert.deepEqual(steps.map((s) => s.kind), ["withdraw"]);
  assert.equal((steps[0] as { amount: bigint }).amount, 50_000_000n);
});
