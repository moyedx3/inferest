# Inferest

### Crypto treasuries earn 4 to 5% on idle USDC. None of it can pay an AI bill without selling, off-ramping and putting it on a card.

**Inferest pays for inference with yield.** Principal sits in a yield vault. Only the interest it earns becomes LLM API credit, issued as a spend limit on per-developer or per-agent keys. Principal is never spent.

> The name is the mechanism: **infer**ence paid from inte**rest**.

---

## Why

An organization holding crypto that wants to pay for AI today goes through three steps: sell and off-ramp, budget the fiat as opex, top up credits by card. Each step is a tax event, a conversion fee or an approval delay.

Autonomous agents have it worse. **An agent has an on-chain wallet but cannot get a card**, so a human has to keep refilling its API key.

Inferest removes both:

| | Today | With Inferest |
|---|---|---|
| Treasury to AI spend | sell → off-ramp → opex → card top-up | one deposit |
| Who pays | principal, via operating cash | yield only |
| Agent refills | a human tops up the key | the agent's own wallet yield raises its limit |

**The idea is already proven, with the wrong collateral.** [Venice](https://docs.venice.ai/overview/vvv-diem) (stake VVV, mint DIEM, get $1/day of credit forever) and [Orbio](https://www.orbio.so/protocol) (token fees converted to OpenRouter credit) both turn crypto into inference. Both fund it with **their own token**. Nobody funds it with neutral blue-chip yield: USDC lending, ETH and SOL staking. That is the gap.

---

## Start here

| | |
|---|---|
| **[`engine/ledger.ts`](engine/ledger.ts)** | **The ledger kernel.** Pure functions: accrued yield, credit limit, harvest, required principal. Source of truth for every number in these docs |
| [`hackathon/PLAN.md`](hackathon/PLAN.md) | Build plan, task list, 3-minute demo script, open questions |
| [`deck/outline.md`](deck/outline.md) | Pitch deck content spec |

```bash
npm test    # node --test, no dependencies (Node 22.6+ for native TypeScript)
```

### Background

| | |
|---|---|
| [`docs/01-problem-and-icp.md`](docs/01-problem-and-icp.md) | The problem and the two customers: crypto treasuries (direct B2B) and agent wallet teams (B2B2C) |
| [`docs/02-landscape.md`](docs/02-landscape.md) | Venice, Orbio, Touchmark, x402 gateways, OpenRouter: what each funds credits with |
| [`docs/03-architecture.md`](docs/03-architecture.md) | Five engine modules, plug-in yield sources, credit rails |
| [`docs/04-unit-economics.md`](docs/04-unit-economics.md) | Principal needed per budget, where our revenue comes from |
| [`docs/05-risks.md`](docs/05-risks.md) | Terms of service, custody, contracts, rates, rail dependence, tax |
| [`sources/`](sources/) | The original Korean notes this repo is built from. Read-only reference |

---

## The loop

```
deposit USDC ──▶ ERC-4626 vault ──▶ ledger: accrued = convertToAssets(shares) − principal
                                         │
                                         ▼
                           credit limit = yield × (1 − ourFee) × (1 − railFee)
                                         │
                                         ▼
                   key manager syncs each key's spend limit ──▶ IDE, agent, OpenClaw
                                         │
                          weekly: harvest yield shares, top up the rail float
```

**The limit opens only up to yield already earned, never ahead of it.** So spend can never reach principal, and withdrawal never has to claw anything back. At the default fees one dollar of yield buys $0.855 of credit.

---

## Build rules

| | Rule | Why |
|---|---|---|
| ① | **Never open a limit ahead of earned yield** | The moment spend can exceed yield, principal is at risk and "principal never moves" is false |
| ② | **Yield side and credit side meet only in the ledger** | So vaults (Morpho, Aave, Octant YDS, Kiln) and rails (OpenRouter, Venice, x402) swap independently |
| ③ | **Hackathon runs on a Base mainnet fork** | Real yield is cents. Time-warp with `evm_increaseTime` to show months in seconds |

---

## Scope

**Build (hackathon)**
- Deposit and withdraw against a Morpho USDC vault on a Base fork
- Ledger plus a worker that syncs OpenRouter key limits to accrued yield
- One dashboard: deposit, yield counter, issued keys
- Time-warp demo script
- A live model call from an IDE and an OpenClaw agent on issued keys

**Do not build (yet)**
- Our own vault or yield strategy. Use an audited one
- Custody of customer funds beyond a testnet or our own small float
- Multi-chain, self-hosted models, closed-model resale at scale

---

## Open decisions

These are unresolved. The vault note in [`sources/vault-51-agent-inference-payment-rail.md`](sources/vault-51-agent-inference-payment-rail.md), written the same day, takes a different position on several of them.

| # | Decision | This repo (hackathon) | Vault note 51 |
|---|---|---|---|
| 1 | **What funds spend** | Yield only | Balance: spend from the balance, idle balance earns yield, principal still untouchable by policy |
| 2 | **Supply** | OpenRouter float, 400+ models including closed | Open-weight only in v0; closed models are resale and zero margin |
| 3 | **ICP1 pain** | Off-ramp friction | Off-ramp is "half right"; the real pain is multisig governance, runway burn and no per-person attribution |
| 4 | **Where the margin is** | Yield fee, discounted credit spread, seats | Open-weight routing spread (4.78x cheaper at the same quality bar) |
| 5 | **Biggest kill risk** | Rail terms of service | Open-weight is a third of tokens but 11% of enterprise dollars |
| 6 | Role split with 찬우, hackathon track (Base, Morpho or OpenRouter) | Undecided | |

---

## Honestly: what is unproven

| # | Assumption | Status |
|---|---|---|
| 1 | Treasuries will turn this on | **zero conversations** |
| 2 | Yield covers a meaningful share of spend | only at treasury scale: $62K principal per $200/month developer |
| 3 | A rail will let us resell credit | **OpenRouter's standard terms forbid it**; enterprise terms allow it |
| 4 | Non-custodial routing (Octant YDS, Kiln) works for a CFO's Safe | target architecture, not built |

> **A working demo proves none of the four.** It is worth building anyway. The two should not be confused.

---

## Layout

```
engine/       ledger kernel + tests (source of truth for the math)
app/          dashboard + limit-sync worker
contracts/    anything on-chain beyond the vault we plug into
hackathon/    build plan, demo script
deck/         pitch outline
docs/         problem, landscape, architecture, economics, risks
sources/      original Korean notes, unedited
```
