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
# TARGET_VAULT (and optionally TARGET_VAULTS, FEE_BPS) in the shell first; this writes contracts/deployments/<chainId>.json,
# which DEPLOYMENTS in .env points at
(cd contracts && forge script script/Deploy.s.sol --rpc-url $RPC_URL --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow)
npm run serve                             # builds the dashboard bundle, then Home, Treasury and Agents, API, chat at /v1, MCP at /mcp
npm run demo:treasury                     # or demo:agent
```

**Deployment.** `TARGET_VAULTS` (comma-separated) allowlists extra ERC-4626 yield sources beyond `TARGET_VAULT`, which stays the default the Treasury page creates over and must match `config/arbitrum-one.json`'s `targets` list.

**Use a key.** Point any OpenAI-compatible client at `http://localhost:8787/v1` with an Inferest key as the API key (model ids are OpenRouter's); the dashboard's Use a key section (`http://localhost:8787/setup` redirects there) has copyable snippets, and works without signing in. The same key authenticates to the MCP tools server at `/mcp`. Set `KEY_ENCRYPTION_KEY` (`openssl rand -hex 32`) before the first start.

**Sign in.** With `DYNAMIC_ENVIRONMENT_ID` set (a free environment at app.dynamic.xyz with email login and EVM embedded wallets enabled, and the dashboard's origin allowed), a finance lead signs in on the dashboard with an email code or by connecting the treasury wallet, and manages the vault that wallet created. Without it, the operator token is the only credential. `PUBLIC_RPC_URL` is the browser-facing RPC the dashboard's wallet uses; `DEMO_FAUCET=1` adds a "Get demo funds" button on a forked chain. The judge path is in [`docs/07-walkthrough.md`](docs/07-walkthrough.md). `npm run serve` reads `.env` and `.env.local` itself.

**The hosted agent.** `npm run agent` runs our own financial agent under `agent/`: a wallet of its own (`AGENT_PRIVATE_KEY`) keeps half its book parked in an Inferest vault and works the other half on paper. Every `AGENT_INTERVAL_MS` it reads its book, researches with a model and paid tools on its own Inferest key, decides, and has the fence in `agent/fence.ts` drop anything outside its rules before it acts: a deposit, a withdrawal, a move to another allowlisted yield source, paper trades. The yield on the parked half is its thinking budget; when that runs out, the run says so and waits for yield. Every fourth run settles its vault as a month end. On a fork, `AGENT_DEMO_DAYS` moves the chain clock before each run and the first start funds the wallet from the faucet. `npm run agent -- --once` does one run and exits. It writes its runs to the store's file, which `GET /api/agent` and the Agents page read. Its Inferest key never touches disk: the runner rotates the key on each start and keeps the secret in memory.

`forge test` prints diagnostics from an upstream Foundry lint bug before its results; read the `Suite result` lines.

Every `npm run` command loads `.env` and then `.env.local` when that file exists, so a local fork's RPC, keeper key, faucet flag and public RPC can live in `.env.local` (git-ignored) while `.env` keeps the real chain's values. The demos run against a Tenderly Virtual TestNet or a local anvil fork of the target chain; the demo helpers support both. A virtual testnet must keep chain id 42161: the deploy script names its file after `block.chainid`, and that name has to match `config/arbitrum-one.json`. A fork over Arbitrum's public RPC can only fetch state for about thirty minutes after its fork block; the first settlement to touch a storage slot nobody has read yet then fails with `missing trie node`. Start the fork right before the run and run `demo/treasury.ts` once so anvil caches the slots a settlement needs, or fork from an archive RPC.

### Background

| | |
|---|---|
| [`docs/01-problem-and-icp.md`](docs/01-problem-and-icp.md) | The problem and the two customers: crypto treasuries (direct B2B) and agent wallet teams (B2B2C) |
| [`docs/02-landscape.md`](docs/02-landscape.md) | Venice, Orbio, Touchmark, x402 gateways, OpenRouter: what each funds credits with |
| [`docs/03-architecture.md`](docs/03-architecture.md) | Five engine modules, plug-in yield sources, credit rails |
| [`docs/04-unit-economics.md`](docs/04-unit-economics.md) | Principal needed per budget, where our revenue comes from |
| [`docs/05-risks.md`](docs/05-risks.md) | Terms of service, custody, contracts, rates, rail dependence, tax |
| [`docs/06-workflow.md`](docs/06-workflow.md) | **The mechanism as built.** Who sends which transaction: per-customer vaults, the Splitter, the keeper, paid tools, settlement, known gaps |
| [`docs/07-walkthrough.md`](docs/07-walkthrough.md) | The dashboard path a judge or a customer follows |
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
          Inferest keys (sk-inf-…) on our proxy, metered per call ──▶ IDE, agent, OpenClaw
          one OpenRouter key per vault behind it, its limit synced as the backstop
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
- Deposit and withdraw against an ERC-4626 USDC vault (Fluid USDC on Arbitrum One) on a mainnet fork
- Ledger, a proxy that meters every model call against the key's yield budget, and a worker that keeps the provider backstop in step and settles each period
- One dashboard: deposit, yield counter, issued keys
- Time-warp demo script
- A live model call from an IDE and an OpenClaw agent on issued keys

**Do not build (yet)**
- Our own vault or yield strategy. Use an audited one
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
| 5 | Keys | **Inferest keys in front of one OpenRouter key per vault.** A small proxy checks the key's budget before the call and meters the cost after; the provider key's limit is a backstop | Decided 2026-09-25. Per-developer budgets, instant revoke and rotate, and the same key for models and MCP tools; the base URL is the only thing a client changes. See [`docs/superpowers/specs/2026-09-25-inference-proxy-design.md`](docs/superpowers/specs/2026-09-25-inference-proxy-design.md) |
| 6 | Customers | **Two ICPs**: crypto treasuries, agent wallet teams | Vault note 51's third segment (financial agent platforms) dropped |
| 7 | Custody | **One Octant YDS vault per customer; shares stay in the customer's wallet; profit is minted to our Splitter, which spends only `usage + fee`.** | Decided 2026-09-25. Deployability checked on every target chain. See [`docs/06-workflow.md`](docs/06-workflow.md) |
| 8 | Settlement period | **Monthly.** In the demo, settlement is triggered by hand | Easy to change: the kernel has no notion of period length |
| 9 | Leftover yield | **Returned to the customer as vault shares**, which is new principal | Matches `settle` in the kernel; the Splitter transfers the shares rather than redeeming and redepositing |
| 10 | Key budgets | **Admin-set weights per key, default equal** | |
| 11 | Demos | **Two separate demos**: treasury (ICP1) and agent (ICP2) | |
| 12 | Paid tools | **Orthogonal, through an Inferest MCP server**, paid per call in USDC from the same yield | See `docs/06` decision 9 |
| 13 | `report()` cadence | **Daily** | |
| 14 | Rail fee (hackathon) | **We absorb it.** Customer gets $1 of credit per $1 of yield; the ~5% is our cost | `HACKATHON_PARAMS` in the kernel |
| 15 | Admin identity | **Dynamic login; a vault's admin is the login whose verified wallet created it** | Decided 2026-09-26. Email code with an embedded wallet, or the treasury wallet through Dynamic's connectors; the operator token stays for us. See [`docs/superpowers/specs/2026-09-26-wallet-login-design.md`](docs/superpowers/specs/2026-09-26-wallet-login-design.md) |

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
app/          keeper, inference proxy, Orthogonal tools over MCP, HTTP API, dashboard
demo/         treasury and agent scripts for a forked chain
config/       per-chain addresses
docs/         problem, landscape, architecture, economics, risks, workflow, plans
sources/      original Korean notes, unedited
```
