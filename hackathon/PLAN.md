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

The build is tracked task by task in [`../docs/superpowers/plans/2026-09-25-general-build.md`](../docs/superpowers/plans/2026-09-25-general-build.md).

---

## Demo scripts

Two separate demos, treasury and agent. Scripts and numbers live in [`../docs/06-workflow.md`](../docs/06-workflow.md#demo-scripts) so there is one copy. **On the fork, the vault's live APY sets the real figures**, so the dashboard must display what the ledger reads, not these constants.

---

## After the hackathon

1. **ICP1 interviews, 5 organizations:** foundation, validator and crypto startup CFOs. Validate demand for "pay AI with yield." Vault note 51 §10 adds the question that decides the open-weight question: what share of that spend is agents and batch jobs? Pass line 30%+
2. **Secure a rail:** OpenRouter enterprise inquiry, test Venice and Orbio rails in parallel
3. **Go non-custodial:** Octant YDS or a Kiln partner vault, so principal stays in the customer's wallet
4. **ICP2 SDK:** "inference from wallet yield" module for agent wallet teams (Coinbase Agentic Wallets, Crossmint, etc.)
