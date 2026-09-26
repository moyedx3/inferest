import type { Params } from "../engine/ledger.ts";

/** One key's inputs to the budget math: its weight and what it has spent this period (a store KeyRow fits). */
export type KeyInput = { id: string; weight: number; revoked: boolean; modelSpent: number; toolSpent: number };
export type KeyLimit = { id: string; budget: number; spent: number; remaining: number };

/** Ten keeper sync intervals: past this the vault's yield and backstop are too old to open credit against.
 *  Shared by the proxy and the paid-tool budget. */
export const DEFAULT_STALE_BUDGET_MS = 10 * 60_000;

const floor4 = (x: number) => Math.floor(x * 1e4) / 1e4;

/**
 * Per-key budgets for this period. Credit = yield in the Splitter × (1 − railFee), split by weight; a revoked
 * key weighs nothing. Spent = recorded model cost + tool spend × (1 − railFee), in credit units.
 * A key's budget is fixed by its weight: what one key leaves unused does not flow to the others.
 * The sum of open credit is capped at the pool: if reweighting after spend would open more than
 * credit minus total spend, every key's remaining budget is scaled down proportionally.
 */
export function computeLimits(yieldUsd: number, keys: KeyInput[], params: Params, frozen: boolean): KeyLimit[] {
  const credit = frozen ? 0 : Math.max(0, yieldUsd) * (1 - params.railFee);
  const weightOf = (k: KeyInput) => (k.revoked ? 0 : Math.max(0, k.weight));
  const weightSum = keys.reduce((s, k) => s + weightOf(k), 0);
  const rows = keys.map((k) => {
    const budget = weightSum > 0 ? (credit * weightOf(k)) / weightSum : 0;
    const spent = Math.max(0, k.modelSpent) + k.toolSpent * (1 - params.railFee);
    return { k, budget, spent, remaining: Math.max(0, budget - spent) };
  });
  const poolLeft = Math.max(0, credit - rows.reduce((s, r) => s + r.spent, 0));
  const sumRemaining = rows.reduce((s, r) => s + r.remaining, 0);
  const scale = sumRemaining > 0 && sumRemaining > poolLeft + 1e-9 ? poolLeft / sumRemaining : 1;
  return rows.map(({ k, budget, spent, remaining }) => ({ id: k.id, budget, spent, remaining: remaining * scale }));
}

/**
 * The company key's cumulative limit on OpenRouter: what it has used plus everything still open here. A
 * non-finite open credit counts as none, since NaN would reach OpenRouter as null, which means no limit at all.
 */
export function companyLimit(orUsage: number, limits: KeyLimit[]): number {
  const open = limits.reduce((s, l) => s + l.remaining, 0);
  return floor4(orUsage + (Number.isFinite(open) ? open : 0));
}

/** USDC a key may still spend on tools (tools are paid in USDC, so no rail fee). */
export function toolBudgetUsd(l: KeyLimit, params: Params): number {
  return l.remaining / (1 - params.railFee);
}

/** What the period cost, in USDC base units, for Splitter.settle. */
export function usageMicro(keys: KeyInput[], params: Params): bigint {
  const usd = keys.reduce((s, k) => s + Math.max(0, k.modelSpent) / (1 - params.railFee) + k.toolSpent, 0);
  return BigInt(Math.round(usd * 1e6));
}
