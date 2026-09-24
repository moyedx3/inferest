# Hackathon Plan

**Goal: "deposit → yield accrues → key limit rises → real LLM call" in one screen, under three minutes.** Real yield on a small deposit is cents, so run on a Base mainnet fork (Anvil) and fast-forward time to show months of yield instantly.

---

## Stack

| Layer | Choice |
|---|---|
| Chain and vault | Morpho Steakhouse USDC vault on a Base mainnet fork, read with `@morpho-org/blue-sdk-viem` |
| Ledger and worker | Node cron worker reads vault share value and computes per-user accrued yield. Math lives in [`../engine/ledger.ts`](../engine/ledger.ts) |
| Keys | OpenRouter Management API creates per-developer and per-agent keys; the worker syncs limits to yield balance |
| Frontend | One dashboard for the finance lead: deposit button, accrued yield, list of issued keys |
| ICP2 | OpenClaw takes an OpenRouter key with one onboard command ([OpenRouter guide](https://openrouter.ai/docs/guides/guides/openclaw-integration)). Plug our key in as is; wrap it as a provider plugin if time allows |

---

## Tasks

- [ ] Fund OpenRouter float, issue a Management key
- [ ] Fork Base with Anvil, fund test wallet with USDC
- [ ] Deposit and withdraw scripts (ERC-4626 `deposit`, `convertToAssets`)
- [ ] Ledger plus limit-sync worker (wrap `engine/ledger.ts`)
- [ ] Dashboard: deposit, yield counter, key issuance
- [ ] Time-warp demo script (`evm_increaseTime`)
- [ ] Connect an issued key to OpenClaw and make a live call
- [ ] Pitch deck: problem, demo, unit economics table, non-custodial target architecture ([`../deck/outline.md`](../deck/outline.md))

---

## Demo script (3 minutes)

1. The finance lead deposits 100,000 USDC with one button.
2. Fast-forward six months. **$2,225** of yield accrues, and **$1,903** of credit opens across three developer keys (about $634 each) automatically.
3. A developer IDE and an OpenClaw agent each call a real model on their own key.
4. End on principal: still 100,000 USDC.

> **Where the numbers come from.** 4.5% is an APY, so six months is `1.045^0.5 − 1` = 2.225%, not 4.5% / 2. Gross yield $2,225; after our 10% fee and the 5% rail fee, $1,903 of credit. Checked in `engine/ledger.test.ts`. **On the fork, the vault's live APY sets the real figure**, so the dashboard must display what the ledger reads, not these constants. If the live APY is far from 4.5%, update this script and the deck before the demo.

---

## After the hackathon

1. **ICP1 interviews, 5 organizations:** foundation, validator and crypto startup CFOs. Validate demand for "pay AI with yield." Vault note 51 §10 adds the question that decides the open-weight question: what share of that spend is agents and batch jobs? Pass line 30%+
2. **Secure a rail:** OpenRouter enterprise inquiry, test Venice and Orbio rails in parallel
3. **Go non-custodial:** Octant YDS or a Kiln partner vault, so principal stays in the customer's wallet
4. **ICP2 SDK:** "inference from wallet yield" module for agent wallet teams (Coinbase Agentic Wallets, Crossmint, etc.)

---

## Open questions

| | Status |
|---|---|
| Role split with 찬우: contracts and worker vs frontend and pitch | undecided |
| Track: Base, Morpho or OpenRouter prize | undecided |
| Hackathon name and date | not recorded here yet |
