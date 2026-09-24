# Inferest

### Crypto treasuries earn 4 to 5% on idle USDC. None of it can pay an AI bill without selling, off-ramping and putting it on a card.

**Inferest pays for inference with yield.** Principal sits in a yield vault in the customer's own wallet. Only the interest it earns becomes LLM API credit, issued as a spend limit on per-developer or per-agent keys. Yield the customer does not use goes back to them, less a 10% fee. Principal is never spent.

> **Your interest, now inference.**

---

## Why

**Operating expenses are paid in fiat. The treasury is on-chain.** So an organization that wants to pay for AI today has to off-ramp first and then top up credits: sell, convert, move to the operating account, pay by card. Each step is a tax event, a conversion fee or an approval delay, and the idle treasury earns yield that none of this touches.

Inferest makes it one stop, and pays for it with the idle assets' yield.

Autonomous agents have it worse. **An agent has an on-chain wallet but cannot get a card**, so a human has to keep refilling its API key.

Inferest removes both:

| | Today | With Inferest |
|---|---|---|
| Treasury to AI spend | sell → off-ramp → opex → card top-up | one deposit |
| Who pays | principal, via operating cash | yield only; unused yield returned less 10% |
| Agent refills | a human tops up the key | the agent's own wallet yield raises its limit |

**The idea is already proven, with the wrong collateral.** [Venice](https://docs.venice.ai/overview/vvv-diem) (stake VVV, mint DIEM, get $1/day of credit forever) and [Orbio](https://www.orbio.so/protocol) (token fees converted to OpenRouter credit) both turn crypto into inference. Both fund it with **their own token**. Nobody funds it with neutral blue-chip yield: USDC lending, ETH and SOL staking. That is the gap.

---

## Start here

| | |
|---|---|
| **[`engine/ledger.ts`](engine/ledger.ts)** | **The ledger kernel.** Pure functions: accrued yield, credit limit, settlement, required principal. Source of truth for every number in these docs |
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
| [`docs/06-workflow.md`](docs/06-workflow.md) | **Draft.** Who sends which transaction, the Settler contract, six open choices with recommendations |
| [`sources/`](sources/) | The original Korean notes this repo is built from. Read-only reference |

---

## The loop

```
customer wallet ──deposit──▶ ERC-4626 vault (shares stay in the customer's wallet)
                                   │
                                   ▼
          ledger: yield = convertToAssets(shares) − principal
                  credit limit = yield × (1 − railFee)
                                   │
                                   ▼
          OpenRouter keys under our account, limits synced per key ──▶ IDE, agent, OpenClaw
                                   │
          each period: settle
            usage    = credits spent / (1 − railFee)       → redeemed, tops up the OpenRouter float
            leftover = yield − usage
            fee      = 10% × leftover                       → redeemed, to Inferest
            the other 90% of leftover stays in the vault    → becomes principal
```

**The limit opens only up to yield already earned, never ahead of it.** So spend can never reach principal. At settlement only `usage + fee` leaves the customer's position; returning leftover yield means simply not taking it.

**Our fee is on what the customer did not use.** A customer who spends all its yield pays us nothing; one who spends none keeps 90% of it. Worked numbers in [`docs/04-unit-economics.md`](docs/04-unit-economics.md).

---

## Build rules

| | Rule | Why |
|---|---|---|
| ① | **Never open a limit ahead of earned yield** | The moment spend can exceed yield, principal is at risk and "principal never moves" is false |
| ② | **Yield side and credit side meet only in the ledger** | So vaults (Morpho, Aave, Octant YDS, Kiln) and rails (OpenRouter, Venice, x402) swap independently |
| ③ | **Take only `usage + fee` at settlement** | Leftover yield is returned by staying in the vault, not by a transfer back |
| ④ | **The chain is a config value** | Any EVM chain with an audited ERC-4626 USDC vault. Contracts and worker take the chain and vault address as config, nothing chain-specific in code |
| ⑤ | **Demo on a mainnet fork of the target chain** | Real yield is cents. Time-warp with `evm_increaseTime` to show months in seconds |

---

## Scope

**Build (hackathon)**
- Deposit and withdraw against an ERC-4626 USDC vault (Morpho where deployed) on a mainnet fork
- Ledger plus a worker that syncs OpenRouter key limits to accrued yield and settles each period
- One dashboard: deposit, yield counter, issued keys
- Time-warp demo script
- A live model call from an IDE and an OpenClaw agent on issued keys

**Do not build (yet)**
- Our own vault or yield strategy. Use an audited one
- Our own inference proxy. OpenRouter keys do the metering until supply moves off OpenRouter
- Cross-chain positions (one deployment serves one chain), self-hosted models
- A principal-drawing option. Spend stops at yield, always

---

## Decisions

Settled 2026-09-24. Where they depart from the source notes in [`sources/`](sources/), this table wins.

| # | Decision | Chosen | Note |
|---|---|---|---|
| 1 | What funds spend | **Yield only** | No option to draw from principal. Vault note 51 proposed spending from the balance; rejected |
| 2 | Supply | **Hackathon:** our OpenRouter account, resold through per-key limits, the way Orbio does it. **Real product:** contract providers to run open-weight models, the way Touchmark does it | |
| 3 | ICP1 pain | **Opex is fiat, treasury is on-chain.** Off-ramp then top up becomes one stop, and idle yield pays for it | |
| 4 | Fee | **10% of leftover yield** (yield minus what credits cost). Leftover goes back to the customer | Rate is a placeholder |
| 5 | Keys | **OpenRouter Management API keys**, not our own proxy | Same features for the hackathon (per-key limits, per-key usage), far less to build. A proxy comes with the move to contracted providers, when `base_url` changes anyway |
| 6 | Customers | **Two ICPs**: crypto treasuries, agent wallet teams | Vault note 51's third segment (financial agent platforms) dropped |
| 7 | Custody | **Customer holds the vault shares and approves them to our settler; each period we redeem only `usage + fee`** | **Under review:** the workflow draft recommends the Settler contract hold shares instead. See [`docs/06-workflow.md`](docs/06-workflow.md#1-the-customer-revokes-access-before-settlement) |
| 8 | Settlement period | **Monthly.** In the demo, settlement is triggered by hand | Easy to change: the kernel has no notion of period length |

## Open

| | Status |
|---|---|
| Does the custody mechanism (#7) hold up once written as a contract | revisit during contract design |
| **What happens to spend already made when the vault loses value** | after the workflow is final. The kernel floors yield at zero and stops new spend, nothing more |

---

## Honestly: what is unproven

| # | Assumption | Status |
|---|---|---|
| 1 | Treasuries will turn this on | **zero conversations** |
| 2 | Yield covers a meaningful share of spend | only at treasury scale: $56K principal per $200/month developer |
| 3 | A rail will let us resell credit | **OpenRouter's standard terms forbid it**; enterprise terms allow it |
| 4 | A CFO will approve vault shares to our settler | the approval can redeem principal too unless a contract caps it. Not built |
| 5 | Fee on leftover yield is enough revenue | heavy users pay nothing. See `docs/04` |

> **A working demo proves none of the five.** It is worth building anyway. The two should not be confused.

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
