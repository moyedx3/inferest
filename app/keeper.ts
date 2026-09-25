import type { Params } from "../engine/ledger.ts";
import type { Chain, TxStatus } from "./chain.ts";
import type { OpenRouter } from "./openrouter.ts";
import type { Store, KeyRow, PendingSettlement } from "./store.ts";
import { computeLimits, toolBudgetUsd, usageMicro, type KeyLimit } from "./limits.ts";

export type KeeperDeps = {
  chain: Chain; store: Store; or: OpenRouter; params: Params; log: (msg: string) => void;
  /** Delay between receipt polls after sending a settlement (default 2 s). */
  waitMs?: number;
  /** Receipt polls before leaving a settlement pending for reconciliation (default 60, about 2 minutes). */
  waitAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type SettleResult = { usage: bigint; tx: string; pending?: true };

const DAY_MS = 86_400_000;
const DEFAULT_WAIT_MS = 2_000;
const DEFAULT_WAIT_ATTEMPTS = 60;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** UTC calendar month, e.g. "2026-11". */
export const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
/** The meta key holding the last month a vault was settled for. */
export const settledMonthKey = (vault: string): string => `settledMonth:${vault.toLowerCase()}`;

/** Marks a newly registered vault as settled for this month, so its first settlement is next month. */
export function markRegistered(store: Store, vault: string, now: number = Date.now()): void {
  if (store.getMeta(settledMonthKey(vault)) === undefined) store.setMeta(settledMonthKey(vault), monthOf(now));
}

let ticking = false;
const settlingVaults = new Set<string>();

async function refreshUsage(d: KeeperDeps, keys: KeyRow[]): Promise<void> {
  for (const k of keys) {
    const live = await d.or.getKey(k.hash);
    d.store.setUsage(k.hash, live.usage);
    k.usageTotal = live.usage;
  }
}

export async function syncVault(d: KeeperDeps, vault: string): Promise<KeyLimit[]> {
  if (d.store.pendingSettlement(vault)) {
    // keys stay pinned at the usage frozen for the settlement until its receipt is seen
    d.log(`sync ${vault} skipped: settlement pending`);
    return [];
  }
  const frozen = await d.chain.lossPending(vault);
  const yieldUsd = Number(await d.chain.yieldOf(vault)) / 1e6;
  d.store.setVaultState(vault, { frozen, yieldUsd });
  if (frozen) d.log(`loss pending on ${vault}: keys frozen at current usage`);
  const keys = d.store.keysForVault(vault);
  await refreshUsage(d, keys);
  const limits = computeLimits(yieldUsd, keys, d.params, frozen);
  for (const l of limits) await d.or.setLimit(l.hash, l.limit);
  return limits;
}

export async function syncAll(d: KeeperDeps): Promise<void> {
  for (const v of d.store.listVaults()) {
    if (settlingVaults.has(v.vault.toLowerCase())) {
      d.log(`sync ${v.vault} skipped: settling`);
      continue;
    }
    try {
      await syncVault(d, v.vault);
    } catch (e) {
      d.log(`sync ${v.vault} failed: ${(e as Error).message}`);
    }
  }
}

export async function reportAll(d: KeeperDeps, now: number = Date.now()): Promise<void> {
  for (const v of d.store.listVaults()) {
    try {
      await d.chain.report(v.vault);
    } catch (e) {
      d.log(`report ${v.vault} failed: ${(e as Error).message}`);
    }
  }
  d.store.setMeta("lastReport", String(now));
}

/**
 * Applies a mined settlement's bookkeeping (settlement row, baselines, new period, pending row cleared) in one
 * store transaction, marks the month it was sent in as settled, then re-syncs. Applies at most once per tx.
 */
async function applySettlement(d: KeeperDeps, p: PendingSettlement): Promise<void> {
  if (!d.store.completePendingSettlement(p.vault, p.tx)) return;
  d.store.setMeta(settledMonthKey(p.vault), monthOf(p.createdAt));
  d.log(`settled ${p.vault}: ${p.usageMicro} micro-USD in ${p.tx}`);
  try {
    await syncVault(d, p.vault);
  } catch (e) {
    d.log(`sync ${p.vault} after settlement failed: ${(e as Error).message}`);
  }
}

/** Resolves one pending settlement from its receipt. Returns the status it saw. */
async function reconcileOne(d: KeeperDeps, p: PendingSettlement): Promise<TxStatus> {
  let status: TxStatus;
  try {
    status = await d.chain.settleStatus(p.tx);
  } catch (e) {
    d.log(`settlement ${p.tx} for ${p.vault} status unknown: ${(e as Error).message}`);
    return "pending";
  }
  if (status === "success") await applySettlement(d, p);
  else if (status === "reverted") {
    d.store.clearPendingSettlement(p.vault);
    d.log(`settlement ${p.tx} for ${p.vault} reverted: nothing moved`);
  }
  return status;
}

/** Settles the bookkeeping of every settlement sent earlier whose receipt was not seen at the time. */
export async function reconcilePending(d: KeeperDeps): Promise<void> {
  for (const p of d.store.listPendingSettlements()) {
    if (settlingVaults.has(p.vault)) continue; // the settleVault in flight owns this row
    await reconcileOne(d, p);
  }
}

/** Polls the receipt of a just-sent settlement for a bounded time. */
async function waitForStatus(d: KeeperDeps, vault: string, tx: string): Promise<TxStatus> {
  const attempts = d.waitAttempts ?? DEFAULT_WAIT_ATTEMPTS;
  const sleep = d.sleep ?? defaultSleep;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(d.waitMs ?? DEFAULT_WAIT_MS);
    let status: TxStatus;
    try {
      status = await d.chain.settleStatus(tx);
    } catch (e) {
      d.log(`settlement ${tx} for ${vault} status unknown: ${(e as Error).message}`);
      return "pending";
    }
    if (status !== "pending") return status;
  }
  return "pending";
}

/**
 * Freeze, re-read, send the settlement, persist it as pending, then wait for its receipt.
 * The bookkeeping is applied only once the receipt shows success; a settlement still unconfirmed
 * is left pending for reconcilePending and returned with pending: true.
 */
export async function settleVault(d: KeeperDeps, vault: string, now: number = Date.now()): Promise<SettleResult | null> {
  const key = vault.toLowerCase();
  if (!d.store.vault(vault)) {
    d.log(`settle ${vault} skipped: unknown vault`);
    return null;
  }
  if (settlingVaults.has(key)) {
    d.log(`settle ${vault} skipped: already settling`);
    return null;
  }
  settlingVaults.add(key);
  try {
    const earlier = d.store.pendingSettlement(vault);
    if (earlier) {
      const status = await reconcileOne(d, earlier);
      if (status === "pending") {
        d.log(`settle ${vault} skipped: settlement ${earlier.tx} still pending`);
        return { usage: earlier.usageMicro, tx: earlier.tx, pending: true };
      }
      // the earlier settlement is resolved; a successful one is this call's result, not a reason to settle again
      if (status === "success") return { usage: earlier.usageMicro, tx: earlier.tx };
    }
    if (await d.chain.lossPending(vault)) {
      d.log(`settle ${vault} skipped: loss pending`);
      return null;
    }
    const keys = d.store.keysForVault(vault);
    await refreshUsage(d, keys);
    for (const k of keys) await d.or.setLimit(k.hash, k.usageTotal);
    await refreshUsage(d, keys); // catch requests that were in flight during the freeze
    const usage = usageMicro(keys, d.params);
    const baselines = keys.map((k) => ({ hash: k.hash, baseline: k.usageTotal }));
    const tx = await d.chain.sendSettle(vault, usage);
    d.store.setPendingSettlement(vault, { usageMicro: usage, baselines, tx, createdAt: now });
    const status = await waitForStatus(d, vault, tx);
    if (status === "success") {
      await applySettlement(d, { vault: key, usageMicro: usage, baselines, tx, createdAt: now });
      return { usage, tx };
    }
    if (status === "reverted") {
      d.store.clearPendingSettlement(vault);
      d.log(`settlement ${tx} for ${vault} reverted: nothing moved`);
      return null;
    }
    d.log(`settlement ${tx} for ${vault} not confirmed yet: left pending, keys stay frozen`);
    return { usage, tx, pending: true };
  } finally {
    settlingVaults.delete(key);
  }
}

export async function tick(d: KeeperDeps, now: number = Date.now()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await reconcilePending(d);
    await syncAll(d);
    const lastReport = Number(d.store.getMeta("lastReport") ?? 0);
    if (now - lastReport >= DAY_MS) await reportAll(d, now);
    const month = monthOf(now);
    // a vault without a marker starts at the last month the keeper ran (this month on the first tick ever)
    const initial = d.store.getMeta("lastSettleMonth") ?? month;
    for (const v of d.store.listVaults()) {
      const mk = settledMonthKey(v.vault);
      let marker = d.store.getMeta(mk);
      if (marker === undefined) {
        marker = initial;
        d.store.setMeta(mk, marker);
      }
      if (marker === month || d.store.pendingSettlement(v.vault)) continue;
      try {
        const r = await settleVault(d, v.vault, now);
        if (r && !r.pending) d.store.setMeta(mk, month);
      } catch (e) {
        d.log(`settle ${v.vault} failed: ${(e as Error).message}`);
      }
    }
    d.store.setMeta("lastSettleMonth", month);
  } finally {
    ticking = false;
  }
}

export function toolBudgetFor(store: Store, params: Params, keyHash: string): number {
  const key = store.keyByHash(keyHash);
  if (!key) return 0;
  const v = store.vault(key.vault);
  if (!v) return 0;
  const l = computeLimits(v.yieldUsd, store.keysForVault(key.vault), params, v.frozen).find((x) => x.hash === keyHash);
  return l ? toolBudgetUsd(l, params) : 0;
}
