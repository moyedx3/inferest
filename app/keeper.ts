import type { Params } from "../engine/ledger.ts";
import type { Chain, TxStatus } from "./chain.ts";
import type { OpenRouter } from "./openrouter.ts";
import { settledMonthKey, type Store, type KeyRow, type PendingSettlement } from "./store.ts";
import { computeLimits, toolBudgetUsd, usageMicro, type KeyLimit } from "./limits.ts";

export type KeeperDeps = {
  chain: Chain; store: Store; or: OpenRouter; params: Params; log: (msg: string) => void;
  /** Delay between receipt polls after sending a settlement (default 2 s). */
  waitMs?: number;
  /** Receipt polls before leaving a settlement pending for reconciliation (default 60, about 2 minutes). */
  waitAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Age after which reconciliation checks whether an unmined settlement is known to the node (default 30 min). */
  maxPendingMs?: number;
  /** How long a vault waits before retrying a settlement that failed to prepare (default 10 min). */
  retryDelayMs?: number;
};

export type SettleResult = { usage: bigint; tx: string; pending?: true };

const DAY_MS = 86_400_000;
const DEFAULT_WAIT_MS = 2_000;
const DEFAULT_WAIT_ATTEMPTS = 60;
const DEFAULT_MAX_PENDING_MS = 30 * 60_000;
const DEFAULT_RETRY_DELAY_MS = 10 * 60_000;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** UTC calendar month, e.g. "2026-11". */
export const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
export { settledMonthKey };
/** The meta key holding the time before which a vault's failed settlement is not retried. */
export const retryAfterKey = (vault: string): string => `settleRetryAfter:${vault.toLowerCase()}`;

/** Marks a newly registered vault as settled for this month, so its first settlement is next month. */
export function markRegistered(store: Store, vault: string, now: number = Date.now()): void {
  if (store.getMeta(settledMonthKey(vault)) === undefined) store.setMeta(settledMonthKey(vault), monthOf(now));
}

let ticking = false;
const settlingVaults = new Set<string>();

/** Whether this process is settling or reconciling the vault right now. */
export const isSettling = (vault: string): boolean => settlingVaults.has(vault.toLowerCase());

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

/** Octant's minimum liquidity seed; a vault at or below this holds only dust and fails report()'s health check. */
const MIN_REPORTABLE_ASSETS = 1_000n;

export async function reportAll(d: KeeperDeps, now: number = Date.now()): Promise<void> {
  for (const v of d.store.listVaults()) {
    try {
      const assets = await d.chain.totalAssets(v.vault);
      if (assets <= MIN_REPORTABLE_ASSETS) {
        d.log(`report ${v.vault} skipped: vault is empty`);
        continue;
      }
      await d.chain.report(v.vault);
    } catch (e) {
      d.log(`report ${v.vault} failed: ${(e as Error).message}`);
    }
  }
  d.store.setMeta("lastReport", String(now));
}

async function resync(d: KeeperDeps, vault: string, why: string): Promise<void> {
  try {
    await syncVault(d, vault);
  } catch (e) {
    d.log(`sync ${vault} after ${why} failed: ${(e as Error).message}`);
  }
}

/**
 * Applies a mined settlement's bookkeeping (settlement row, baselines, new period, pending row cleared,
 * month marker) in one store transaction, then re-syncs. Returns false, applying nothing, if the pending
 * row for this tx is gone (applied or cleared by someone else).
 */
async function applySettlement(d: KeeperDeps, p: PendingSettlement): Promise<boolean> {
  if (!d.store.completePendingSettlement(p.vault, p.tx, monthOf(p.createdAt))) {
    d.log(`settlement ${p.tx} for ${p.vault} mined but its pending row is gone: bookkeeping not applied here`);
    return false;
  }
  d.log(`settled ${p.vault}: ${p.usageMicro} micro-USD in ${p.tx}`);
  await resync(d, p.vault, "settlement");
  return true;
}

/** Clears a reverted settlement's row (only if it is still this tx) and reopens the keys. */
async function clearReverted(d: KeeperDeps, p: { vault: string; tx: string }): Promise<void> {
  d.store.clearPendingSettlement(p.vault, p.tx);
  d.log(`settlement ${p.tx} for ${p.vault} reverted: nothing moved`);
  await resync(d, p.vault, "revert");
}

type Reconciled = "applied" | "cleared" | "pending";

/** Resolves one pending settlement from its receipt. The caller holds the vault in settlingVaults. */
async function reconcileOne(d: KeeperDeps, p: PendingSettlement, now: number): Promise<Reconciled> {
  let status: TxStatus;
  try {
    status = await d.chain.settleStatus(p.tx);
  } catch (e) {
    d.log(`settlement ${p.tx} for ${p.vault} status unknown: ${(e as Error).message}`);
    return "pending";
  }
  if (status === "success") return (await applySettlement(d, p)) ? "applied" : "pending";
  if (status === "reverted") {
    await clearReverted(d, p);
    return "cleared";
  }
  const age = now - p.createdAt;
  if (age < (d.maxPendingMs ?? DEFAULT_MAX_PENDING_MS)) return "pending";
  let known: boolean;
  try {
    known = await d.chain.transactionKnown(p.tx);
  } catch (e) {
    d.log(`settlement ${p.tx} for ${p.vault} lookup failed: ${(e as Error).message}`);
    return "pending";
  }
  const minutes = Math.round(age / 60_000);
  if (known) {
    d.log(`settlement ${p.tx} for ${p.vault} still unmined after ${minutes} min: keys stay frozen`);
    return "pending";
  }
  // never accepted by the node: nothing can mine, so the month rule may settle the vault again
  d.store.clearPendingSettlement(p.vault, p.tx);
  d.log(`settlement ${p.tx} for ${p.vault} unknown to the node after ${minutes} min: pending row cleared`);
  await resync(d, p.vault, "dropped settlement");
  return "cleared";
}

/** Settles the bookkeeping of every settlement sent earlier whose receipt was not seen at the time. */
export async function reconcilePending(d: KeeperDeps, now: number = Date.now()): Promise<void> {
  for (const p of d.store.listPendingSettlements()) {
    if (settlingVaults.has(p.vault)) continue; // whoever holds the vault owns its row
    settlingVaults.add(p.vault);
    try {
      await reconcileOne(d, p, now);
    } finally {
      settlingVaults.delete(p.vault);
    }
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
 * Freeze, re-read, sign the settlement, persist it as pending, broadcast, then wait for its receipt.
 * The bookkeeping is applied only once the receipt shows success; a settlement not yet confirmed (or whose
 * broadcast failed ambiguously) is left pending for reconcilePending and returned with pending: true.
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
      const r = await reconcileOne(d, earlier, now);
      if (r === "pending") {
        d.log(`settle ${vault} skipped: settlement ${earlier.tx} still pending`);
        return { usage: earlier.usageMicro, tx: earlier.tx, pending: true };
      }
      // an applied earlier settlement is this call's result, not a reason to settle again
      if (r === "applied") return { usage: earlier.usageMicro, tx: earlier.tx };
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
    let prepared;
    try {
      prepared = await d.chain.prepareSettle(vault, usage);
    } catch (e) {
      // nothing was signed or sent: back off, and reopen the keys meanwhile
      d.store.setMeta(retryAfterKey(vault), String(now + (d.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)));
      d.log(`settle ${vault} failed to prepare: ${(e as Error).message}`);
      await resync(d, vault, "failed settlement");
      throw e;
    }
    const tx = prepared.hash;
    const pending: PendingSettlement = { vault: key, usageMicro: usage, baselines, tx, createdAt: now };
    if (!d.store.setPendingSettlement(vault, pending)) {
      // another settlement (e.g. from the CLI in another process) persisted first: never broadcast a second one.
      // The signed transaction is discarded unsent, so its nonce was never consumed.
      const other = d.store.pendingSettlement(vault);
      d.log(`settle ${vault} not broadcast: settlement ${other?.tx ?? "(unknown)"} is already pending for this vault`);
      return other ? { usage: other.usageMicro, tx: other.tx, pending: true } : { usage, tx, pending: true };
    }
    try {
      await prepared.send();
    } catch (e) {
      // the broadcast may or may not have reached the node: keep the row and let reconciliation decide
      d.log(`settlement ${tx} for ${vault} broadcast failed, left pending: ${(e as Error).message}`);
      return { usage, tx, pending: true };
    }
    const status = await waitForStatus(d, vault, tx);
    if (status === "success") {
      return (await applySettlement(d, pending)) ? { usage, tx } : { usage, tx, pending: true };
    }
    if (status === "reverted") {
      await clearReverted(d, pending);
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
    await reconcilePending(d, now);
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
      if (now < Number(d.store.getMeta(retryAfterKey(v.vault)) ?? 0)) continue;
      try {
        await settleVault(d, v.vault, now); // a success writes the marker with its bookkeeping
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
