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
npm install
npm test                                  # ledger kernel + app, no network
cd contracts && forge test                # Splitter, factory, lifecycle
cp .env.example .env                      # then fill it in
# deploy: export RPC_URL, DEPLOYER_PRIVATE_KEY, KEEPER, FLOAT_ADDRESS, FEE_ADDRESS, EMERGENCY_ADMIN,
# TARGET_VAULT (and optionally FEE_BPS) in the shell first; this writes contracts/deployments/<chainId>.json,
# which DEPLOYMENTS in .env points at
(cd contracts && forge script script/Deploy.s.sol --rpc-url $RPC_URL --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow)
node --env-file=.env app/cli.ts serve     # dashboard, API, MCP at /mcp
node --env-file=.env demo/treasury.ts     # or demo/agent.ts
```

`forge test` prints diagnostics from an upstream Foundry lint bug before its results; read the `Suite result` lines.

The demos run against a Tenderly Virtual TestNet or a local anvil fork of the target chain; the demo helpers support both. A virtual testnet must keep chain id 42161: the deploy script names its file after `block.chainid`, and that name has to match `config/arbitrum-one.json`.

### Background

| | |
|---|---|
| [`docs/01-problem-and-icp.md`](docs/01-problem-and-icp.md) | The problem and the two customers: crypto treasuries (direct B2B) and agent wallet teams (B2B2C) |
| [`docs/02-landscape.md`](docs/02-landscape.md) | Venice, Orbio, Touchmark, x402 gateways, OpenRouter: what each funds credits with |
| [`docs/03-architecture.md`](docs/03-architecture.md) | Five engine modules, plug-in yield sources, credit rails |
| [`docs/04-unit-economics.md`](docs/04-unit-economics.md) | Principal needed per budget, where our revenue comes from |
| [`docs/05-risks.md`](docs/05-risks.md) | Terms of service, custody, contracts, rates, rail dependence, tax |
| [`docs/06-workflow.md`](docs/06-workflow.md) | **Draft.** Who sends which transaction: per-customer YDS vaults, the Splitter, remaining choices with recommendations |
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
| 2 | Supply | **Hackathon:** our OpenRouter account, resold through per-key limits, the way Orbio does it. **Real product: both** OpenRouter under an enterprise contract (breadth, closed models, invoiced after usage) **and** contracted open-weight providers the way Touchmark does it (margin) | Enterprise terms permit serving end customers |
| 3 | ICP1 pain | **Opex is fiat, treasury is on-chain.** Off-ramp then top up becomes one stop, and idle yield pays for it | |
| 4 | Fee | **10% of leftover yield** (yield minus what credits cost). Leftover goes back to the customer | Rate is a placeholder |
| 5 | Keys | **OpenRouter Management API keys**, not our own proxy | Same features for the hackathon (per-key limits, per-key usage), far less to build. A proxy comes with the move to contracted providers, when `base_url` changes anyway |
| 6 | Customers | **Two ICPs**: crypto treasuries, agent wallet teams | Vault note 51's third segment (financial agent platforms) dropped |
| 7 | Custody | **One Octant YDS vault per customer; shares stay in the customer's wallet; profit is minted to our Splitter, which spends only `usage + fee`.** Fallback: our own Settler holds shares | Decided 2026-09-25. Deployability checked on every target chain. See [`docs/06-workflow.md`](docs/06-workflow.md) |
| 8 | Settlement period | **Monthly.** In the demo, settlement is triggered by hand | Easy to change: the kernel has no notion of period length |
| 9 | Leftover yield | **Redeposited into the customer's vault** as new principal | Matches `settle` in the kernel |
| 10 | Key budgets | **Admin-set weights per key, default equal** | |
| 11 | Demos | **Two separate demos**: treasury (ICP1) and agent (ICP2) | |
| 12 | Paid tools | **Orthogonal, through an Inferest MCP server**, paid per call in USDC from the same yield | See `docs/06` decision 9 |
| 13 | `report()` cadence | **Daily** | |
| 14 | Rail fee (hackathon) | **We absorb it.** Customer gets $1 of credit per $1 of yield; the ~5% is our cost | `HACKATHON_PARAMS` in the kernel |

## Open

| | Status |
|---|---|
| Rail fee in the real product: pass through, absorb, or enterprise invoice | absorbed in the hackathon build; absorbing loses money past 2/3 of yield used |

---

## Honestly: what is unproven

| # | Assumption | Status |
|---|---|---|
| 1 | Treasuries will turn this on | **zero conversations** |
| 2 | Yield covers a meaningful share of spend | only at treasury scale: $56K principal per $200/month developer |
| 3 | A rail will let us resell credit | **OpenRouter's standard terms forbid it**; enterprise terms allow it |
| 4 | A CFO will deposit into a per-customer YDS vault we deploy | structure checked, not built |
| 5 | Fee on leftover yield is enough revenue | heavy users pay nothing. See `docs/04` |

> **A working demo proves none of the five.** It is worth building anyway. The two should not be confused.

---

## Layout

```
engine/       ledger kernel + tests (source of truth for the math)
contracts/    Splitter, VaultFactory (Octant YDS per customer), tests, deploy script
app/          keeper, OpenRouter keys, Orthogonal tools over MCP, HTTP API, dashboard
demo/         treasury and agent scripts for a forked chain
config/       per-chain addresses
docs/         problem, landscape, architecture, economics, risks, workflow, plans
sources/      original Korean notes, unedited
```
