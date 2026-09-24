// Inferest ledger kernel: pure functions, no I/O, no dependencies.
// The yield side and the credit side meet only here, so either rail can be swapped.
// Amounts are USD as plain numbers. Good enough for the demo; move to bigint base units before real money.

export type Params = {
  ourFee: number;  // share of yield Inferest keeps, e.g. 0.10
  railFee: number; // cost of turning USDC into credits on the rail, e.g. 0.05 for OpenRouter crypto top-up
};

export const DEFAULT_PARAMS: Params = { ourFee: 0.10, railFee: 0.05 };

export type Position = {
  principal: number; // USD deposited, never spent
  shares: number;    // ERC-4626 vault shares held for this account
  harvested: number; // yield already redeemed out of the vault, USD
  spent: number;     // credits consumed across all keys, USD of credits
};

export function open(principal: number, pricePerShare: number): Position {
  if (principal <= 0) throw new Error("principal must be positive");
  return { principal, shares: principal / pricePerShare, harvested: 0, spent: 0 };
}

// convertToAssets(shares) - principal. Floors at zero: a vault loss never creates negative yield to spend.
export function accruedUnharvested(p: Position, pricePerShare: number): number {
  return Math.max(0, p.shares * pricePerShare - p.principal);
}

// All yield this account has ever earned, harvested or not.
export function totalYield(p: Position, pricePerShare: number): number {
  return p.harvested + accruedUnharvested(p, pricePerShare);
}

// Credits one dollar of yield buys after our fee and the rail fee.
export function creditsPerYieldDollar(params: Params = DEFAULT_PARAMS): number {
  return (1 - params.ourFee) * (1 - params.railFee);
}

// The spend limit the key manager syncs to. Opens only up to yield already earned,
// never ahead of it, so principal is never needed to cover spend (hackathon rule).
export function creditLimit(p: Position, pricePerShare: number, params: Params = DEFAULT_PARAMS): number {
  return totalYield(p, pricePerShare) * creditsPerYieldDollar(params);
}

export function remaining(p: Position, pricePerShare: number, params: Params = DEFAULT_PARAMS): number {
  return Math.max(0, creditLimit(p, pricePerShare, params) - p.spent);
}

export function spend(p: Position, amount: number, pricePerShare: number, params: Params = DEFAULT_PARAMS): Position {
  if (amount < 0) throw new Error("amount must be non-negative");
  if (amount > remaining(p, pricePerShare, params) + 1e-9) throw new Error("over limit");
  return { ...p, spent: p.spent + amount };
}

// Batch settlement: redeem only the yield, leave principal's shares in the vault.
export function harvest(p: Position, pricePerShare: number): { position: Position; redeemedShares: number; usd: number } {
  const usd = accruedUnharvested(p, pricePerShare);
  const redeemedShares = usd / pricePerShare;
  return { position: { ...p, shares: p.shares - redeemedShares, harvested: p.harvested + usd }, redeemedShares, usd };
}

// Principal a monthly credit budget needs if yield alone has to cover it.
// requiredPrincipal = monthly * 12 / (apy * (1 - ourFee) * (1 - railFee))
export function requiredPrincipal(monthlyCredits: number, apy: number, params: Params = DEFAULT_PARAMS): number {
  return (monthlyCredits * 12) / (apy * creditsPerYieldDollar(params));
}

// Price per share after `years` of compounding at `apy`, for time-warp demos and tests.
export function priceAfter(startPrice: number, apy: number, years: number): number {
  return startPrice * Math.pow(1 + apy, years);
}
