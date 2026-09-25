# Workflow

_**Draft, 2026-09-25.** Custody is decided (option D below, A as fallback). Choices still open are marked **Recommended**, with the alternatives next to them. Math: [`../engine/ledger.ts`](../engine/ledger.ts)._

This is the chain-agnostic mechanism: who sends which transaction, when, and what each party can and cannot do. Deployments differ only in chain, USDC address and yield source.

---

## Summary

1. Each customer gets **their own Octant YDS vault**. They deposit USDC and **keep the vault shares in their own wallet**.
2. The vault's donation address is our **Splitter**. When our keeper calls `report()`, the vault's profit is minted to the Splitter as vault shares. That is the customer's yield, now out of their position and in one place.
3. The customer's admin creates keys and gives each a **weight**. Our worker keeps each OpenRouter key's limit at its weight's share of the yield **already in the Splitter**, so every dollar of credit is backed before it is spent.
4. Once a month the Splitter settles: `usage` to our float, **10% of leftover** to us, the rest **redeposited into the customer's vault** as new principal.
5. The customer withdraws principal any time through the standard ERC-4626 `withdraw`. We are not involved.

**Trust in one line:** we can only ever spend yield already sitting in the Splitter, and only to two addresses fixed at deploy. Principal is in the customer's wallet the whole time.

---

## Actors

| Actor | What it is | Can do |
|---|---|---|
| **Customer** | Treasury wallet or Safe (ICP1), or an agent's wallet (ICP2) | Deposit, withdraw, set key weights. Holds the vault's **management** role |
| **Key holders** | Developers or agents | Call models with their key, nothing on-chain |
| **Customer vault** | Octant YDS strategy over an audited yield source, one per customer, deployed by our factory | Earns yield, mints profit to the Splitter on `report()`, burns Splitter shares first on a loss |
| **Splitter** | Our contract, one per chain, immutable. The donation address of every customer vault | Holds each customer's reported yield (as that vault's shares), settles monthly |
| **Keeper** | Our worker's signing key | Call `report()` on customer vaults and `settle()` on the Splitter. Nothing else |
| **OpenRouter** | Our account, prefunded float | Serves requests, enforces per-key limits |

Each customer vault is its own ERC-20 share token, so the Splitter's balance of vault X's shares is exactly customer X's unsettled yield. One Splitter serves every customer with no internal ledger.

---

## Lifecycle

```mermaid
sequenceDiagram
  participant C as Customer
  participant V as Customer vault (YDS)
  participant S as Splitter
  participant W as Worker (keeper)
  participant O as OpenRouter
  participant K as Key holders

  W->>V: deploy via factory (donation = Splitter, management = C)
  C->>V: deposit(assets), shares to C's wallet
  C->>W: create keys, set weights (dashboard)
  W->>O: create keys, limit 0
  loop daily
    W->>V: report(): profit minted to S as shares
  end
  loop every minute
    W->>S: read C's yield in S
    W->>O: read usage per key, set each key's limit
  end
  K->>O: model calls within limit
  Note over W,S: once a month
  W->>S: settle(vault, usage)
  S->>V: redeem usage + fee; redeposit the rest for C
  Note over C,V: any time
  C->>V: withdraw(assets)
```

### 1. Onboard

Our factory deploys a YDS strategy for the customer over the chosen yield source, with `donationAddress = Splitter`, `keeper = our worker`, `management = customer`. The customer approves USDC and calls `deposit`. Shares land in their wallet.

**Why the customer holds management:** the only lever over yield is the donation address, and changing it takes a two-step process with a **14-day cooldown** during which depositors can exit. If the customer points it elsewhere, they have simply left Inferest; we lose nothing, because we only ever spend yield already in the Splitter. Emergency functions move funds from the yield source back into the vault, never out.

### 2. Keys

In the dashboard the admin creates keys and sets a weight per key (decision 3). The worker creates matching OpenRouter keys with limit 0.

### 3. Report and sync

**Daily**, the keeper calls `report()` on each customer vault. Profit since the last report is minted to the Splitter as vault shares.

**Every minute**, per customer:

```
credit_i  = yieldInSplitter × (1 − railFee) × weight_i / Σ weights
spent_i   = (usage_i − usageAtPeriodStart_i) + toolSpend_i × (1 − railFee)
limit_i   = usage_i + max(credit_i − spent_i, 0)        (OpenRouter limits are cumulative)
```

A key's credit is fixed by its weight, so what one key leaves unused does not flow to the others (decision 3). The sum of open credit is capped at the pool: if reweighting would open more than the pool has left, every remaining budget is scaled down proportionally. Limits rise in a step after each report. Between syncs a key can overshoot by at most one minute of spend; we absorb that. If the yield source is worth less than the vault last reported, every key is frozen at its current usage until the next report.

### 4. Settle (monthly)

The keeper calls `Splitter.settle(vault, usage)` with the month's usage in USDC (credits spent / (1 − railFee)).

```
y        = convertToAssets(splitter's shares of vault)
paid     = min(usage, y)
leftover = y − paid
fee      = feeBps × leftover
redeem paid → FLOAT address, fee → FEE address          (both immutable)
transfer the shares worth leftover − fee to the customer
```

The Splitter transfers the leftover shares to the customer's wallet, where they are now principal. This is the kernel's `settle`: principal grows by `leftover − fee`. Because limits never open beyond `y`, `usage ≤ y` always holds and nothing is ever owed.

### 5. Withdraw

Standard ERC-4626 `withdraw` or `redeem` from the customer's own wallet, any time. Yield already reported sits in the Splitter and is settled on the normal schedule; yield accrued since the last report stays in the vault and is reported on the next `report()` against the remaining shares.

### 6. Vault loss

On a loss, `report()` **burns the Splitter's shares of that vault first**. So unsettled yield is the first-loss buffer, and principal is only hit by a loss larger than that buffer. Limits shrink with the Splitter balance on the next sync, so spend never exceeds what is backed.

---

## What the contracts enforce

| Guarantee | Enforced by |
|---|---|
| Principal stays in the customer's wallet | YDS shares are held by the customer; profit never raises their price per share |
| Only yield reaches us | Only profit is minted to the Splitter; the Splitter can only redeem its own shares |
| We take at most the yield, and at most 10% of what the customer did not use | `paid = min(usage, y)`, fee computed on-chain from leftover |
| Yield we take goes only to our two addresses | `floatAddress`, `feeAddress` immutable in the Splitter |
| We cannot trap funds | Withdrawal is standard ERC-4626 and needs nothing from us |
| We are never owed money | Limits open only up to yield already in the Splitter |
| **Not enforced:** that reported usage is honest | Usage is off-chain OpenRouter data. Bounded by yield in the Splitter. Customer can check it against per-key usage on the dashboard |

### Splitter interface (sketch)

```solidity
// immutables: asset, floatAddress, feeAddress, feeBps, keeper, factory
function settle(address vault, uint256 usage) external onlyKeeper;
function yieldOf(address vault) external view returns (uint256);   // convertToAssets(balanceOf(vault shares))
function customerOf(address vault) external view returns (address); // set by the factory at deploy
```

---

## Deployability

Checked 2026-09-25 against Octant v2 core (`golemfoundation/octant-v2-core`, audited by Spearbit, Cantina and Bailsec, AGPL-3.0).

- **The whole stack deploys on any EVM chain.** The strategy takes its `TokenizedStrategy` implementation address as a constructor argument, so we deploy the implementation ourselves; nothing depends on a pre-existing Octant deployment. Compiled with `evm_version = prague`; recompile for an older target if a chain requires it.
- **Ready-made strategies:** `ERC4626Strategy` wraps any ERC-4626 vault (Morpho, Euler, Fluid, Spark savings); `AaveV3Strategy` wraps Aave v3 directly.
- **Yield sources:** every target chain has at least one audited USDC (or USDG) source with millions in TVL. Per-chain picks are kept outside the repo.
- **License:** our Splitter only calls the vault through its interface, so it is not a derivative of the AGPL code. Forking or modifying Octant's contracts would be.

**Fallback A** applies only if a chain cannot host this stack: see decision 1.

---

## Decisions

### 1. Custody. **Decided: D, with A as fallback**

| Option | How | Cost |
|---|---|---|
| **D. One YDS vault per customer, donation address = Splitter (chosen)** | Described above | Limits step up once per `report()`. One vault per customer. Depends on the Octant stack |
| A. Settler holds the shares (fallback) | Deposit goes through our Settler; shares leave only via settle (yield) or withdraw after a request, freeze and final settlement, with a 24h window | Shares sit in our contract, not the customer's wallet. About one minute of spend exposed. All custom code |
| B. Keep approval, watch it | Customer approves shares to us; worker freezes keys on revoke | Up to a day of usage exposed; "principal never moves" rests on our behavior |
| C. Prepay each month | Customer pays expected usage up front | Breaks "pay with yield" |

### 2. Principal withdrawal. **Resolved by D**

Standard ERC-4626, any time, no window. The 24h request window exists only under fallback A.

### 3. Splitting yield across keys. **Decided: admin-set weights, default equal**

With $2,225 of credit and three keys, each gets about $742. One key's unused share does not flow to the others until the admin changes weights. Rejected: a shared pool (between syncs every key can spend the whole pool, so overshoot up to N times) and fixed dollar amounts (the admin has to guess the yield).

### 4. Cap us on-chain. **Resolved by D**

The cap is structural: only profit reaches the Splitter.

### 5. Demos. **Decided: two separate demos, equal weight**

A treasury demo (ICP1) and an agent demo (ICP2), each standing on its own. Scripts below.

### 6. Vault loss

On a loss, `report()` **burns the Splitter's shares of that vault first**. So unsettled yield is the first-loss buffer, and principal is only hit by a loss larger than that buffer. Limits shrink with the Splitter balance on the next sync, so spend never exceeds what is backed.

---

## What the contracts enforce

| Guarantee | Enforced by |
|---|---|
| Principal stays in the customer's wallet | YDS shares are held by the customer; profit never raises their price per share |
| Only yield reaches us | Only profit is minted to the Splitter; the Splitter can only redeem its own shares |
| We take at most the yield, and at most 10% of what the customer did not use | `paid = min(usage, y)`, fee computed on-chain from leftover |
| Yield we take goes only to our two addresses | `floatAddress`, `feeAddress` immutable in the Splitter |
| We cannot trap funds | Withdrawal is standard ERC-4626 and needs nothing from us |
| We are never owed money | Limits open only up to yield already in the Splitter |
| **Not enforced:** that reported usage is honest | Usage is off-chain OpenRouter data. Bounded by yield in the Splitter. Customer can check it against per-key usage on the dashboard |

### Splitter interface (sketch)

```solidity
// immutables: asset, floatAddress, feeAddress, feeBps, keeper, factory
function settle(address vault, uint256 usage) external onlyKeeper;
function yieldOf(address vault) external view returns (uint256);   // convertToAssets(balanceOf(vault shares))
function customerOf(address vault) external view returns (address); // set by the factory at deploy
```

---

## Deployability

Checked 2026-09-25 against Octant v2 core (`golemfoundation/octant-v2-core`, audited by Spearbit, Cantina and Bailsec, AGPL-3.0).

- **The whole stack deploys on any EVM chain.** The strategy takes its `TokenizedStrategy` implementation address as a constructor argument, so we deploy the implementation ourselves; nothing depends on a pre-existing Octant deployment. Compiled with `evm_version = prague`; recompile for an older target if a chain requires it.
- **Ready-made strategies:** `ERC4626Strategy` wraps any ERC-4626 vault (Morpho, Euler, Fluid, Spark savings); `AaveV3Strategy` wraps Aave v3 directly.
- **Yield sources:** every target chain has at least one audited USDC (or USDG) source with millions in TVL. Per-chain picks are kept outside the repo.
- **License:** our Splitter only calls the vault through its interface, so it is not a derivative of the AGPL code. Forking or modifying Octant's contracts would be.

**Fallback A** applies only if a chain cannot host this stack: see decision 1.

---

## Decisions

### 1. Custody. **Decided: D, with A as fallback**

| Option | How | Cost |
|---|---|---|
| **D. One YDS vault per customer, donation address = Splitter (chosen)** | Described above | Limits step up once per `report()`. One vault per customer. Depends on the Octant stack |
| A. Settler holds the shares (fallback) | Deposit goes through our Settler; shares leave only via settle (yield) or withdraw after a request, freeze and final settlement, with a 24h window | Shares sit in our contract, not the customer's wallet. About one minute of spend exposed. All custom code |
| B. Keep approval, watch it | Customer approves shares to us; worker freezes keys on revoke | Up to a day of usage exposed; "principal never moves" rests on our behavior |
| C. Prepay each month | Customer pays expected usage up front | Breaks "pay with yield" |

### 2. Principal withdrawal. **Resolved by D**

Standard ERC-4626, any time, no window. The 24h request window exists only under fallback A.

### 3. Splitting yield across keys. **Decided: admin-set weights, default equal**

With $2,225 of credit and three keys, each gets about $742. One key's unused share does not flow to the others until the admin changes weights. Rejected: a shared pool (between syncs every key can spend the whole pool, so overshoot up to N times) and fixed dollar amounts (the admin has to guess the yield).

### 4. Cap us on-chain. **Resolved by D**

The cap is structural: only profit reaches the Splitter.

### 5. Agents in the demo

| Option | Cost |
|---|---|
| **A. One of the three keys is an agent (OpenClaw) (Recommended)** | Shows ICP2 in the same three minutes. An agent depositing from its own wallet is the same vault with a different depositor: say it in the pitch, do not demo it |
| B. Separate agent-wallet flow | A second deposit, a second dashboard view. Does not fit three minutes |
| C. Treasury only | Loses ICP2 entirely |

### 6. Vault loss. **Mostly resolved by D**

YDS burns the Splitter's shares first, and limits only ever open up to the Splitter balance, so spend is always backed. Open only for fallback A.

### 7. Leftover yield. **Decided: redeposit**

The Splitter deposits `leftover − fee` back into the customer's vault with the customer as receiver, so it becomes principal and compounds.

### 8. How often the keeper calls `report()`. **Decided: daily**

`report()` is the vault's bookkeeping call. It measures what the vault's position in the yield source is worth now, compares that with the last report, and mints the difference to the Splitter as new shares (or burns Splitter shares on a loss). Until it is called, interest accrues inside the yield source but nobody can spend it, because it has not been booked.

Daily means limits step up once a day, at one transaction per customer per day. Rejected: hourly (24 times the gas for smoother limits) and only at settlement (keys at zero all month).

In the demos the keeper calls it by hand right after the time warp.

### 9. Paid tools for agents. **Decided: Orthogonal, through an Inferest MCP server**

Agents and developers using Inferest also get paid tools (web search, scraping, enrichment, research) with no extra accounts, paid from the same yield.

- **How:** we run an MCP server. The customer adds one URL and authenticates with their Inferest key. Tool calls go to [Orthogonal](https://docs.orthogonal.com/) and are paid **per call in USDC on Base over x402** from our wallet. Each response carries its price, which we record against the key.
- **Budget:** tool spend and model spend draw from the same pool under the same weights. At settlement, `usage` = model credits / (1 − railFee) + tool spend. Tools carry no top-up fee, because they are paid in USDC directly.
- **LLM calls are unchanged:** they still go straight to OpenRouter on the customer's OpenRouter key. The MCP server only handles tools, so decision 5 in the README (no LLM proxy) stands.

**Why Orthogonal over AgentCash:** Orthogonal is one server-side API (`search`, `details`, `run`) with a curated catalog, a price on every response, and x402 payment from a wallet we control. [AgentCash](https://agentcash.dev/docs/) has a bigger open catalog (3,200+ APIs), but it is built as a client-side CLI and MCP with a local wallet per user, and schemas vary by merchant. That fits one agent paying for itself, not a service paying on behalf of many customers. AgentCash stays a candidate for a later "bring your own agent wallet" mode.

### 10. Rail fee. **Decided: we absorb it in the hackathon build**

**The customer never sees the rail fee. It is our operating cost, handled entirely off-chain.**

| Layer | What happens |
|---|---|
| Worker (limits) | `pool = yieldInSplitter − spentThisPeriod`. One USDC of yield opens one dollar of credit |
| Splitter (on-chain) | Unchanged. `settle(vault, usage)` with `usage` = credits spent, 1:1 in USDC. The contract has no notion of a rail fee |
| Our treasury (off-chain) | `usage` arrives at the float address. Buying that much OpenRouter credit costs about 5% more; the difference comes out of the fee address |
| Kernel | `HACKATHON_PARAMS = { ourFee: 0.10, railFee: 0 }`; `operatorNet(settlement)` = fee − 5% of usage |

**The cost of absorbing it:** our result per settlement is `10% × leftover − 5% × usage`, which is **negative once a customer uses more than two thirds of its yield** (pinned in `ledger.test.ts`). Fine for a hackathon float. For the real product it is a choice between passing the fee through (`DEFAULT_PARAMS`, `railFee = 0.05`), absorbing it as acquisition cost, or removing it with the enterprise invoice. Tools bought through Orthogonal carry no rail fee either way.

---

## Demo scripts

_Numbers use `HACKATHON_PARAMS` (rail fee absorbed) and are pinned in `engine/ledger.test.ts`._

### Treasury (ICP1)

1. Finance lead deposits 100,000 USDC into their vault. Shares appear in their wallet.
2. Admin creates three developer keys at equal weight.
3. Warp six months, call `report()`: **$2,225** yield lands in the Splitter and **$2,225** of credit opens, about **$742** per key.
4. Developers call real models from their IDEs; say **$500** spent.
5. Settle: **$500** to the float, **$173** fee (10% of the $1,725 left over), **$1,553** redeposited. Principal is now **$101,553**, still in their wallet.
6. Withdraw **$101,553** straight from the wallet. No request, no wait.

### Agent (ICP2)

1. An agent's own wallet deposits into its own vault. Same contracts, different depositor.
2. The agent runs (OpenClaw or Hermes) with its Inferest key as its OpenRouter key, plus the Inferest MCP server for tools.
3. Warp, `report()`: the agent's limit rises from its own yield.
4. The agent does a task that needs a model **and** paid tools (search, scrape) through Orthogonal. The dashboard shows model spend and tool spend drawing from the same yield.
5. Settle: leftover goes back into the agent's vault. **No human topped anything up.**

---

## Out of scope

- Usage verification on-chain (bounded by the Splitter balance instead)
- Multiple vaults per customer, cross-chain positions
- Upgradeability. The Splitter is immutable; a new version is a new deployment
