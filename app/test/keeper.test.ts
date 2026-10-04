import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../store.ts";
import {
  syncVault, syncAll, settleVault, reportAll, reportVault, tick, toolBudgetFor, reconcilePending, resolvePendingModelCalls, checkDrift,
  readSpendSnapshot, SNAPSHOT_ATTEMPTS, type KeeperDeps,
} from "../keeper.ts";
import type { Chain, TxStatus } from "../chain.ts";
import type { OpenRouter } from "../openrouter.ts";
import { HACKATHON_PARAMS } from "../../engine/ledger.ts";

const V = "0x00000000000000000000000000000000000000aa";
const OR = "orhash";

/** Yield defaults to $2,000. orUsage is the sequence of cumulative usage readings OpenRouter returns for the company key. */
function setup(opts: { yieldMicro?: bigint; lossPending?: boolean; orUsage?: number[]; status?: TxStatus; noOrKey?: boolean } = {}) {
  const events: string[] = [];
  const logs: string[] = [];
  const store = openStore(":memory:");
  store.addVault(V, "0x00000000000000000000000000000000000000cc", "T");
  if (!opts.noOrKey) store.setVaultOpenRouterKey(V, OR, "enc:sk-or-v1-company");
  store.addKey({ id: "k1", vault: V, name: "a", weight: 1, secretSha256: "s1" });
  store.addKey({ id: "k2", vault: V, name: "b", weight: 1, secretSha256: "s2" });
  const usage = opts.orUsage ?? [0];
  const ctl = { status: opts.status ?? ("success" as TxStatus), known: true, prepared: 0, generations: {} as Record<string, number> };
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
    targetOf: async () => "0x",
  };
  const or: OpenRouter = {
    createKey: async () => ({ key: "k", hash: "h" }),
    getKey: async (h) => {
      const u = usage.length > 1 ? usage.shift()! : usage[0];
      events.push(`get:${h}:${u}`);
      return { hash: h, usage: u, limit: null, disabled: false };
    },
    setLimit: async (h, l) => { events.push(`limit:${h}:${l}`); },
    deleteKey: async () => {},
    getGeneration: async (id, apiKey) => {
      events.push(`gen:${id}:${apiKey}`);
      const cost = ctl.generations[id];
      return cost === undefined ? undefined : { id, model: "m", totalCost: cost };
    },
  };
  const d: KeeperDeps = {
    chain, store, or, params: HACKATHON_PARAMS, log: (m) => logs.push(m), sleep: async () => {},
    decrypt: (e) => e.replace(/^enc:/, ""),
  };
  let gen = 0;
  /** A metered model call on a key, as the proxy records it. */
  const spend = (keyId: string, usd: number) => store.recordModelCall({ keyId, model: "m", costUsd: usd, generationId: `g${++gen}` });
  return { d, store, events, logs, ctl, spend };
}

const OCT = Date.UTC(2026, 9, 10, 12, 0);
const NOV = Date.UTC(2026, 10, 1, 0, 0);
const MIN = 60_000;
const settles = (events: string[]) => events.filter((e) => e.startsWith("settle:")).length;
const lastLimit = (events: string[]) => events.filter((e) => e.startsWith(`limit:${OR}:`)).at(-1);

test("sync pins the company key at its usage plus open credit and stores yield", async () => {
  const { d, store, events, spend } = setup({ orUsage: [100] });
  spend("k1", 100); // k1 has 900 of its 1,000 left, k2 all of its 1,000
  await syncVault(d, V);
  assert.ok(events.includes(`limit:${OR}:2000`)); // 100 used + 1,900 open
  const v = store.vault(V)!;
  assert.equal(v.yieldUsd, 2_000);
  assert.equal(v.orLimit, 2000);
  assert.equal(v.orUsage, 100);
});

test("a successful sync records its time", async () => {
  const { d, store } = setup({ orUsage: [100] });
  await syncVault(d, V, OCT);
  assert.equal(store.syncedAt(V), OCT);
});

test("syncs of one vault run one after another, so a sync after a key change is never overwritten by a slower one", async () => {
  const { d, store, events, spend } = setup();
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let calls = 0;
  d.or.getKey = async (h) => {
    if (++calls === 1) await gate; // the first sync stalls at OpenRouter after it has already read the keys
    return { hash: h, usage: 0, limit: null, disabled: false };
  };
  const slow = syncVault(d, V);
  await new Promise((r) => setImmediate(r)); // let the slow sync reach the gate
  spend("k1", 100); // the open credit is now 1,900, which the slow sync did not see
  const fresh = syncVault(d, V);
  await new Promise((r) => setImmediate(r)); // unqueued, the fresh sync would finish here and the slow one would land last
  release();
  await Promise.all([slow, fresh]);
  assert.equal(lastLimit(events), `limit:${OR}:1900`);
  assert.equal(store.vault(V)!.orLimit, 1900);
});

test("the backstop is held flat while a model call is pending", async () => {
  const { d, store, events, logs } = setup({ orUsage: [0, 10, 10, 10] });
  await syncVault(d, V);
  assert.equal(lastLimit(events), `limit:${OR}:2000`);
  assert.equal(store.vault(V)!.orLimit, 2000);

  store.recordPendingModelCall({ keyId: "k1", model: "m", generationId: "gen-p" });
  await syncVault(d, V);
  assert.equal(lastLimit(events), `limit:${OR}:2000`); // usage moved to 10, but the limit stays held
  assert.equal(store.vault(V)!.orUsage, 10);
  assert.ok(logs.some((m) => m.includes("1 pending model call(s), backstop held at 2000")));

  const beforeResolve = logs.length;
  store.resolveModelCall("gen-p", 10);
  await syncVault(d, V);
  assert.equal(lastLimit(events), `limit:${OR}:2000`); // 10 used + 1990 open
  assert.ok(!logs.slice(beforeResolve).some((m) => m.includes("held")));

  d.chain.yieldOf = async () => 3_000_000_000n;
  store.recordPendingModelCall({ keyId: "k1", model: "m", generationId: "gen-p2" });
  await syncVault(d, V);
  assert.equal(lastLimit(events), `limit:${OR}:2000`); // a raise waits for the resolution

  store.resolveModelCall("gen-p2", 0);
  await syncVault(d, V);
  assert.equal(lastLimit(events), `limit:${OR}:3000`); // 10 used + 2990 open
});

test("a held backstop is pinned at usage when usage overshot the stored limit", async () => {
  const { d, store, events, logs } = setup({ orUsage: [0, 2500, 2500] });
  await syncVault(d, V);
  assert.equal(lastLimit(events), `limit:${OR}:2000`);
  store.recordPendingModelCall({ keyId: "k1", model: "m", generationId: "gen-p" });
  await syncVault(d, V);
  assert.equal(lastLimit(events), `limit:${OR}:2500`); // at usage, never below it
  assert.ok(logs.some((m) => m.includes("1 pending model call(s), backstop held at 2500")), logs.join("\n"));
  store.resolveModelCall("gen-p", 500);
  await syncVault(d, V);
  assert.equal(lastLimit(events), `limit:${OR}:4000`); // 2,500 used + 1,500 open
});

test("a vault with no stored limit is not held", async () => {
  const { d, store, events, logs } = setup({ orUsage: [0] });
  store.recordPendingModelCall({ keyId: "k1", model: "m", generationId: "gen-p" });
  await syncVault(d, V);
  assert.equal(lastLimit(events), `limit:${OR}:2000`);
  assert.ok(!logs.some((m) => m.includes("held")));
});

test("a vault without an OpenRouter key on file syncs its yield and pins nothing", async () => {
  const { d, store, events, logs } = setup({ noOrKey: true });
  await syncVault(d, V);
  assert.equal(store.vault(V)!.yieldUsd, 2_000);
  assert.ok(!events.some((e) => e.startsWith("limit:")));
  assert.ok(logs.some((m) => m.includes("no OpenRouter key on file")));
});

test("freezes the company key at its usage when a loss is pending", async () => {
  const { d, store, events } = setup({ lossPending: true, orUsage: [47.5] });
  store.recordPendingModelCall({ keyId: "k1", model: "m", generationId: "gen-p" }); // the hold never raises a freeze
  await syncVault(d, V);
  assert.ok(events.includes(`limit:${OR}:47.5`));
  assert.equal(store.vault(V)!.frozen, true);
});

test("skips settlement when a loss is pending", async () => {
  const { d, store, events } = setup({ lossPending: true });
  assert.equal(await settleVault(d, V), null);
  assert.ok(!events.some((e) => e.startsWith("settle:")));
  assert.equal(store.vault(V)!.settling, false);
});

test("settle closes the vault, pins the backstop, drains in-flight metering, then settles", async () => {
  const { d, store, events, spend } = setup({ orUsage: [100] });
  spend("k1", 100);
  d.drain = async (vault, ms) => {
    events.push(`drain:${vault}:${ms}`);
    assert.equal(store.vault(V)!.settling, true);
    spend("k1", 1); // a request that was in flight finishes metering during the drain
  };
  const r = await settleVault(d, V);
  const iFreeze = events.indexOf(`limit:${OR}:100`);
  const iDrain = events.indexOf(`drain:${V}:10000`);
  const iSettle = events.findIndex((e) => e.startsWith("settle:"));
  assert.ok(iFreeze >= 0 && iFreeze < iDrain && iDrain < iSettle, events.join(","));
  assert.equal(r!.usage, 101_000_000n);
  assert.equal(store.vault(V)!.period, 1);
  assert.equal(store.vault(V)!.settling, false);
  assert.equal(store.keyById("k1")!.modelSpent, 0);
  assert.equal(store.listSettlements().length, 1);
  assert.equal(lastLimit(events), `limit:${OR}:2100`); // reopened after settlement: 100 used + 2,000 open
});

test("settlement usage is model cost over the rail fee plus tool spend", async () => {
  const { d, store, spend } = setup();
  d.params = { ...HACKATHON_PARAMS, railFee: 0.05 };
  spend("k1", 19);
  store.recordToolCall("k2", "a", "/b", 10);
  const r = await settleVault(d, V);
  assert.equal(r!.usage, 30_000_000n);
});

test("reportAll stops and propagates the first report failure before another vault can sign", async () => {
  const { d, store, events } = setup();
  store.addVault("0x00000000000000000000000000000000000000bb", "0x1", "U");
  const orig = d.chain.report;
  d.chain.report = async (v) => { if (v.endsWith("aa")) throw new Error("boom"); return orig(v); };
  await assert.rejects(reportAll(d, 5), /boom/);
  assert.ok(!events.includes("report:0x00000000000000000000000000000000000000bb"));
  assert.equal(store.getMeta("lastReport"), undefined);
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

test("tick reports once a day with a drift check, and settles on a new month, not on first run", async () => {
  const { d, store, events, logs, spend } = setup({ orUsage: [1.5] });
  spend("k1", 1.5);
  const day1 = Date.UTC(2026, 9, 1, 0, 0);
  await tick(d, day1);
  assert.equal(events.filter((e) => e.startsWith("report:")).length, 1);
  assert.equal(events.filter((e) => e.startsWith("settle:")).length, 0);
  assert.ok(logs.includes(`drift ${V}: openrouter usage 1.5 recorded 1.5 drift 0`), logs.join("\n"));
  await tick(d, day1 + 60_000);
  assert.equal(events.filter((e) => e.startsWith("report:")).length, 1);
  assert.equal(logs.filter((m) => m.startsWith("drift ")).length, 1);
  await tick(d, Date.UTC(2026, 10, 1, 0, 0));
  assert.equal(events.filter((e) => e.startsWith("settle:")).length, 1);
  assert.equal(store.getMeta("lastSettleMonth"), "2026-11");
});

test("the drift check compares the company key's usage with recorded model cost", async () => {
  const { d, logs, spend } = setup({ orUsage: [3] });
  spend("k1", 1);
  spend("k2", 1.5);
  await checkDrift(d);
  assert.ok(logs.includes(`drift ${V}: openrouter usage 3 recorded 2.5 drift 0.5`), logs.join("\n"));
});

test("the daily check reports recorded cost that no settlement billed", async () => {
  const { d, store, logs, spend } = setup({ orUsage: [2.75] });
  spend("k1", 0.25);
  store.startNewPeriod(V); // the 0.25 row now sits in a period no settlement covered
  spend("k1", 2);
  await settleVault(d, V); // bills 2; the vault moves to period 2
  assert.equal(store.vault(V)!.period, 2);
  spend("k1", 0.5);
  await checkDrift(d);
  assert.ok(logs.includes(`drift ${V}: openrouter usage 2.75 recorded 2.75 drift 0`), logs.join("\n"));
  assert.ok(logs.includes(`billing ${V}: recorded 2.75 billed 2 current period 0.5 unbilled 0.25`), logs.join("\n"));
});

test("the billing check flags a vault whose settlement predates metering", async () => {
  const { d, store, logs } = setup();
  store.recordSettlement(V, 5_000_000n, "0xold"); // billed directly, with no model_calls rows behind it
  await checkDrift(d);
  assert.ok(
    logs.includes(`billing ${V}: recorded 0 billed 5 current period 0 unbilled -5 (settlements predate metering)`),
    logs.join("\n"),
  );
});

test("pending model calls are resolved through the generation lookup with the company key", async () => {
  const { d, store, events, ctl } = setup();
  store.recordPendingModelCall({ keyId: "k1", model: "m", generationId: "gen-1" });
  store.recordPendingModelCall({ keyId: "k1", model: "m", generationId: "gen-2" });
  ctl.generations["gen-1"] = 0.25;
  await resolvePendingModelCalls(d, OCT);
  assert.ok(events.includes("gen:gen-1:sk-or-v1-company")); // decrypted, never the stored form
  assert.equal(store.modelCall("gen-1")!.status, "recorded");
  assert.equal(store.modelCall("gen-1")!.costUsd, 0.25);
  assert.equal(store.modelCall("gen-2")!.status, "pending");
  assert.equal(store.keyById("k1")!.modelSpent, 0.25);
  ctl.generations["gen-2"] = 0.5;
  await tick(d, OCT + MIN); // the tick resolves the rest
  assert.equal(store.listPendingModelCalls().length, 0);
  assert.equal(store.keyById("k1")!.modelSpent, 0.75);
});

test("a pending model call unresolved for a day is logged, not dropped", async () => {
  const { d, store, logs } = setup();
  store.recordPendingModelCall({ keyId: "k1", model: "m", generationId: "gen-old" }, OCT - 2 * 86_400_000);
  d.or.getGeneration = async () => { throw new Error("rate limited"); };
  await resolvePendingModelCalls(d, OCT);
  assert.equal(store.listPendingModelCalls().length, 1);
  assert.ok(logs.some((m) => m.includes("gen-old") && m.includes("lookup failed")));
  const unresolved = () => logs.filter((m) => m.includes("gen-old") && m.includes("unresolved for"));
  assert.equal(unresolved().length, 1);
  assert.ok(unresolved()[0].includes("unresolved for 48 h"));
  d.or.getGeneration = async () => undefined;
  await resolvePendingModelCalls(d, OCT + MIN);
  assert.equal(store.listPendingModelCalls().length, 1);
  assert.equal(unresolved().length, 1); // once a day, not every tick
  await resolvePendingModelCalls(d, OCT + 86_400_000);
  assert.equal(unresolved().length, 2);
  assert.ok(unresolved()[1].includes("unresolved for 72 h"));
});

test("a vault whose OpenRouter key cannot be decrypted does not stop the keeper", async () => {
  const { d, store, events, logs } = setup();
  store.recordPendingModelCall({ keyId: "k1", model: "m", generationId: "gen-1" });
  d.decrypt = () => { throw new Error("bad tag"); };
  await tick(d, OCT);
  assert.equal(store.listPendingModelCalls().length, 1);
  assert.ok(logs.includes(`model call gen-1 for ${V}: cannot decrypt the OpenRouter key: bad tag`), logs.join("\n"));
  assert.ok(events.some((e) => e.startsWith(`limit:${OR}:`))); // syncAll still ran
});

test("a pending call resolved while a settlement is open is billed in the next period", async () => {
  const { d, store, events, ctl, spend } = setup({ orUsage: [100], status: "pending" });
  spend("k1", 100);
  await settleVault(d, V, OCT); // pending row for 0xs; the vault is closed
  store.recordPendingModelCall({ keyId: "k1", model: "m", generationId: "gen-late" });
  ctl.generations["gen-late"] = 0.4;
  await tick(d, OCT + MIN);
  assert.equal(store.modelCall("gen-late")!.status, "pending");
  assert.ok(!events.some((e) => e.startsWith("gen:gen-late")));
  ctl.status = "success";
  await tick(d, OCT + 2 * MIN); // applies the settlement, then resolves the call into the new period
  assert.equal(store.modelCall("gen-late")!.period, 1);
  assert.equal(store.keyById("k1")!.modelSpent, 0.4);
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
  const syncedBefore = events.filter((e) => e === `get:${OR}:0`).length;
  await tick(d, day1 + 86_400_000 + 60_000); // a third tick, after both earlier ones settled
  const syncedAfter = events.filter((e) => e === `get:${OR}:0`).length;
  assert.equal(events.filter((e) => e.startsWith("report:")).length, 2);
  assert.equal(syncedAfter, syncedBefore + 2); // one sync read plus one drift read
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

test("toolBudgetFor uses the last synced state and refuses revoked keys and closed vaults", async () => {
  const { d, store, spend } = setup();
  spend("k1", 100);
  await syncVault(d, V);
  store.recordToolCall("k1", "a", "/b", 50);
  assert.equal(toolBudgetFor(store, HACKATHON_PARAMS, "k1"), 850);
  assert.equal(toolBudgetFor(store, HACKATHON_PARAMS, "k1", 10 * 60_000, Date.now() + 11 * 60_000), 0); // a stale budget
  assert.equal(toolBudgetFor(store, HACKATHON_PARAMS, "nope"), 0);
  store.setSettling(V, true);
  assert.equal(toolBudgetFor(store, HACKATHON_PARAMS, "k1"), 0);
  store.setSettling(V, false);
  store.setPendingSettlement(V, { usageMicro: 1n, baselines: [], tx: "0xtx" });
  assert.equal(toolBudgetFor(store, HACKATHON_PARAMS, "k1"), 0);
  store.clearPendingSettlement(V, "0xtx");
  store.revokeKey("k1");
  assert.equal(toolBudgetFor(store, HACKATHON_PARAMS, "k1"), 0);
  assert.equal(toolBudgetFor(store, HACKATHON_PARAMS, "k2"), 1850); // the pool cap: 2,000 credit minus k1's 150 spent
});

test("a sync during settlement does not reopen the backstop", async () => {
  const { d, store, events, spend } = setup({ orUsage: [100] });
  spend("k1", 100);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const waiting = new Promise<void>((r) => { entered = r; });
  const orig = d.chain.prepareSettle;
  d.chain.prepareSettle = async (v, u) => { entered(); await gate; return orig(v, u); };
  const p = settleVault(d, V);
  await waiting;
  await syncAll(d); // a minute tick or POST /api/admin/sync while the settlement is in flight
  assert.deepEqual(events.filter((e) => e.startsWith(`limit:${OR}:`)), [`limit:${OR}:100`]); // only the freeze
  release();
  const r = await p;
  assert.equal(r!.usage, 100_000_000n);
  assert.equal(store.vault(V)!.period, 1);
});

test("a stale settling flag is cleared by the next sync", async () => {
  const { d, store, logs } = setup();
  store.setSettling(V, true, Date.now() - 16 * MIN); // e.g. the process died between the freeze and the pending row
  await syncVault(d, V);
  assert.equal(store.vault(V)!.settling, false);
  assert.ok(logs.some((m) => m.includes("stale settling flag cleared")));
});

test("a fresh settling flag from another process is left alone", async () => {
  const { d, store, events, logs } = setup();
  store.setSettling(V, true); // e.g. the CLI just froze the backstop and has not yet persisted a pending row
  await syncVault(d, V);
  assert.equal(store.vault(V)!.settling, true);
  assert.ok(!events.some((e) => e.startsWith("limit:")));
  assert.ok(logs.some((m) => m.includes(`sync ${V} skipped: settling`)));
  assert.equal(store.syncedAt(V), 0);
});

test("settling an unknown vault does nothing", async () => {
  const { d, store, events } = setup();
  assert.equal(await settleVault(d, "0x00000000000000000000000000000000000000bb"), null);
  assert.ok(!events.some((e) => e.startsWith("settle:")));
  assert.equal(store.listSettlements().length, 0);
});

test("a settlement is persisted before the broadcast", async () => {
  const { d, store, spend } = setup({ orUsage: [100], status: "pending" });
  spend("k1", 100);
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
  assert.deepEqual(p.baselines, [{ keyId: "k1", spentUsd: 100 }, { keyId: "k2", spentUsd: 0 }]);
  assert.equal(p.createdAt, OCT);
  assert.equal(p.modelCallId, 1); // the one model call spend() recorded
  assert.equal(p.toolCallId, 0); // no tool calls
  assert.equal(store.vault(V)!.period, 0);
  assert.equal(store.vault(V)!.settling, true); // the proxy keeps refusing until the receipt is seen
  assert.equal(store.listSettlements().length, 0);
});

test("a call metered after the snapshot is billed in the next period", async () => {
  const { d, store, spend } = setup({ orUsage: [100] });
  spend("k1", 100);
  const orig = d.chain.prepareSettle;
  d.chain.prepareSettle = async (v, u) => {
    spend("k1", 5); // metered after the snapshot, before the pending row exists
    return orig(v, u);
  };
  const r = await settleVault(d, V, OCT);
  assert.equal(r!.usage, 100_000_000n);
  assert.equal(store.vault(V)!.period, 1);
  assert.equal(store.keyById("k1")!.modelSpent, 5);
  assert.equal(store.listSettlements().length, 1);
  const r2 = await settleVault(d, V, NOV);
  assert.equal(r2!.usage, 5_000_000n);
  assert.equal(store.listSettlements().length, 2);
});

test("the spend snapshot is re-read when a row lands during the read", () => {
  const { store, spend } = setup();
  spend("k1", 1);
  const orig = store.keysForVault;
  let calls = 0;
  store.keysForVault = (vault: string) => {
    calls++;
    if (calls === 1) spend("k1", 2); // another process metering mid-read
    return orig(vault);
  };
  const { keys, ids } = readSpendSnapshot(store, V);
  assert.equal(ids.model, 2);
  assert.equal(keys.find((k) => k.id === "k1")!.modelSpent, 3);
  assert.equal(calls, 2);
});

test("a spend snapshot that never stabilizes throws so the settlement is retried", async () => {
  const { store, spend } = setup();
  const orig = store.keysForVault;
  let calls = 0;
  store.keysForVault = (vault: string) => {
    calls++;
    spend("k1", 1); // another row lands every time, so the markers never stabilize
    return orig(vault);
  };
  assert.throws(() => readSpendSnapshot(store, V), /did not stabilize/);
  assert.equal(calls, SNAPSHOT_ATTEMPTS);

  const { d, store: store2, spend: spend2, events } = setup({ orUsage: [100] });
  const orig2 = store2.keysForVault;
  store2.keysForVault = (vault: string) => {
    spend2("k1", 1); // another row lands every time, so the markers never stabilize
    return orig2(vault);
  };
  await tick(d, OCT); // registered mid-month: not settled yet, just marks the month
  await tick(d, NOV); // attempts to settle, the snapshot never stabilizes, the settlement is retried later
  assert.equal(settles(events), 0);
  assert.equal(store2.pendingSettlement(V), undefined);
  assert.equal(store2.vault(V)!.settling, false);
  assert.equal(store2.getMeta("settleRetryAfter:" + V), String(NOV + 10 * MIN));
});

test("a row inserted between the spend read and the markers is billed next month, not stranded", async () => {
  const { d, store, spend } = setup({ orUsage: [100] });
  spend("k1", 100);
  let afterFirstKeysForVault = false;
  let inserted = false;
  const origKeys = store.keysForVault;
  store.keysForVault = (vault: string) => {
    afterFirstKeysForVault = true;
    return origKeys(vault);
  };
  const origIds = store.lastCallIds;
  store.lastCallIds = () => {
    if (afterFirstKeysForVault && !inserted) {
      inserted = true;
      spend("k1", 7); // lands between the spend read and its following marker read
    }
    return origIds();
  };
  const r = await settleVault(d, V, OCT);
  assert.equal(r!.usage, 107_000_000n);
  assert.equal(store.listSettlements().length, 1);
  const r2 = await settleVault(d, V, NOV);
  assert.equal(r2!.usage, 0n);
});

test("an error while waiting for the receipt leaves the settlement pending", async () => {
  const { d, store, spend } = setup({ orUsage: [100] });
  spend("k1", 100);
  d.chain.settleStatus = async () => { throw new Error("rpc down"); };
  const r = await settleVault(d, V, OCT);
  assert.equal(r!.pending, true);
  assert.equal(store.pendingSettlement(V)!.tx, "0xs");
  assert.equal(store.listSettlements().length, 0);
});

test("reconciliation applies the bookkeeping once", async () => {
  const { d, store, events, ctl, spend } = setup({ orUsage: [100], status: "pending" });
  spend("k1", 100);
  await settleVault(d, V, OCT);
  ctl.status = "success";
  await tick(d, OCT + MIN);
  assert.equal(store.listSettlements().length, 1);
  assert.equal(store.listSettlements()[0].usageMicro, "100000000");
  assert.equal(store.vault(V)!.period, 1);
  assert.equal(store.vault(V)!.settling, false);
  assert.equal(store.keyById("k1")!.modelSpent, 0);
  assert.equal(store.pendingSettlement(V), undefined);
  assert.equal(store.getMeta("settledMonth:" + V), "2026-10");
  await tick(d, OCT + 2 * MIN);
  await reconcilePending(d, OCT + 3 * MIN);
  assert.equal(store.listSettlements().length, 1);
  assert.equal(store.vault(V)!.period, 1);
  assert.equal(settles(events), 1);
});

test("a reverted settlement clears the pending row, moves nothing and reopens the vault", async () => {
  const { d, store, events, spend } = setup({ orUsage: [100], status: "reverted" });
  spend("k1", 100);
  assert.equal(await settleVault(d, V, OCT), null);
  assert.equal(store.pendingSettlement(V), undefined);
  assert.equal(store.listSettlements().length, 0);
  assert.equal(store.vault(V)!.period, 0);
  assert.equal(store.vault(V)!.settling, false);
  assert.equal(store.keyById("k1")!.modelSpent, 100); // still this period's spend
  assert.equal(lastLimit(events), `limit:${OR}:2000`); // the freeze at 100 was lifted: 100 used + 1,900 open
});

test("reconciling a reverted settlement clears the row and moves nothing", async () => {
  const { d, store, events, ctl, spend } = setup({ orUsage: [100], status: "pending" });
  spend("k1", 100);
  await settleVault(d, V, OCT);
  ctl.status = "reverted";
  await reconcilePending(d, OCT + MIN);
  assert.equal(store.pendingSettlement(V), undefined);
  assert.equal(store.listSettlements().length, 0);
  assert.equal(store.vault(V)!.period, 0);
  assert.equal(store.vault(V)!.settling, false);
  assert.equal(lastLimit(events), `limit:${OR}:2000`);
});

test("a vault with a pending settlement is not synced or settled again", async () => {
  const { d, store, events, spend } = setup({ orUsage: [100], status: "pending" });
  spend("k1", 100);
  await tick(d, OCT); // first tick: marks the month, settles nothing
  await settleVault(d, V, OCT);
  const before = events.length;
  await syncAll(d);
  await syncVault(d, V);
  assert.equal(events.length, before); // no usage reads, no limit writes: the vault stays closed
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

test("a failed prepare reopens the vault and backs off before retrying", async () => {
  const { d, store, events, ctl, spend } = setup({ orUsage: [100] });
  spend("k1", 100);
  await tick(d, OCT);
  const orig = d.chain.prepareSettle;
  d.chain.prepareSettle = async () => { ctl.prepared++; throw new Error("simulation failed"); };
  await tick(d, NOV);
  assert.equal(ctl.prepared, 1);
  assert.ok(events.includes(`limit:${OR}:100`)); // the freeze happened
  assert.equal(lastLimit(events), `limit:${OR}:2000`); // and was lifted within the same tick
  assert.equal(store.vault(V)!.settling, false);
  assert.equal(store.getMeta("settleRetryAfter:" + V), String(NOV + 10 * MIN));
  await tick(d, NOV + 5 * MIN);
  assert.equal(ctl.prepared, 1); // within the backoff: not retried
  d.chain.prepareSettle = orig;
  await tick(d, NOV + 10 * MIN);
  assert.equal(settles(events), 1);
  assert.equal(store.listSettlements().length, 1);
});

test("other vaults are re-synced between settlements on a month roll", async () => {
  const { d, store, events } = setup();
  const W = "0x00000000000000000000000000000000000000bb";
  store.addVault(W, "0x00000000000000000000000000000000000000cc", "U");
  store.setVaultOpenRouterKey(W, "orhash2", "enc:sk-or-v1-other");
  const limitsFor = (h: string) => events.filter((e) => e.startsWith(`limit:${h}:`)).length;
  await tick(d, OCT); // both vaults marked for October
  const atPrepare: { vault: string; firstLimits: number; secondSyncedAt: number }[] = [];
  const prepare = d.chain.prepareSettle;
  d.chain.prepareSettle = async (v, u) => {
    atPrepare.push({ vault: v, firstLimits: limitsFor(OR), secondSyncedAt: store.syncedAt(W) });
    // age the second vault's last sync, so only a sync after the first settlement can refresh it: its own
    // settlement's freeze pins the backstop but is not a sync
    if (atPrepare.length === 1) store.setSyncedAt(W, 1);
    return prepare(v, u);
  };
  await tick(d, NOV);
  assert.deepEqual(atPrepare.map((p) => p.vault), [V, W]);
  assert.ok(atPrepare[1].firstLimits > atPrepare[0].firstLimits); // the first vault was synced again after its settlement
  assert.ok(atPrepare[1].secondSyncedAt > 1, "the second vault was re-synced before its own settlement began");
  assert.equal(store.listSettlements().length, 2);
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
  const { d, store, events, ctl, spend } = setup({ orUsage: [100], status: "pending" });
  spend("k1", 100);
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
  const { d, store, spend } = setup({ orUsage: [100] });
  spend("k1", 100);
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
  const { d, store, events, ctl, spend } = setup({ orUsage: [100], status: "pending" });
  spend("k1", 100);
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

test("an unknown signed settlement stays closed and a late receipt applies once", async () => {
  const { d, store, events, logs, ctl, spend } = setup({ orUsage: [100], status: "pending" });
  spend("k1", 100);
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
  assert.equal(settles(events), 1);
  assert.equal(ctl.prepared, 1);
  assert.equal(store.pendingSettlement(V)!.tx, "0xs");
  assert.equal(store.vault(V)!.settling, true);
  assert.ok(logs.some((m) => m.includes("operator reconciliation required")));
  ctl.status = "success";
  await tick(d, NOV + 32 * MIN);
  await tick(d, NOV + 33 * MIN);
  assert.equal(store.listSettlements().length, 1);
  assert.equal(store.vault(V)!.period, 1);
  assert.equal(ctl.prepared, 1);
});

test("a settlement known to the node but unmined stays pending past the age limit", async () => {
  const { d, store, logs, spend } = setup({ orUsage: [100], status: "pending" });
  spend("k1", 100);
  await settleVault(d, V, OCT);
  await tick(d, OCT + 31 * MIN);
  assert.equal(store.pendingSettlement(V)!.tx, "0xs");
  assert.equal(store.vault(V)!.settling, true);
  assert.ok(logs.some((m) => m.includes("still unmined after 31 min")));
});

test("a second settle that loses the persist race does not broadcast", async () => {
  // a second copy of the keeper module has its own in-process guard, like the CLI in another process
  const other: typeof import("../keeper.ts") = await import(new URL("../keeper.ts?process=cli", import.meta.url).href);
  const { d, store, events, ctl, spend } = setup({ orUsage: [100], status: "pending" });
  spend("k1", 100);
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
  assert.equal(store.vault(V)!.settling, false);
  assert.equal(store.pendingSettlement(V), undefined);
});

test("reportVault reports one vault and skips an empty one", async () => {
  const empty = "0x00000000000000000000000000000000000000bb";
  const { d, store, events } = setup();
  store.addVault(empty, "0x1", "U");
  d.chain.totalAssets = async (v) => (v === empty ? 1_000n : 1_000_000_000n);
  await reportVault(d, V);
  await reportVault(d, empty);
  assert.deepEqual(events.filter((e) => e.startsWith("report:")), [`report:${V}`]);
  assert.equal(store.getMeta("lastReport"), undefined); // only reportAll stamps the day
});

test("a lifetime provider allowance bounds concurrent vaults and survives settlement and new keeper deps", async () => {
  const { d, store, spend } = setup();
  const other = "0x00000000000000000000000000000000000000bb";
  store.addVault(other, "0xcc", "second");
  store.setVaultOpenRouterKey(other, "other", "enc:other");
  store.addKey({ id: "k3", vault: other, name: "c", weight: 1, secretSha256: "s3" });
  const live = new Map([OR, "other"].map((hash) => [hash, { hash, usage: 0, limit: 0, disabled: false }]));
  d.openRouterTotalLimitUsd = 0.9;
  d.or.getKey = async (hash) => ({ ...live.get(hash)! });
  d.or.setLimit = async (hash, limit) => { live.get(hash)!.limit = limit; };
  await Promise.all([syncVault(d, V), syncVault(d, other)]);
  assert.equal(live.get(OR)!.limit, 0.9);
  assert.equal(live.get("other")!.limit, 0);
  live.get(OR)!.usage = 0.2;
  spend("k1", 0.2);
  d.chain.yieldOf = async (vault) => vault === V ? 0n : 2_000_000_000n;
  await settleVault(d, V);
  assert.equal(live.get(OR)!.limit, 0.2);
  store.setVaultState(V, { orLimit: 0, orUsage: 0 });
  await syncVault({ ...d }, other);
  assert.equal(live.get("other")!.limit, 0.7);
  await syncVault({ ...d }, V);
  assert.ok(live.get(OR)!.limit <= 0.2);
});

test("provider allowance fails closed on unknown reservations and recovers after a failed PATCH", async () => {
  const { d, store } = setup();
  const other = "0x00000000000000000000000000000000000000bb";
  store.addVault(other, "0xcc", "second");
  store.setVaultOpenRouterKey(other, "other", "enc:other");
  store.addKey({ id: "k3", vault: other, name: "c", weight: 1, secretSha256: "s3" });
  d.openRouterTotalLimitUsd = 0.9;
  const live = new Map([OR, "other"].map((hash) => [hash, { hash, usage: 0, limit: 0 as number | null, disabled: false }]));
  let patches = 0;
  d.or.getKey = async (hash) => ({ ...live.get(hash)! });
  d.or.setLimit = async () => { patches++; throw new Error("PATCH failed"); };
  live.get("other")!.limit = null;
  await assert.rejects(syncVault(d, V), /accounting/);
  assert.equal(patches, 0);
  live.get("other")!.limit = 0;
  await assert.rejects(syncVault(d, V), /PATCH failed/);
  assert.equal(patches, 1);
  d.or.setLimit = async (hash, limit) => { live.get(hash)!.limit = limit; };
  await syncVault(d, other);
  assert.equal(live.get("other")!.limit, 0.9);
  live.get(OR)!.usage = 0.1;
  await syncVault(d, V);
  assert.equal(live.get(OR)!.limit, 0);
});


test("supervised ticks reconcile receipts and model usage and sync without automatic transactions", async () => {
  const { d, store, events, ctl } = setup({ status: "pending" });
  d.automaticTransactions = false;
  await settleVault(d, V, OCT);
  store.recordPendingModelCall({ keyId: "k1", model: "m", generationId: "late" });
  ctl.generations.late = 0.1;
  ctl.status = "success";
  await tick(d, NOV);
  await tick(d, Date.UTC(2026, 11, 1));
  assert.equal(store.listSettlements().length, 1);
  assert.equal(store.modelCall("late")!.status, "recorded");
  assert.ok(store.syncedAt(V) > 0);
  assert.equal(events.filter((e) => e.startsWith("report:")).length, 0);
  assert.equal(ctl.prepared, 1);
  await reportVault(d, V);
  await settleVault(d, V);
  assert.equal(ctl.prepared, 2);
  assert.equal(events.filter((e) => e.startsWith("report:")).length, 1);
});

for (const firstAction of ["report", "settle"] as const) {
  test(`an in-flight ${firstAction} rejects report and settlement signing across vaults`, async () => {
    const { d, store, ctl } = setup();
    const other = "0x00000000000000000000000000000000000000bb";
    store.addVault(other, "0xcc", "other");
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const ready = new Promise<void>((r) => { entered = r; });
    if (firstAction === "report") d.chain.report = async (v) => { if (v === V) { entered(); await gate; } return "0xr"; };
    else {
      const prepare = d.chain.prepareSettle;
      d.chain.prepareSettle = async (v, u) => { if (v === V) { entered(); await gate; } return prepare(v, u); };
    }
    const first = firstAction === "report" ? reportVault(d, V) : settleVault(d, V);
    await ready;
    try {
      await assert.rejects(reportVault(d, other), /keeper transaction in progress/);
      await assert.rejects(settleVault(d, other), /keeper transaction in progress/);
      assert.equal(ctl.prepared, 0);
    } finally { release(); await first; }
    await settleVault(d, other);
    assert.equal(ctl.prepared, firstAction === "report" ? 1 : 2);
  });
}

test("an unresolved settlement blocks new writes to every vault until receipt reconciliation", async () => {
  const { d, store, ctl } = setup({ status: "pending" });
  const other = "0x00000000000000000000000000000000000000bb";
  store.addVault(other, "0xcc", "other");
  await settleVault(d, V, OCT);
  ctl.known = false;
  await reconcilePending(d, OCT + 31 * MIN);
  await assert.rejects(reportVault(d, other), /unresolved settlement/);
  await assert.rejects(settleVault(d, other), /unresolved settlement/);
  await assert.rejects(reportVault(d, V), /unresolved settlement/);
  assert.equal((await settleVault(d, V))!.tx, "0xs");
  assert.equal(ctl.prepared, 1);
  ctl.status = "success";
  await reconcilePending(d);
  await settleVault(d, other);
  assert.equal(ctl.prepared, 2);
});
