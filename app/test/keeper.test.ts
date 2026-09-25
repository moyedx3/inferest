import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../store.ts";
import { syncVault, settleVault, reportAll, tick, toolBudgetFor, type KeeperDeps } from "../keeper.ts";
import type { Chain } from "../chain.ts";
import type { OpenRouter } from "../openrouter.ts";
import { HACKATHON_PARAMS } from "../../engine/ledger.ts";

const V = "0x00000000000000000000000000000000000000aa";

function setup(opts: { yieldMicro?: bigint; lossPending?: boolean; usage?: Record<string, number[]> } = {}) {
  const events: string[] = [];
  const store = openStore(":memory:");
  store.addVault(V, "0x00000000000000000000000000000000000000cc", "T");
  store.addKey({ hash: "h1", vault: V, name: "a", weight: 1, secretSha256: "s1" });
  store.addKey({ hash: "h2", vault: V, name: "b", weight: 1, secretSha256: "s2" });
  const usage = opts.usage ?? { h1: [0], h2: [0] };
  const chain: Chain = {
    yieldOf: async () => opts.yieldMicro ?? 2_000_000_000n,
    lossPending: async () => opts.lossPending ?? false,
    report: async (v) => { events.push(`report:${v}`); return "0xr"; },
    settle: async (v, u) => { events.push(`settle:${u}`); return "0xs"; },
    customerOf: async () => "0x00000000000000000000000000000000000000cc",
  };
  const or: OpenRouter = {
    createKey: async () => ({ key: "k", hash: "h" }),
    getKey: async (h) => {
      const seq = usage[h];
      const u = seq.length > 1 ? seq.shift()! : seq[0];
      events.push(`get:${h}:${u}`);
      return { hash: h, usage: u, limit: null, disabled: false };
    },
    setLimit: async (h, l) => { events.push(`limit:${h}:${l}`); },
  };
  const d: KeeperDeps = { chain, store, or, params: HACKATHON_PARAMS, log: () => {} };
  return { d, store, events };
}

test("sync writes each key's weighted limit and stores yield", async () => {
  const { d, store, events } = setup({ usage: { h1: [100], h2: [0] } });
  await syncVault(d, V);
  assert.ok(events.includes("limit:h1:1000")); // 100 used of a 1,000 budget -> cumulative limit 1,000
  assert.ok(events.includes("limit:h2:1000"));
  assert.equal(store.vault(V)!.yieldUsd, 2_000);
});

test("freezes limits when a loss is pending", async () => {
  const { d, store, events } = setup({ lossPending: true, usage: { h1: [40], h2: [7] } });
  await syncVault(d, V);
  assert.ok(events.includes("limit:h1:40"));
  assert.ok(events.includes("limit:h2:7"));
  assert.equal(store.vault(V)!.frozen, true);
});

test("skips settlement when a loss is pending", async () => {
  const { d, events } = setup({ lossPending: true });
  assert.equal(await settleVault(d, V), null);
  assert.ok(!events.some((e) => e.startsWith("settle:")));
});

test("settle freezes keys, re-reads usage, then settles", async () => {
  // h1 reads 100 on the freeze pass, then 101 after a request that was already in flight
  const { d, store, events } = setup({ usage: { h1: [100, 101], h2: [0] } });
  const r = await settleVault(d, V);
  const iFreeze = events.indexOf("limit:h1:100");
  const iReread = events.indexOf("get:h1:101");
  const iSettle = events.findIndex((e) => e.startsWith("settle:"));
  assert.ok(iFreeze >= 0 && iFreeze < iReread && iReread < iSettle);
  assert.equal(r!.usage, 101_000_000n);
  assert.equal(store.keyByHash("h1")!.baseline, 101);
  assert.equal(store.vault(V)!.period, 1);
  assert.equal(store.listSettlements().length, 1);
});

test("reportAll reports every vault and survives a failing one", async () => {
  const { d, store, events } = setup();
  store.addVault("0x00000000000000000000000000000000000000bb", "0x1", "U");
  const orig = d.chain.report;
  d.chain.report = async (v) => { if (v.endsWith("aa")) throw new Error("boom"); return orig(v); };
  await reportAll(d, 5);
  assert.ok(events.includes("report:0x00000000000000000000000000000000000000bb"));
  assert.equal(store.getMeta("lastReport"), "5");
});

test("tick reports once a day and settles on a new month, not on first run", async () => {
  const { d, store, events } = setup();
  const day1 = Date.UTC(2026, 9, 1, 0, 0);
  await tick(d, day1);
  assert.equal(events.filter((e) => e.startsWith("report:")).length, 1);
  assert.equal(events.filter((e) => e.startsWith("settle:")).length, 0);
  await tick(d, day1 + 60_000);
  assert.equal(events.filter((e) => e.startsWith("report:")).length, 1);
  await tick(d, Date.UTC(2026, 10, 1, 0, 0));
  assert.equal(events.filter((e) => e.startsWith("settle:")).length, 1);
  assert.equal(store.getMeta("lastSettleMonth"), "2026-11");
});

test("overlapping ticks do not run twice", async () => {
  const { d, events } = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const orig = d.chain.report;
  d.chain.report = async (v) => { await gate; return orig(v); };
  const day1 = Date.UTC(2026, 9, 1, 0, 0);
  const p1 = tick(d, day1);
  const p2 = tick(d, day1 + 1000); // second tick while the first is still in flight
  release();
  await Promise.all([p1, p2]);
  assert.equal(events.filter((e) => e.startsWith("report:")).length, 1);
  const syncedBefore = events.filter((e) => e === "get:h1:0").length;
  await tick(d, day1 + 86_400_000 + 60_000); // a third tick, after both earlier ones settled
  const syncedAfter = events.filter((e) => e === "get:h1:0").length;
  assert.equal(events.filter((e) => e.startsWith("report:")).length, 2);
  assert.equal(syncedAfter, syncedBefore + 1);
});

test("a vault already settling is not settled twice", async () => {
  const { d, events } = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const orig = d.chain.settle;
  d.chain.settle = async (v, u) => { await gate; return orig(v, u); };
  const p1 = settleVault(d, V);
  const p2 = settleVault(d, V);
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(events.filter((e) => e.startsWith("settle:")).length, 1);
  assert.ok(r1 !== null);
  assert.equal(r2, null);
});

test("toolBudgetFor uses the last synced state", async () => {
  const { d, store } = setup({ usage: { h1: [100], h2: [0] } });
  await syncVault(d, V);
  store.recordToolCall("h1", "a", "/b", 50);
  assert.equal(toolBudgetFor(store, HACKATHON_PARAMS, "h1"), 850);
  assert.equal(toolBudgetFor(store, HACKATHON_PARAMS, "nope"), 0);
});
