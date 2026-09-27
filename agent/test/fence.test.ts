import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFence, type Decision, type FenceContext, type Trade } from "../fence.ts";

const ctx: FenceContext = {
  walletUsdc: 500, vaultValue: 500, floorUsdc: 200, currentTarget: "0xa", targets: ["0xa", "0xb"],
  tradeCapBps: 2000, positions: [{ asset: "ETH", sizeUsdc: 60 }],
};
const base = (over: Partial<Decision> = {}): Decision => ({ note: "n", split: { action: "hold", amountUsdc: 0 }, source: { action: "stay", target: null }, trades: [], ...over });

test("a legal decision passes untouched", () => {
  const d = base({ split: { action: "deposit", amountUsdc: 100 }, source: { action: "move", target: "0xb" }, trades: [{ side: "buy", asset: "ETH", sizeUsdc: 100, price: 4_000, reasoning: "r" }] });
  const { accepted, refused } = applyFence(d, ctx);
  assert.deepEqual(refused, []);
  assert.deepEqual(accepted, d);
});
test("the floor, the balances and the caps are enforced, and the rest survives", () => {
  const d = base({
    split: { action: "withdraw", amountUsdc: 350 },
    source: { action: "move", target: "0xc" },
    trades: [{ side: "buy", asset: "ETH", sizeUsdc: 101, price: 4_000, reasoning: "r" }, { side: "sell", asset: "ETH", sizeUsdc: 60, price: 4_100, reasoning: "r" }, { side: "buy", asset: "SOL" as Trade["asset"], sizeUsdc: 10, price: 1, reasoning: "r" }],
  });
  const { accepted, refused } = applyFence(d, ctx);
  assert.equal(accepted.split.action, "hold");
  assert.equal(accepted.source.action, "stay");
  assert.deepEqual(accepted.trades.map((t) => t.asset + t.side), ["ETHsell"]);
  assert.deepEqual(refused.map((r) => r.what), ["split", "source", "trade 1", "trade 3"]);
  assert.match(refused[0].reason, /floor/);
  assert.match(refused[1].reason, /allowlist/);
  assert.match(refused[2].reason, /20%/);
  assert.match(refused[3].reason, /asset/);
  const tenPct = applyFence(base({ trades: [{ side: "buy", asset: "ETH", sizeUsdc: 60, price: 4_000, reasoning: "r" }] }), { ...ctx, walletUsdc: 500, tradeCapBps: 1000 });
  assert.match(tenPct.refused[0].reason, /10%/);
});
test("a deposit above the wallet, a sell above the position, a fourth trade, a zero price, and a move to the current source are refused", () => {
  const d = base({
    split: { action: "deposit", amountUsdc: 501 }, source: { action: "move", target: "0xa" },
    trades: [
      { side: "sell", asset: "ETH", sizeUsdc: 61, price: 4_000, reasoning: "r" },
      { side: "buy", asset: "BTC", sizeUsdc: 10, price: 0, reasoning: "r" },
      { side: "buy", asset: "ARB", sizeUsdc: 10, price: 1, reasoning: "r" },
      { side: "buy", asset: "ARB", sizeUsdc: 10, price: 1, reasoning: "r" },
      { side: "buy", asset: "ARB", sizeUsdc: 10, price: 1, reasoning: "r" },
      { side: "buy", asset: "ARB", sizeUsdc: 10, price: 1, reasoning: "r" },
    ],
  });
  const { accepted, refused } = applyFence(d, ctx);
  assert.equal(accepted.split.action, "hold");
  assert.equal(accepted.source.action, "stay");
  assert.equal(accepted.trades.length, 3); // the three legal ARB buys; the fourth is over the per-run count
  assert.equal(refused.filter((r) => r.what.startsWith("trade")).length, 3);
});
