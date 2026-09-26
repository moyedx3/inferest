import type { Params } from "../engine/ledger.ts";
import type { Chain, TxStatus } from "./chain.ts";
import type { OpenRouter } from "./openrouter.ts";
import { settledMonthKey, type Store, type PendingSettlement, type SpendSnapshot, type KeyRow } from "./store.ts";
import { computeLimits, companyLimit, toolBudgetUsd, usageMicro, DEFAULT_STALE_BUDGET_MS, type KeyLimit } from "./limits.ts";

export type KeeperDeps = {
  chain: Chain; store: Store; or: OpenRouter; params: Params; log: (msg: string) => void;
  /** Decrypts a vault's OpenRouter key secret (secretBox(KEY_ENCRYPTION_KEY).decrypt in production). */
  decrypt: (encrypted: string) => string;
  /** Waits for the vault's in-flight proxy requests to finish metering, up to ms. The server sets it from the proxy. */
  drain?: (vault: string, ms: number) => Promise<void>;
  /** How long settlement waits for in-flight metering (default 10 s). */
  drainMs?: number;
  /** Delay between receipt polls after sending a settlement (default 2 s). */
  waitMs?: number;
  /** Receipt polls before leaving a settlement pending for reconciliation (default 60, about 2 minutes). */
  waitAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Age after which reconciliation checks whether an unmined settlement is known to the node (default 30 min). */
  maxPendingMs?: number;
  /** How long a vault waits before retrying a settlement that failed to prepare (default 10 min). */
  retryDelayMs?: number;
  /** Age of a settling flag with no pending row, held by no process here, before a sync treats it as a crash
   *  leftover rather than another process still between its freeze and its pending row (default 15 min). */
  staleSettlingMs?: number;
};

export type SettleResult = { usage: bigint; tx: string; pending?: true };

const DAY_MS = 86_400_000;
const DEFAULT_WAIT_MS = 2_000;
const DEFAULT_WAIT_ATTEMPTS = 60;
const DEFAULT_MAX_PENDING_MS = 30 * 60_000;
const DEFAULT_RETRY_DELAY_MS = 10 * 60_000;
const DEFAULT_DRAIN_MS = 10_000;
const DEFAULT_STALE_SETTLING_MS = 15 * 60_000;
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const noDrain = async (): Promise<void> => {};

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

/**
 * Pins the company OpenRouter key's cumulative limit at its usage plus the credit open here: the backstop.
 * With no open credit (a freeze, or the settlement snapshot) the limit is the usage itself.
 */
async function syncCompanyKey(d: KeeperDeps, vault: string, limits: KeyLimit[]): Promise<void> {
  const orKey = d.store.openRouterKeyFor(vault);
  if (!orKey) {
    d.log(`sync ${vault}: no OpenRouter key on file, nothing to pin`);
    return;
  }
  const live = await d.or.getKey(orKey.hash);
  const candidate = companyLimit(live.usage, limits);
  const pending = d.store.pendingModelCalls(vault);
  const stored = d.store.vault(vault)?.orLimit ?? 0;
  // A pending call is in OpenRouter's usage but not in our spend, so raising the limit by the open credit would
  // double its headroom. Hold the limit where it is until the keeper has resolved the call's cost, but never
  // below the live usage: an in-flight request may have overshot the stored limit, and the hold then pins at usage.
  const limit = pending > 0 && stored > 0 ? Math.max(live.usage, Math.min(candidate, stored)) : candidate;
  if (limit !== candidate) d.log(`sync ${vault}: ${pending} pending model call(s), backstop held at ${limit}`);
  await d.or.setLimit(orKey.hash, limit);
  d.store.setVaultState(vault, { orLimit: limit, orUsage: live.usage });
}

export async function syncVault(d: KeeperDeps, vault: string, now: number = Date.now()): Promise<KeyLimit[]> {
  if (d.store.pendingSettlement(vault)) {
    // the vault stays closed until the settlement's receipt is seen
    d.log(`sync ${vault} skipped: settlement pending`);
    return [];
  }
  const v = d.store.vault(vault);
  if (v?.settling && !settlingVaults.has(vault.toLowerCase())) {
    if (now - v.settlingSince < (d.staleSettlingMs ?? DEFAULT_STALE_SETTLING_MS)) {
      // another process (e.g. the CLI) may still be between its freeze and its pending row: leave it alone
      d.log(`sync ${vault} skipped: settling`);
      return [];
    }
    // held longer than staleSettlingMs with no pending row and no settlement in this process: a crash leftover
    d.store.setSettling(vault, false);
    d.log(`sync ${vault}: stale settling flag cleared`);
  }
  const frozen = await d.chain.lossPending(vault);
  const yieldUsd = Number(await d.chain.yieldOf(vault)) / 1e6;
  d.store.setVaultState(vault, { frozen, yieldUsd });
  if (frozen) d.log(`loss pending on ${vault}: keys frozen at current usage`);
  const limits = computeLimits(yieldUsd, d.store.keysForVault(vault), d.params, frozen);
  await syncCompanyKey(d, vault, limits);
  d.store.setSyncedAt(vault, now);
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

/**
 * Compares each company key's cumulative usage on OpenRouter with the model cost recorded here since the vault
 * was registered, and the recorded cost with what settlements have billed plus this period's spend. Logs both
 * and corrects nothing: the first is the alarm for lost metering, the second for recorded cost no settlement billed.
 */
export async function checkDrift(d: KeeperDeps): Promise<void> {
  for (const v of d.store.listVaults()) {
    const orKey = d.store.openRouterKeyFor(v.vault);
    if (!orKey) continue;
    try {
      const live = await d.or.getKey(orKey.hash);
      const recorded = d.store.totalModelCost(v.vault);
      const drift = Math.round((live.usage - recorded) * 1e6) / 1e6;
      d.log(`drift ${v.vault}: openrouter usage ${live.usage} recorded ${recorded} drift ${drift}`);
      // settlement usage is sum(modelCost) / (1 - railFee) + sum(toolSpend), so this inverts it to model cost
      const billedModel = round6(Math.max(0,
        (d.store.settledUsageUsd(v.vault) - d.store.toolSpendBeforePeriod(v.vault, v.period)) * (1 - d.params.railFee)));
      const current = d.store.spendForVault(v.vault).modelUsd;
      const unbilled = round6(recorded - billedModel - current);
      d.log(`billing ${v.vault}: recorded ${recorded} billed ${billedModel} current period ${current} unbilled ${unbilled}`);
    } catch (e) {
      d.log(`drift ${v.vault} check failed: ${(e as Error).message}`);
    }
  }
}

/** Fills in the cost of calls whose usage never reached the proxy, through OpenRouter's generation lookup. */
export async function resolvePendingModelCalls(d: KeeperDeps, now: number = Date.now()): Promise<void> {
  const apiKeys = new Map<string, string | undefined>();
  for (const row of d.store.listPendingModelCalls()) {
    // a vault closed for settlement is skipped: resolving into its current period here would bill a cost the
    // settlement's snapshot never saw, and completePendingSettlement is about to bump the period out from under it
    if (d.store.vault(row.vault)?.settling || d.store.pendingSettlement(row.vault) || settlingVaults.has(row.vault.toLowerCase())) continue;
    if (!apiKeys.has(row.vault)) {
      const orKey = d.store.openRouterKeyFor(row.vault);
      if (!orKey) {
        apiKeys.set(row.vault, undefined);
      } else {
        try {
          apiKeys.set(row.vault, d.decrypt(orKey.encryptedSecret));
        } catch (e) {
          apiKeys.set(row.vault, undefined);
          d.log(`model call ${row.generationId} for ${row.vault}: cannot decrypt the OpenRouter key: ${(e as Error).message}`);
          continue;
        }
      }
    }
    const apiKey = apiKeys.get(row.vault);
    if (!apiKey) {
      d.log(`model call ${row.generationId} for ${row.vault}: no OpenRouter key on file`);
      continue;
    }
    try {
      const g = await d.or.getGeneration(row.generationId, apiKey);
      if (g) {
        if (d.store.resolveModelCall(row.generationId, g.totalCost)) {
          d.log(`model call ${row.generationId} on key ${row.keyId} resolved: $${g.totalCost}`);
        }
        continue;
      }
    } catch (e) {
      d.log(`model call ${row.generationId} lookup failed: ${(e as Error).message}`);
    }
    const age = now - row.at;
    const days = Math.floor(age / DAY_MS);
    // logged once per day of age, not every tick; the meta key is left behind when the row resolves
    const alarmKey = `pendingAlarm:${row.generationId}`;
    const logged = d.store.getMeta(alarmKey);
    if (days >= 1 && (logged === undefined || days > Number(logged))) {
      d.log(`model call ${row.generationId} on key ${row.keyId} unresolved for ${Math.round(age / 3_600_000)} h: operator attention needed`);
      d.store.setMeta(alarmKey, String(days));
    }
  }
}

async function resync(d: KeeperDeps, vault: string, why: string): Promise<void> {
  try {
    await syncVault(d, vault);
  } catch (e) {
    d.log(`sync ${vault} after ${why} failed: ${(e as Error).message}`);
  }
}

/**
 * Applies a mined settlement's bookkeeping (settlement row, new period, pending row and settling flag cleared,
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

/** Clears a reverted settlement's row (only if it is still this tx) and reopens the vault. */
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
    d.log(`settlement ${p.tx} for ${p.vault} still unmined after ${minutes} min: vault stays closed`);
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

/** How many times the spend read is repeated when rows land during it (another process metering). */
export const SNAPSHOT_ATTEMPTS = 5;

/** This period's spend together with the row-id markers a settlement snapshot needs. */
export type SpendRead = { keys: KeyRow[]; ids: { model: number; tool: number } };

/**
 * Reads this period's spend and the row-id markers so that the two agree even when another process is
 * inserting rows meanwhile: the markers are read before and after the spend read, and the read is repeated
 * until they are stable. Row ids only grow and rows are never deleted, so equal markers mean the spend
 * read saw exactly the rows at or below them. If rows keep landing, it throws and the settlement is
 * retried, so no row is ever billed twice or left behind.
 */
export function readSpendSnapshot(store: Store, vault: string): SpendRead {
  let before = store.lastCallIds();
  let keys = store.keysForVault(vault);
  for (let i = 1; i < SNAPSHOT_ATTEMPTS; i++) {
    const after = store.lastCallIds();
    if (after.model === before.model && after.tool === before.tool) return { keys, ids: after };
    before = after;
    keys = store.keysForVault(vault);
  }
  const ids = store.lastCallIds();
  if (ids.model === before.model && ids.tool === before.tool) return { keys, ids }; // a fifth read that stabilized is not a failure
  throw new Error(`settle ${vault}: spend snapshot did not stabilize after ${SNAPSHOT_ATTEMPTS} reads, rows kept landing`);
}

/**
 * Close the vault (proxy refuses, backstop pinned at usage), drain in-flight metering, read this period's spend,
 * sign the settlement, persist it as pending, broadcast, then wait for its receipt. The bookkeeping is applied
 * only once the receipt shows success; a settlement not yet confirmed (or whose broadcast failed ambiguously)
 * is left pending for reconcilePending and returned with pending: true. The vault reopens when the pending row
 * is completed or cleared.
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
    d.store.setSettling(vault, true, now);
    let usage = 0n;
    let baselines: SpendSnapshot[] = [];
    let ids = { model: 0, tool: 0 };
    let prepared;
    try {
      await syncCompanyKey(d, vault, []); // the backstop closes at current usage
      await (d.drain ?? noDrain)(vault, d.drainMs ?? DEFAULT_DRAIN_MS); // requests already past the budget check finish metering
      // the snapshot and its call-id markers are re-read until they agree, so a call another process meters
      // mid-read is never missing from keys while also sitting at or below the markers; if rows keep landing
      // this throws, caught below, which reopens the vault and backs off instead of signing a stale snapshot
      const snapshot = readSpendSnapshot(d.store, vault);
      const keys = snapshot.keys;
      ids = snapshot.ids;
      usage = usageMicro(keys, d.params);
      baselines = keys.map((k) => ({ keyId: k.id, spentUsd: k.modelSpent + k.toolSpent }));
      prepared = await d.chain.prepareSettle(vault, usage);
    } catch (e) {
      // nothing was signed or sent: reopen the vault now and back off
      d.store.setSettling(vault, false);
      d.store.setMeta(retryAfterKey(vault), String(now + (d.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)));
      d.log(`settle ${vault} failed to prepare: ${(e as Error).message}`);
      await resync(d, vault, "failed settlement");
      throw e;
    }
    const tx = prepared.hash;
    const pending: PendingSettlement = {
      vault: key, usageMicro: usage, baselines, tx, createdAt: now, modelCallId: ids.model, toolCallId: ids.tool,
    };
    if (!d.store.setPendingSettlement(vault, pending)) {
      // another settlement (e.g. from the CLI in another process) persisted first: never broadcast a second one.
      // The signed transaction is discarded unsent, so its nonce was never consumed. The vault stays closed
      // until that other settlement completes or is cleared.
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
    d.log(`settlement ${tx} for ${vault} not confirmed yet: left pending, vault stays closed`);
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
    await resolvePendingModelCalls(d, now);
    await syncAll(d);
    const lastReport = Number(d.store.getMeta("lastReport") ?? 0);
    if (now - lastReport >= DAY_MS) {
      await reportAll(d, now);
      await checkDrift(d);
    }
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
      // a settlement can wait minutes for its receipt while later ticks are skipped: refresh the other vaults
      // now, so their last sync does not go stale behind a queue of settlements (a settling vault is skipped)
      await syncAll(d);
    }
    d.store.setMeta("lastSettleMonth", month);
  } finally {
    ticking = false;
  }
}

/**
 * USDC a key may still spend on tools from the last synced state. Zero for a revoked key, a closed vault, or a
 * vault last synced more than staleBudgetMs ago (never synced counts as stale), as the proxy refuses it too.
 */
export function toolBudgetFor(
  store: Store, params: Params, keyId: string, staleBudgetMs: number = DEFAULT_STALE_BUDGET_MS, now: number = Date.now(),
): number {
  const key = store.keyById(keyId);
  if (!key || key.revoked) return 0;
  const v = store.vault(key.vault);
  if (!v || v.settling || store.pendingSettlement(v.vault)) return 0;
  if (now - store.syncedAt(v.vault) > staleBudgetMs) return 0;
  const l = computeLimits(v.yieldUsd, store.keysForVault(key.vault), params, v.frozen).find((x) => x.id === keyId);
  return l ? toolBudgetUsd(l, params) : 0;
}
