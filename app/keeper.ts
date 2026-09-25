import type { Params } from "../engine/ledger.ts";
import type { Chain } from "./chain.ts";
import type { OpenRouter } from "./openrouter.ts";
import type { Store, KeyRow } from "./store.ts";
import { computeLimits, toolBudgetUsd, usageMicro, type KeyLimit } from "./limits.ts";

export type KeeperDeps = { chain: Chain; store: Store; or: OpenRouter; params: Params; log: (msg: string) => void };

const DAY_MS = 86_400_000;

async function refreshUsage(d: KeeperDeps, keys: KeyRow[]): Promise<void> {
  for (const k of keys) {
    const live = await d.or.getKey(k.hash);
    d.store.setUsage(k.hash, live.usage);
    k.usageTotal = live.usage;
  }
}

export async function syncVault(d: KeeperDeps, vault: string): Promise<KeyLimit[]> {
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

/** Freeze, re-read, settle, open a new period, re-sync. */
export async function settleVault(d: KeeperDeps, vault: string): Promise<{ usage: bigint; tx: string } | null> {
  if (await d.chain.lossPending(vault)) {
    d.log(`settle ${vault} skipped: loss pending`);
    return null;
  }
  const keys = d.store.keysForVault(vault);
  await refreshUsage(d, keys);
  for (const k of keys) await d.or.setLimit(k.hash, k.usageTotal);
  await refreshUsage(d, keys); // catch requests that were in flight during the freeze
  const usage = usageMicro(keys, d.params);
  const tx = await d.chain.settle(vault, usage);
  d.store.recordSettlement(vault, usage, tx);
  d.store.startNewPeriod(vault);
  await syncVault(d, vault);
  return { usage, tx };
}

export async function tick(d: KeeperDeps, now: number = Date.now()): Promise<void> {
  await syncAll(d);
  const lastReport = Number(d.store.getMeta("lastReport") ?? 0);
  if (now - lastReport >= DAY_MS) await reportAll(d, now);
  const month = new Date(now).toISOString().slice(0, 7);
  const lastMonth = d.store.getMeta("lastSettleMonth");
  if (lastMonth !== month) {
    if (lastMonth !== undefined) {
      for (const v of d.store.listVaults()) {
        try {
          await settleVault(d, v.vault);
        } catch (e) {
          d.log(`settle ${v.vault} failed: ${(e as Error).message}`);
        }
      }
    }
    d.store.setMeta("lastSettleMonth", month);
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
