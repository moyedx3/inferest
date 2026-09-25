import type { Params } from "../engine/ledger.ts";

export type KeyInput = { hash: string; weight: number; usageTotal: number; baseline: number; toolSpent: number };
export type KeyLimit = { hash: string; budget: number; spent: number; remaining: number; limit: number };

const floor4 = (x: number) => Math.floor(x * 1e4) / 1e4;

/**
 * Per-key budgets for this period. Credit = yield in the Splitter × (1 − railFee), split by weight.
 * A key's budget is fixed by its weight: what one key leaves unused does not flow to the others.
 * The sum of open credit is capped at the pool: if reweighting after spend would open more than
 * credit minus total spend, every key's remaining budget is scaled down proportionally.
 * `limit` is what OpenRouter needs: its limits are cumulative, so it is usageTotal + remaining.
 */
export function computeLimits(yieldUsd: number, keys: KeyInput[], params: Params, frozen: boolean): KeyLimit[] {
  const credit = frozen ? 0 : Math.max(0, yieldUsd) * (1 - params.railFee);
  const weightSum = keys.reduce((s, k) => s + Math.max(0, k.weight), 0);
  const rows = keys.map((k) => {
    const budget = weightSum > 0 ? (credit * Math.max(0, k.weight)) / weightSum : 0;
    const spent = Math.max(0, k.usageTotal - k.baseline) + k.toolSpent * (1 - params.railFee);
    return { k, budget, spent, remaining: Math.max(0, budget - spent) };
  });
  const poolLeft = Math.max(0, credit - rows.reduce((s, r) => s + r.spent, 0));
  const sumRemaining = rows.reduce((s, r) => s + r.remaining, 0);
  const scale = sumRemaining > 0 && sumRemaining > poolLeft + 1e-9 ? poolLeft / sumRemaining : 1;
  return rows.map(({ k, budget, spent, remaining: raw }) => {
    const remaining = raw * scale;
    return { hash: k.hash, budget, spent, remaining, limit: floor4(k.usageTotal + remaining) };
  });
}

/** USDC a key may still spend on tools (tools are paid in USDC, so no rail fee). */
export function toolBudgetUsd(l: KeyLimit, params: Params): number {
  return l.remaining / (1 - params.railFee);
}

/** What the period cost, in USDC base units, for Splitter.settle. */
export function usageMicro(keys: KeyInput[], params: Params): bigint {
  const usd = keys.reduce(
    (s, k) => s + Math.max(0, k.usageTotal - k.baseline) / (1 - params.railFee) + k.toolSpent,
    0,
  );
  return BigInt(Math.round(usd * 1e6));
}
