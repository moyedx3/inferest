// Inferest ledger kernel: pure functions, no I/O, no dependencies.
// The yield side and the credit side meet only here, so either rail can be swapped.
// Amounts are USD as plain numbers. Good enough for the demo; move to bigint base units before real money.
//
// Per settlement period:
//   yield     = convertToAssets(shares) - principal
//   usage     = credits spent / (1 - railFee)        USDC it took to buy those credits
//   leftover  = yield - usage                        never negative: the limit stops spend at yield
//   fee       = ourFee * leftover                    we earn only on yield the customer did not use
//   pull      = usage + fee                          the only shares that leave the customer's position
// The rest of the leftover stays in the vault and becomes principal, so it earns from then on.

export type Params = {
  ourFee: number;  // share of LEFTOVER yield Inferest keeps, e.g. 0.10
  railFee: number; // cost of turning USDC into credits on the rail, e.g. 0.05 for OpenRouter crypto top-up
};

// Real product, rail fee passed through to the customer.
export const DEFAULT_PARAMS: Params = { ourFee: 0.10, railFee: 0.05 };

// Hackathon build: we absorb the rail fee, so one USDC of yield buys one dollar of credit.
// The fee becomes our operating cost; see operatorNet.
export const HACKATHON_PARAMS: Params = { ourFee: 0.10, railFee: 0 };

// What buying credit actually costs us on the rail, whatever we charge the customer.
export const RAIL_COST = 0.05; // OpenRouter crypto purchase fee

export type Position = {
  principal: number; // USD basis that is never spent; grows when leftover yield is returned
  shares: number;    // ERC-4626 vault shares, held in the customer's own wallet
  spent: number;     // credits consumed this period across all keys, USD of credits
};

export function open(principal: number, pricePerShare: number): Position {
  if (principal <= 0) throw new Error("principal must be positive");
  return { principal, shares: principal / pricePerShare, spent: 0 };
}

// convertToAssets(shares) - principal. Floors at zero: a vault loss never creates negative yield to spend.
// On-chain, the YDS vault burns unsettled yield first on a loss (docs/06-workflow.md, vault loss).
export function accruedYield(p: Position, pricePerShare: number): number {
  return Math.max(0, p.shares * pricePerShare - p.principal);
}

export function usageCost(p: Position, params: Params = DEFAULT_PARAMS): number {
  return p.spent / (1 - params.railFee);
}

// Credits this period's yield can buy in total. Opens only up to yield already earned, never ahead of it.
export function creditLimit(p: Position, pricePerShare: number, params: Params = DEFAULT_PARAMS): number {
  return accruedYield(p, pricePerShare) * (1 - params.railFee);
}

export function remaining(p: Position, pricePerShare: number, params: Params = DEFAULT_PARAMS): number {
  return Math.max(0, creditLimit(p, pricePerShare, params) - p.spent);
}

export function spend(p: Position, amount: number, pricePerShare: number, params: Params = DEFAULT_PARAMS): Position {
  if (amount < 0) throw new Error("amount must be non-negative");
  if (amount > remaining(p, pricePerShare, params) + 1e-9) throw new Error("over limit");
  return { ...p, spent: p.spent + amount };
}

export type Settlement = {
  position: Position;   // next period starts here: yield 0, spent 0
  yield: number;
  usage: number;        // USDC that goes to the rail
  leftover: number;
  fee: number;          // USDC that goes to Inferest
  returned: number;     // leftover minus fee, left in the vault as new principal
  pull: number;         // usage + fee: total USDC redeemed from the customer's position
  pulledShares: number;
};

export function settle(p: Position, pricePerShare: number, params: Params = DEFAULT_PARAMS): Settlement {
  const y = accruedYield(p, pricePerShare);
  const usage = usageCost(p, params);
  const leftover = Math.max(0, y - usage);
  const fee = params.ourFee * leftover;
  const returned = leftover - fee;
  const pull = usage + fee;
  const pulledShares = pull / pricePerShare;
  return {
    position: { principal: p.principal + returned, shares: p.shares - pulledShares, spent: 0 },
    yield: y, usage, leftover, fee, returned, pull, pulledShares,
  };
}

// Our result for one settlement: the fee we earned minus the part of the rail fee we did not pass through.
// With HACKATHON_PARAMS this is fee − 5% of usage, so it turns negative once usage passes 2/3 of yield.
export function operatorNet(s: Settlement, params: Params = DEFAULT_PARAMS, railCost: number = RAIL_COST): number {
  const absorbed = Math.max(0, railCost - params.railFee);
  return s.fee - s.usage * (1 - params.railFee) * absorbed;
}

// Principal a monthly credit budget needs if yield alone has to cover all of it.
// Our fee drops out: a customer who uses all its yield leaves no leftover to take a fee from.
// requiredPrincipal = monthly * 12 / (apy * (1 - railFee))
export function requiredPrincipal(monthlyCredits: number, apy: number, params: Params = DEFAULT_PARAMS): number {
  return (monthlyCredits * 12) / (apy * (1 - params.railFee));
}

// Price per share after `years` of compounding at `apy`, for time-warp demos and tests.
export function priceAfter(startPrice: number, apy: number, years: number): number {
  return startPrice * Math.pow(1 + apy, years);
}
