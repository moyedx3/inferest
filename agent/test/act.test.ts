import { test } from "node:test";
import assert from "node:assert/strict";
import { act, planActions, type ActDeps, type Step } from "../act.ts";
import { openAgentLog } from "../log.ts";

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

/** Minimal chain stand-ins: every write gets a hash, the named call throws, and USDC grows by 5 after the first read. */
function fakeDeps(failOn: string) {
  const log = openAgentLog(":memory:");
  log.setMeta("vaultsByTarget", JSON.stringify({ "0xb": "0xv2" }));
  const runId = log.startRun({ clockAt: 1, bookBefore: {} });
  let usdcReads = 0;
  let n = 0;
  const wallet = { writeContract: async (c: { functionName: string }) => { if (c.functionName === failOn) throw new Error(`${failOn} failed`); return `0xtx${++n}`; } };
  const pub = {
    waitForTransactionReceipt: async ({ hash }: { hash: string }) => ({ status: "success", transactionHash: hash, logs: [] }),
    readContract: async (c: { address: string }) => (c.address === "0xusdc" ? (usdcReads++ === 0 ? 0n : 5_000_000n) : 10n),
  };
  const deps = { wallet, pub, log, runId, api: async () => ({}), factory: "0xfactory", usdc: "0xusdc", address: "0xme", targets: [], setKey() {} } as unknown as ActDeps;
  return { deps, log, runId };
}
const moveSteps: Step[] = [{ kind: "redeem_all", vault: "0xV1" }, { kind: "approve", vault: "0xv2", amount: 10n }, { kind: "deposit", vault: "0xv2", amount: 10n }, { kind: "rekey" }];

test("a move that redeemed and then failed keeps its redeem hash", async () => {
  const { deps, log } = fakeDeps("approve");
  await assert.rejects(act(moveSteps, deps), /approve failed/);
  const actions = log.latestRun()!.actions;
  assert.deepEqual(actions.map((a) => a.kind), ["move_source", "refused", "refused"]);
  assert.equal(actions[0].tx, "0xtx1");
  assert.deepEqual(actions[0].detail, { from: "0xv1", to: null, target: "0xb", name: null, amountUsdc: 5, failed: true, redeemTx: "0xtx1", depositTx: null });
});

test("a move that failed before redeeming records no move", async () => {
  const { deps, log } = fakeDeps("redeem");
  await assert.rejects(act(moveSteps, deps), /redeem failed/);
  assert.deepEqual(log.latestRun()!.actions.map((a) => a.kind), ["refused", "refused", "refused"]);
});
