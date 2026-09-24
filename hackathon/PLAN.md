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
2. Fast-forward six months. About **$2,250** of yield accrues, and the limits on three developer keys rise automatically.
3. A developer IDE and an OpenClaw agent each call a real model on their own key.
4. End on principal: still 100,000 USDC.

> **Say the right number in step 2.** $2,250 is gross yield at 4.5% simple. After our 10% fee and the 5% rail fee, keys get **$1,924 of credit** combined (`creditLimit`, checked in `ledger.test.ts`). With compounding the gross is $2,225. Either show the gross and the net side by side, or narrate the net.

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
