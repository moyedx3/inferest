import { test } from "node:test";
import assert from "node:assert/strict";
import { openAgentLog } from "../log.ts";

test("a run is opened, given actions, and finished; runs list newest first with their actions", () => {
  const log = openAgentLog(":memory:");
  const a = log.startRun({ clockAt: 1_000, bookBefore: { walletUsdc: 500 } });
  log.addAction(a, { kind: "deposit", detail: { amountUsdc: 100 }, tx: "0xa" });
  log.addAction(a, { kind: "refused", detail: { what: "trade", reason: "over the cap" } });
  log.finishRun(a, { status: "done", note: "parked more", decision: { split: { action: "deposit", amountUsdc: 100 } }, bookAfter: { walletUsdc: 400 } });
  const b = log.startRun({ clockAt: 2_000, bookBefore: {} });
  log.finishRun(b, { status: "out_of_budget", note: "out of thinking budget until yield accrues", decision: null, bookAfter: {} });
  const runs = log.listRuns(10);
  assert.deepEqual(runs.map((r) => r.id), [b, a]);
  assert.equal(runs[1].actions.length, 2);
  assert.equal(runs[1].actions[1].detail.reason, "over the cap");
  assert.equal(runs[0].status, "out_of_budget");
  assert.equal(log.latestRun()!.id, b);
});

test("samples keep the last two per target and meta round-trips", () => {
  const log = openAgentLog(":memory:");
  log.addSample("0xT", 1_000_000n, 100);
  log.addSample("0xT", 1_001_000n, 200);
  log.addSample("0xT", 1_002_000n, 300);
  assert.deepEqual(log.lastSamples("0xT").map((s) => s.at), [200, 300]);
  assert.equal(log.getMeta("vault"), undefined);
  log.setMeta("vault", "0xV");
  assert.equal(log.getMeta("vault"), "0xV");
});

test("positions open and close", () => {
  const log = openAgentLog(":memory:");
  const run = log.startRun({ clockAt: 1, bookBefore: {} });
  const id = log.openPosition(run, { asset: "ETH", side: "buy", sizeUsdc: 50, entryPrice: 4_000 });
  assert.equal(log.openPositions().length, 1);
  log.markPositions({ ETH: 4_100 });
  assert.equal(log.openPositions()[0].markPrice, 4_100);
  log.closePosition(id, run, 4_050);
  assert.equal(log.openPositions().length, 0);
});
