# Unit Economics

_Every number here comes from [`../engine/ledger.ts`](../engine/ledger.ts) and is checked in [`../engine/ledger.test.ts`](../engine/ledger.test.ts)._

**To cover AI spend with yield alone, principal has to be about 23 times the annual budget** (281 times the monthly budget). Realistic for a treasury, not enough for a small agent wallet.

> The source note said "26x the monthly budget (2.2x the annual)." That was upside down: $62K for a $200/month developer is 311x monthly, 26x annual. The multiple is now 23x annual because of the fee change below.

---

## Assumptions

| | Value | Source |
|---|---|---|
| USDC vault APY | 4.5% | Top USDC vaults sit at 4 to 5% ([Eco](https://eco.com/support/en/articles/15182156-usdc-yield-in-2026-where-to-earn-interest-on-usdc)) |
| Rail fee | 5% | OpenRouter crypto top-up ([RouterPlex](https://routerplex.com/blog/openrouter-top-up-fees)) |
| Our fee | **10% of leftover yield** | decided 2026-09-24; rate is a placeholder |

## How money splits each period

```
usage    = credits spent / (1 − railFee)
leftover = yield − usage
fee      = 10% × leftover      → Inferest
returned = 90% × leftover      → back to the customer's wallet as vault shares, now principal
```

**Example** (the demo): $100,000 for six months at 4.5% APY earns $2,225. The keys can spend up to $2,114 of credit.

| Keys spend | Usage (to rail) | Leftover | Fee (to us) | Returned to customer |
|---|---|---|---|---|
| nothing | $0 | $2,225 | $223 | $2,003 |
| $500 | $526 | $1,699 | $170 | $1,529 |
| all $2,114 | $2,225 | $0 | $0 | $0 |

## Required principal

A customer that uses all its yield leaves no leftover, so our fee does not enter:

```
required principal = monthly budget × 12 / (APY × (1 − rail fee))
                   = monthly budget × 12 / 0.04275
```

| Scenario | Monthly credit (USD) | Required principal (USD) |
|---|---|---|
| Light agent, cheap models | 10 | ~2,800 |
| Always-on agent | 50 | ~14,000 |
| One developer, normal use | 200 | ~56,100 |
| One developer, heavy use | 500 | ~140,000 |
| 20 developers × $500 | 10,000 | ~2,810,000 |

---

## ICP1: the numbers work

An organization with a treasury in the tens of millions covers its whole engineering team's AI spend with interest by depositing a fraction of it.

## ICP2: change the positioning

A $1,000 wallet earns about $3.50 of credit a month. That is "base running cost subsidy," not free inference. Bundle it with cheap-model routing (OpenRouter's auto router or free models). **No principal-drawing option**: spend stops at yield.

## Our revenue

**The fee only exists when the customer under-uses.** That cuts both ways:

| Customer | What we earn |
|---|---|
| Deposits more than it needs (a treasury parking cash) | 10% of the surplus yield. $2.81M earning $126K a year, half used: $6.3K |
| Sizes the deposit to its spend | close to zero |

So the leftover fee pays best on treasuries that deposit for yield first and AI second. Revenue beyond it has to come from supply: once providers are contracted directly (Touchmark-style, decision 2), the gap between what we pay for open-weight inference and the credit price we charge is ours. Touchmark prices forwards up to 30% below market ([TFN](https://techfundingnews.com/touchmark-wants-to-turn-ai-inference-into-a-futures-market/)), and Orbio CREDIT trades 23 to 31% below ([orbio-mesh](https://github.com/sammy-XXIV/orbio-mesh)).
