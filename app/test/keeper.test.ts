import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../store.ts";
import { syncVault, syncAll, settleVault, reportAll, tick, toolBudgetFor, reconcilePending, type KeeperDeps } from "../keeper.ts";
import type { Chain, TxStatus } from "../chain.ts";
import type { OpenRouter } from "../openrouter.ts";
import { HACKATHON_PARAMS } from "../../engine/ledger.ts";

const V = "0x00000000000000000000000000000000000000aa";

function setup(opts: { yieldMicro?: bigint; lossPending?: boolean; usage?: Record<string, number[]>; status?: TxStatus } = {}) {
  const events: string[] = [];
  const store = openStore(":memory:");
  store.addVault(V, "0x00000000000000000000000000000000000000cc", "T");
  store.addKey({ hash: "h1", vault: V, name: "a", weight: 1, secretSha256: "s1" });
  store.addKey({ hash: "h2", vault: V, name: "b", weight: 1, secretSha256: "s2" });
  const usage = opts.usage ?? { h1: [0], h2: [0] };
  const ctl = { status: opts.status ?? ("success" as TxStatus), known: true, prepared: 0 };
  const chain: Chain = {
    yieldOf: async () => opts.yieldMicro ?? 2_000_000_000n,
    lossPending: async () => opts.lossPending ?? false,
    report: async (v) => { events.push(`report:${v}`); return "0xr"; },
    totalAssets: async () => 1_000_000_000n,
    settle: async (v, u) => chain.sendSettle(v, u),
    // each prepared transaction gets its own hash: "0xs", then "0xs2", "0xs3", ...; send() records the broadcast
    prepareSettle: async (v, u) => {
      ctl.prepared++;
      const hash = ctl.prepared === 1 ? "0xs" : `0xs${ctl.prepared}`;
      return { hash, send: async () => { events.push(`settle:${u}`); } };
    },
    sendSettle: async (v, u) => { const p = await chain.prepareSettle(v, u); await p.send(); return p.hash; },
    settleStatus: async () => ctl.status,
    transactionKnown: async () => ctl.known,
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
    deleteKey: async () => {},
    getGeneration: async () => undefined,
  };
  const d: KeeperDeps = { chain, store, or, params: HACKATHON_PARAMS, log: () => {}, sleep: async () => {} };
  return { d, store, events, ctl };
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

test("reportAll skips an empty vault", async () => {
  const empty = "0x00000000000000000000000000000000000000bb";
  const { d, store, events } = setup();
  store.addVault(empty, "0x1", "U");
  d.chain.totalAssets = async (v) => (v === empty ? 1_000n : 1_000_000_000n);
  await reportAll(d, 5);
  assert.ok(!events.includes(`report:${empty}`));
  assert.ok(events.includes(`report:${V}`));
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
  const orig = d.chain.prepareSettle;
  d.chain.prepareSettle = async (v, u) => { await gate; return orig(v, u); };
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

test("a sync during settlement does not move the baseline past the settled usage", async () => {
  // h1 reads 100 on the freeze pass, 101 on the re-read, 150 on any later read
  const { d, store, events } = setup({ usage: { h1: [100, 101, 150], h2: [0] } });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const waiting = new Promise<void>((r) => { entered = r; });
  const orig = d.chain.prepareSettle;
  d.chain.prepareSettle = async (v, u) => { entered(); await gate; return orig(v, u); };
  const p = settleVault(d, V);
  await waiting;
  await syncAll(d); // a minute tick or POST /api/admin/sync while chain.settle is in flight
  assert.deepEqual(events.filter((e) => e.startsWith("limit:h1:")), ["limit:h1:100"]); // only the freeze
  assert.ok(!events.includes("get:h1:150"));
  release();
  const r = await p;
  assert.equal(store.keyByHash("h1")!.baseline, 101);
  assert.equal(r!.usage, 101_000_000n);
  assert.equal(store.vault(V)!.period, 1);
});

test("settling an unknown vault does nothing", async () => {
  const { d, store, events } = setup();
  assert.equal(await settleVault(d, "0x00000000000000000000000000000000000000bb"), null);
  assert.ok(!events.some((e) => e.startsWith("settle:")));
  assert.equal(store.listSettlements().length, 0);
});

const OCT = Date.UTC(2026, 9, 10, 12, 0);
const NOV = Date.UTC(2026, 10, 1, 0, 0);
const MIN = 60_000;
const settles = (events: string[]) => events.filter((e) => e.startsWith("settle:")).length;
const lastLimit = (events: string[], hash: string) => events.filter((e) => e.startsWith(`limit:${hash}:`)).at(-1);

test("a settlement is persisted before the broadcast", async () => {
  const { d, store } = setup({ usage: { h1: [100], h2: [0] }, status: "pending" });
  const orig = d.chain.prepareSettle;
  let persistedAtSend: string | undefined;
  d.chain.prepareSettle = async (v, u) => {
    const p = await orig(v, u);
    assert.equal(store.pendingSettlement(V), undefined); // nothing persisted until the hash is known
    return { hash: p.hash, send: async () => { persistedAtSend = store.pendingSettlement(V)?.tx; await p.send(); } };
  };
  const r = await settleVault(d, V, OCT);
  assert.equal(persistedAtSend, "0xs");
  assert.deepEqual(r, { usage: 100_000_000n, tx: "0xs", pending: true });
  const p = store.pendingSettlement(V)!;
  assert.equal(p.usageMicro, 100_000_000n);
  assert.deepEqual(p.baselines, [{ hash: "h1", baseline: 100 }, { hash: "h2", baseline: 0 }]);
  assert.equal(p.createdAt, OCT);
  assert.equal(store.keyByHash("h1")!.baseline, 0);
  assert.equal(store.vault(V)!.period, 0);
  assert.equal(store.listSettlements().length, 0);
});

test("an error while waiting for the receipt leaves the settlement pending", async () => {
  const { d, store } = setup({ usage: { h1: [100], h2: [0] } });
  d.chain.settleStatus = async () => { throw new Error("rpc down"); };
  const r = await settleVault(d, V, OCT);
  assert.equal(r!.pending, true);
  assert.equal(store.pendingSettlement(V)!.tx, "0xs");
  assert.equal(store.listSettlements().length, 0);
});

test("reconciliation applies the bookkeeping once", async () => {
  // h1 reads 100 at the freeze and re-read, then 150 once usage moves on
  const { d, store, events, ctl } = setup({ usage: { h1: [100, 100, 150], h2: [0] }, status: "pending" });
  await settleVault(d, V, OCT);
  ctl.status = "success";
  await tick(d, OCT + MIN);
  assert.equal(store.listSettlements().length, 1);
  assert.equal(store.listSettlements()[0].usageMicro, "100000000");
  assert.equal(store.keyByHash("h1")!.baseline, 100); // the snapshot, not the later 150
  assert.equal(store.vault(V)!.period, 1);
  assert.equal(store.pendingSettlement(V), undefined);
  assert.equal(store.getMeta("settledMonth:" + V), "2026-10");
  await tick(d, OCT + 2 * MIN);
  await reconcilePending(d, OCT + 3 * MIN);
  assert.equal(store.listSettlements().length, 1);
  assert.equal(store.vault(V)!.period, 1);
  assert.equal(settles(events), 1);
});

test("a reverted settlement clears the pending row, moves nothing and reopens the keys", async () => {
  const { d, store, events } = setup({ usage: { h1: [100], h2: [0] }, status: "reverted" });
  assert.equal(await settleVault(d, V, OCT), null);
  assert.equal(store.pendingSettlement(V), undefined);
  assert.equal(store.listSettlements().length, 0);
  assert.equal(store.keyByHash("h1")!.baseline, 0);
  assert.equal(store.vault(V)!.period, 0);
  assert.equal(lastLimit(events, "h1"), "limit:h1:1000"); // the freeze at 100 was lifted
});

test("reconciling a reverted settlement clears the row and moves nothing", async () => {
  const { d, store, events, ctl } = setup({ usage: { h1: [100], h2: [0] }, status: "pending" });
  await settleVault(d, V, OCT);
  ctl.status = "reverted";
  await reconcilePending(d, OCT + MIN);
  assert.equal(store.pendingSettlement(V), undefined);
  assert.equal(store.listSettlements().length, 0);
  assert.equal(store.keyByHash("h1")!.baseline, 0);
  assert.equal(store.vault(V)!.period, 0);
  assert.equal(lastLimit(events, "h1"), "limit:h1:1000");
});

test("a vault with a pending settlement is not synced or settled again", async () => {
  const { d, store, events } = setup({ usage: { h1: [100], h2: [0] }, status: "pending" });
  await tick(d, OCT); // first tick: marks the month, settles nothing
  await settleVault(d, V, OCT);
  const before = events.length;
  await syncAll(d);
  await syncVault(d, V);
  assert.equal(events.length, before); // no usage reads, no limit writes: keys stay pinned at the freeze
  const r = await settleVault(d, V, OCT);
  assert.deepEqual(r, { usage: 100_000_000n, tx: "0xs", pending: true });
  await tick(d, NOV); // a new month, but the vault still has a pending settlement
  assert.equal(settles(events), 1);
  assert.equal(store.listPendingSettlements().length, 1);
});

test("a failed settlement is retried on a later tick within the month", async () => {
  const { d, store, events } = setup();
  await tick(d, OCT);
  const orig = d.chain.prepareSettle;
  d.chain.prepareSettle = async () => { throw new Error("simulation failed"); };
  await tick(d, NOV);
  assert.equal(settles(events), 0);
  assert.equal(store.pendingSettlement(V), undefined);
  assert.equal(store.getMeta("settledMonth:" + V), "2026-10");
  d.chain.prepareSettle = orig;
  await tick(d, NOV + 10 * MIN); // once the backoff has passed
  assert.equal(settles(events), 1);
  assert.equal(store.listSettlements().length, 1);
  assert.equal(store.getMeta("settledMonth:" + V), "2026-11");
  await tick(d, NOV + 20 * MIN);
  assert.equal(settles(events), 1);
});

test("a failed prepare reopens the keys and backs off before retrying", async () => {
  const { d, store, events, ctl } = setup({ usage: { h1: [100], h2: [0] } });
  await tick(d, OCT);
  const orig = d.chain.prepareSettle;
  d.chain.prepareSettle = async () => { ctl.prepared++; throw new Error("simulation failed"); };
  await tick(d, NOV);
  assert.equal(ctl.prepared, 1);
  assert.ok(events.includes("limit:h1:100")); // the freeze happened
  assert.equal(lastLimit(events, "h1"), "limit:h1:1000"); // and was lifted within the same tick
  assert.equal(store.getMeta("settleRetryAfter:" + V), String(NOV + 10 * MIN));
  await tick(d, NOV + 5 * MIN);
  assert.equal(ctl.prepared, 1); // within the backoff: not retried
  d.chain.prepareSettle = orig;
  await tick(d, NOV + 10 * MIN);
  assert.equal(settles(events), 1);
  assert.equal(store.listSettlements().length, 1);
});

test("a vault registered mid-month is not settled that month", async () => {
  const { d, store, events } = setup();
  const W = "0x00000000000000000000000000000000000000bb";
  await tick(d, OCT);
  store.addVault(W, "0x00000000000000000000000000000000000000cc", "U");
  await tick(d, OCT + 86_400_000);
  assert.equal(settles(events), 0);
  assert.equal(store.getMeta("settledMonth:" + W), "2026-10");
  await tick(d, NOV);
  assert.equal(settles(events), 2); // both vaults settle in the next month
});

test("a reconcile in flight holds the vault, so a revert cannot drop a newer settlement", async () => {
  const { d, store, events, ctl } = setup({ usage: { h1: [100], h2: [0] }, status: "pending" });
  await settleVault(d, V, OCT); // pending row for 0xs
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const waiting = new Promise<void>((r) => { entered = r; });
  let gated = false;
  d.chain.settleStatus = async (tx) => {
    if (tx !== "0xs") return ctl.status;
    if (!gated) { gated = true; entered(); await gate; } // only the reconcile's lookup waits
    return "reverted";
  };
  const reconciling = reconcilePending(d, OCT + MIN);
  await waiting;
  // an admin settle while the reconcile waits on the old receipt must not start a new settlement
  assert.equal(await settleVault(d, V, OCT + MIN), null);
  assert.equal(settles(events), 1);
  release();
  await reconciling;
  assert.equal(store.pendingSettlement(V), undefined);
  ctl.status = "success";
  const r = await settleVault(d, V, OCT + 2 * MIN);
  assert.deepEqual(r, { usage: 100_000_000n, tx: "0xs2" });
  await reconcilePending(d, OCT + 3 * MIN);
  assert.deepEqual(store.listSettlements().map((x) => x.tx), ["0xs2"]);
  assert.equal(store.vault(V)!.period, 1);
});

test("a mined settlement whose row vanished is reported pending, not settled", async () => {
  const { d, store } = setup({ usage: { h1: [100], h2: [0] } });
  let polls = 0;
  d.chain.settleStatus = async (tx) => {
    if (polls++ === 0) {
      store.clearPendingSettlement(V, tx); // e.g. the admin escape hatch while the receipt was awaited
      return "pending";
    }
    return "success";
  };
  const r = await settleVault(d, V, OCT);
  assert.deepEqual(r, { usage: 100_000_000n, tx: "0xs", pending: true });
  assert.equal(store.listSettlements().length, 0);
  assert.equal(store.vault(V)!.period, 0);
});

test("an ambiguous broadcast stays pending and is not sent twice", async () => {
  const { d, store, events, ctl } = setup({ usage: { h1: [100], h2: [0] }, status: "pending" });
  await tick(d, OCT);
  const orig = d.chain.prepareSettle;
  d.chain.prepareSettle = async (v, u) => {
    const p = await orig(v, u);
    return { hash: p.hash, send: async () => { await p.send(); throw new Error("send timed out"); } };
  };
  await tick(d, NOV);
  assert.equal(settles(events), 1);
  assert.equal(store.pendingSettlement(V)!.tx, "0xs");
  assert.equal(store.getMeta("settleRetryAfter:" + V), undefined); // not a prepare failure
  await tick(d, NOV + MIN);
  assert.equal(settles(events), 1); // still pending: no second send
  ctl.status = "success";
  await tick(d, NOV + 2 * MIN);
  assert.equal(store.listSettlements().length, 1);
  assert.equal(store.pendingSettlement(V), undefined);
  assert.equal(store.getMeta("settledMonth:" + V), "2026-11");
  await tick(d, NOV + 3 * MIN);
  assert.equal(settles(events), 1);
  assert.equal(store.listSettlements().length, 1);
});

test("a settlement unknown to the node past the age limit is cleared and retried", async () => {
  const { d, store, events, ctl } = setup({ usage: { h1: [100], h2: [0] }, status: "pending" });
  let lookups = 0;
  d.chain.transactionKnown = async () => { lookups++; return ctl.known; };
  await tick(d, OCT);
  await tick(d, NOV); // sends 0xs, which never mines
  ctl.known = false;
  await tick(d, NOV + 10 * MIN);
  assert.equal(lookups, 0); // young rows are not looked up
  assert.equal(store.pendingSettlement(V)!.tx, "0xs");
  await tick(d, NOV + 31 * MIN);
  assert.equal(lookups, 1);
  // cleared, then the month rule settled the vault again in the same tick
  assert.equal(settles(events), 2);
  assert.equal(store.pendingSettlement(V)!.tx, "0xs2");
});

test("a settlement known to the node but unmined stays pending past the age limit", async () => {
  const { d, store } = setup({ usage: { h1: [100], h2: [0] }, status: "pending" });
  const logs: string[] = [];
  d.log = (m) => logs.push(m);
  await settleVault(d, V, OCT);
  await tick(d, OCT + 31 * MIN);
  assert.equal(store.pendingSettlement(V)!.tx, "0xs");
  assert.ok(logs.some((m) => m.includes("still unmined after 31 min")));
});

test("a second settle that loses the persist race does not broadcast", async () => {
  // a second copy of the keeper module has its own in-process guard, like the CLI in another process
  const other: typeof import("../keeper.ts") = await import(new URL("../keeper.ts?process=cli", import.meta.url).href);
  const { d, store, events, ctl } = setup({ usage: { h1: [100], h2: [0] }, status: "pending" });
  const orig = d.chain.prepareSettle;
  const gates: (() => void)[] = [];
  const entered: Promise<void>[] = [];
  const arrivals: (() => void)[] = [];
  for (let i = 0; i < 2; i++) entered.push(new Promise<void>((r) => { arrivals.push(r); }));
  let calls = 0;
  d.chain.prepareSettle = async (v, u) => {
    const i = calls++;
    const p = await orig(v, u);
    await new Promise<void>((r) => { gates[i] = r; arrivals[i](); });
    return p;
  };
  const first = settleVault(d, V, OCT); // the server's settlement: 0xs
  const second = other.settleVault(d, V, OCT); // the CLI's: 0xs2, signed while the first is in flight
  await Promise.all(entered);
  gates[0]();
  assert.deepEqual(await first, { usage: 100_000_000n, tx: "0xs", pending: true });
  gates[1]();
  const r2 = await second;
  assert.equal(settles(events), 1); // exactly one broadcast
  assert.equal(store.pendingSettlement(V)!.tx, "0xs");
  assert.deepEqual(r2, { usage: 100_000_000n, tx: "0xs", pending: true });
  assert.equal(store.getMeta("settleRetryAfter:" + V), undefined);
  ctl.status = "success";
  await reconcilePending(d, OCT + MIN);
  await other.reconcilePending(d, OCT + 2 * MIN);
  assert.deepEqual(store.listSettlements().map((x) => x.tx), ["0xs"]);
  assert.equal(store.vault(V)!.period, 1);
  assert.equal(store.pendingSettlement(V), undefined);
});
