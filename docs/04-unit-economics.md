# Unit Economics

_Every number here comes from [`../engine/ledger.ts`](../engine/ledger.ts) and is checked in [`../engine/ledger.test.ts`](../engine/ledger.test.ts)._

**To cover AI spend with yield alone, principal has to be about 26 times the monthly budget** (about 2.2 times the annual budget). Realistic for a treasury, not enough for a small agent wallet.

---

## Assumptions

| | Value | Source |
|---|---|---|
| USDC vault APY | 4.5% | Top USDC vaults sit at 4 to 5% ([Eco](https://eco.com/support/en/articles/15182156-usdc-yield-in-2026-where-to-earn-interest-on-usdc)) |
| Our fee | 10% of yield | assumed |
| Rail fee | 5% | OpenRouter crypto top-up ([RouterPlex](https://routerplex.com/blog/openrouter-top-up-fees)) |

```
required principal = monthly budget × 12 / (APY × (1 − our fee) × (1 − rail fee))
                   = monthly budget × 12 / 0.038475
```

One dollar of yield buys **$0.855** of credit.

| Scenario | Monthly credit (USD) | Required principal (USD) |
|---|---|---|
| Light agent, cheap models | 10 | ~3,100 |
| Always-on agent | 50 | ~15,600 |
| One developer, normal use | 200 | ~62,400 |
| One developer, heavy use | 500 | ~156,000 |
| 20 developers × $500 | 10,000 | ~3,120,000 |

---

## ICP1: the numbers work

An organization with a treasury in the tens of millions covers its whole engineering team's AI spend with interest by depositing a fraction of it.

## ICP2: change the positioning

A $1,000 wallet earns about $3 a month. That is "base running cost subsidy," not free inference. Bundle it with cheap-model routing (OpenRouter's auto router or free models), or offer an option that draws from principal when yield runs short.

> **Note:** drawing from principal breaks build rule ① in the README. If it ships, it ships as an explicit opt-in, never a default.

## A second lever: buy inference at a discount

The same yield goes further if credit costs less. Touchmark offers up to 30% off through forward purchase ([TFN](https://techfundingnews.com/touchmark-wants-to-turn-ai-inference-into-a-futures-market/)), and Orbio CREDIT trades 23 to 31% below market ([orbio-mesh](https://github.com/sammy-XXIV/orbio-mesh)). A discounted rail cuts required principal by 20 to 30%.

Vault note 51 goes further: route to open-weight models, which clear the same quality bar at $0.09 vs $0.43 for closed models (4.78x, Ornn table 4). See [`../sources/vault-51-agent-inference-payment-rail.md`](../sources/vault-51-agent-inference-payment-rail.md) §6–§7.

## Our revenue is thin on the yield fee alone

$3.12M principal earns about $140K a year. 10% of that is $14K. **Revenue has to be designed around the discounted-credit spread and enterprise seat pricing as well.**
