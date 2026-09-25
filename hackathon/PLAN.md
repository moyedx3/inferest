# Hackathon Plan

**Goal: "deposit → yield accrues → key limit rises → real LLM call" in one screen, under three minutes.** Real yield on a small deposit is cents, so run on a mainnet fork of the target chain (Anvil) and fast-forward time to show months of yield instantly.

---

## Stack

| Layer | Choice |
|---|---|
| Chain and vault | Any EVM chain with an audited ERC-4626 USDC vault, set in config. Morpho where deployed (read with `@morpho-org/blue-sdk-viem`), plain ERC-4626 calls otherwise |
| Ledger and worker | Node cron worker reads vault share value, computes per-user accrued yield, syncs key limits, and settles each period. Math lives in [`../engine/ledger.ts`](../engine/ledger.ts) |
| Keys | OpenRouter Management API keys under our account (decided: no proxy). The worker sets each key's limit and reads each key's usage |
| Custody | One Octant YDS vault per customer, shares in the customer's wallet, yield minted to our Splitter. `report()` and settlement by hand in the demo |
| Frontend | One dashboard for the finance lead: deposit button, accrued yield, list of issued keys |
| ICP2 | OpenClaw takes an OpenRouter key with one onboard command ([OpenRouter guide](https://openrouter.ai/docs/guides/guides/openclaw-integration)). Plug our key in as is; wrap it as a provider plugin if time allows |

---

## Tasks

- [ ] Fund OpenRouter float, issue a Management key
- [ ] Fork the target chain with Anvil, fund test wallet with USDC
- [ ] Chain config: RPC, USDC, vault address per chain
- [ ] Deploy Octant's `TokenizedStrategy` implementation and a YDS strategy over the target chain's USDC source
- [ ] Splitter contract: donation address for every customer vault; `settle(vault, usage)` pays usage and fee, redeposits the rest
- [ ] Factory: deploys a customer vault with donation = Splitter, management = customer
- [ ] Deposit and withdraw scripts (ERC-4626 `deposit`, `convertToAssets`)
- [ ] Ledger plus limit-sync worker (wrap `engine/ledger.ts`)
- [ ] Settlement script: read key usage, redeem `usage + fee` from the customer's shares
- [ ] Dashboard: deposit, yield counter, key issuance
- [ ] Time-warp demo script (`evm_increaseTime`)
- [ ] Connect an issued key to OpenClaw and make a live call
- [ ] Pitch deck: problem, demo, unit economics table, non-custodial target architecture ([`../deck/outline.md`](../deck/outline.md))

---

## Demo script (3 minutes)

1. The finance lead deposits 100,000 USDC with one button. The vault shares land in their own wallet.
2. Fast-forward six months. **$2,225** of yield accrues, and **$2,114** of credit opens across three developer keys (about $705 each) automatically.
3. A developer IDE and an OpenClaw agent each call a real model on their own key. Say the keys spend **$500** this period.
4. Settle. **$526** goes to the rail for that usage, **$170** to us (10% of the $1,699 left over), and **$1,529** stays in the customer's vault. Principal is now **$101,529**. Nothing else left their wallet.

> **Where the numbers come from.** 4.5% is an APY, so six months is `1.045^0.5 − 1` = 2.225%, not 4.5% / 2. Credit = yield × 0.95 after the 5% rail fee. Usage = $500 / 0.95. All pinned in `engine/ledger.test.ts`. **On the fork, the vault's live APY sets the real figure**, so the dashboard must display what the ledger reads, not these constants. If the live APY is far from 4.5%, update this script and the deck before the demo.

---

## After the hackathon

1. **ICP1 interviews, 5 organizations:** foundation, validator and crypto startup CFOs. Validate demand for "pay AI with yield." Vault note 51 §10 adds the question that decides the open-weight question: what share of that spend is agents and batch jobs? Pass line 30%+
2. **Secure a rail:** OpenRouter enterprise inquiry, test Venice and Orbio rails in parallel
3. **Go non-custodial:** Octant YDS or a Kiln partner vault, so principal stays in the customer's wallet
4. **ICP2 SDK:** "inference from wallet yield" module for agent wallet teams (Coinbase Agentic Wallets, Crossmint, etc.)
