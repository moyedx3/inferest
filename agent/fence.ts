export type Trade = { side: "buy" | "sell"; asset: "ETH" | "BTC" | "ARB"; sizeUsdc: number; price: number; reasoning: string };
export type Decision = {
  note: string;
  split: { action: "deposit" | "withdraw" | "hold"; amountUsdc: number };
  source: { action: "stay" | "move"; target: string | null };
  trades: Trade[];
};
export type FenceContext = {
  walletUsdc: number; vaultValue: number; floorUsdc: number; currentTarget: string; targets: string[];
  tradeCapBps: number; positions: { asset: string; sizeUsdc: number }[];
  /** allowlisted targets without a known rate yet; a move there is refused */
  unrated: string[];
};
export const ASSETS = new Set(["ETH", "BTC", "ARB"]);
export const MAX_TRADES = 3;

/** Rules the model cannot change. Returns what may be executed and what was dropped, with a reason each. */
export function applyFence(d: Decision, c: FenceContext): { accepted: Decision; refused: { what: string; reason: string }[] } {
  const refused: { what: string; reason: string }[] = [];
  const lc = (s: string | null) => (s ?? "").toLowerCase();
  let split = d.split;
  if (split.action === "deposit" && !(split.amountUsdc > 0 && split.amountUsdc <= c.walletUsdc)) { refused.push({ what: "split", reason: `deposit of ${split.amountUsdc} exceeds the wallet's ${c.walletUsdc} USDC` }); split = { action: "hold", amountUsdc: 0 }; }
  else if (split.action === "withdraw" && !(split.amountUsdc > 0 && c.vaultValue - split.amountUsdc >= c.floorUsdc)) { refused.push({ what: "split", reason: `withdrawing ${split.amountUsdc} would leave the vault under the ${c.floorUsdc} USDC floor: no room to think` }); split = { action: "hold", amountUsdc: 0 }; }
  let source = d.source;
  if (source.action === "move") {
    if (c.unrated.map(lc).includes(lc(source.target))) { refused.push({ what: "source", reason: "rate unknown yet" }); source = { action: "stay", target: null }; }
    else if (!c.targets.map(lc).includes(lc(source.target))) { refused.push({ what: "source", reason: `${source.target} is not in the allowlist` }); source = { action: "stay", target: null }; }
    else if (lc(source.target) === lc(c.currentTarget)) { refused.push({ what: "source", reason: "already in that source" }); source = { action: "stay", target: null }; }
  }
  const trades: Trade[] = [];
  const cap = (c.walletUsdc * c.tradeCapBps) / 10_000;
  d.trades.forEach((t, i) => {
    const what = `trade ${i + 1}`;
    if (trades.length >= MAX_TRADES) return refused.push({ what, reason: `at most ${MAX_TRADES} trades per run` });
    if (!ASSETS.has(t.asset)) return refused.push({ what, reason: `asset ${t.asset} is not allowed` });
    if (!(t.price > 0)) return refused.push({ what, reason: "price must be above zero" });
    if (t.side === "buy" && !(t.sizeUsdc > 0 && t.sizeUsdc <= cap)) return refused.push({ what, reason: `a buy is at most ${c.tradeCapBps / 100}% of the working half (${cap.toFixed(2)} USDC)` });
    const held = c.positions.filter((p) => p.asset === t.asset).reduce((s, p) => s + p.sizeUsdc, 0);
    if (t.side === "sell" && !(t.sizeUsdc > 0 && t.sizeUsdc <= held)) return refused.push({ what, reason: `a sell is at most the open ${t.asset} position (${held} USDC)` });
    trades.push(t);
  });
  return { accepted: { note: d.note, split, source, trades }, refused };
}
