# About Inferest

_The one source for describing the project: motivation, what it is, how it works, who it is for, how the demo goes. Answers for any submission form are cut from this page, not written fresh. Numbers trace to `docs/01`, `docs/02`, `docs/04`, `deck/outline.md` or the live pages. Updated 2026-10-03._

---

## In one sentence

**Inferest turns the yield on idle stablecoins into AI spend. Deposit once, the principal stays in your own wallet, and only the interest becomes API keys for your developers or your agents.**

Tagline: _Your interest, now inference._

---

## Why we built it

Our developers kept asking for more LLM credits. Every request was the same loop: someone asks, someone approves, someone tops up a card. We wanted a way for that budget to fund itself, and a more creative use of crypto than another payment button. Stablecoins earn yield sitting still. So we asked what happens if the interest, not the principal, pays the AI bill, with a hard limit on each developer's key.

**The organizations that feel this most hold their treasury on-chain.** Their operating expenses go out in fiat, so paying for AI takes three steps: sell or off-ramp the crypto, move the fiat to the operating account, top up credits by card. Each step adds a tax event, a conversion fee or an approval delay. Meanwhile the treasury earns yield that never reaches the AI bill.

**And that bill is growing fast.** Across businesses on Ramp's token spend product, token usage grew 1,001% and spend 497% from January 2025 to April 2026; the median was $46 per employee per month, and $442 at companies using 26 or more models ([Ramp](https://ramp.com/blog/ai-token-cost-for-businesses)). Uber used up its full-year AI coding budget by April ([TechCrunch](https://techcrunch.com/2026/07/14/metas-adam-mosseri-says-ai-token-budgets-could-soon-be-capped-per-engineer/)). Per-engineer token caps are expected to follow; Inferest makes the cap the key itself, paid for by interest.

**Agents are blocked harder still.** An agent holds an on-chain wallet but has no card, so a person has to keep refilling its API key.

---

## What it is

A finance lead deposits USDC into a yield vault that belongs to their organization. The vault's shares stay in their wallet. As the vault earns, Inferest opens spending limits on API keys: one key per developer, or one per agent. A key works with any OpenAI-compatible client by changing only the base URL, reaches OpenRouter's models, and opens paid web tools over MCP with the same key. At the end of each period, usage is paid, our fee is taken from what was not used, and the rest goes back to the customer as new principal.

Two doors, one engine:

| | Treasury (leads) | Agents |
|---|---|---|
| Who | An organization with a stablecoin treasury and a team that uses AI | An agent with its own wallet |
| Buyer | Finance lead, CFO, founder | Agent platform or wallet team, developer |
| User | The organization's developers | The agent itself |
| What they get | Per-developer keys funded by interest, a dashboard, monthly settlement | A key that tops itself up from the wallet's yield, no human in the loop |

---

## How it works

1. **Deposit.** The organization deposits USDC into its own ERC-4626 vault (an Octant vault over an allowlisted ERC-4626 yield source such as Fluid USDC). Shares go to the organization's wallet. Principal never leaves it.
2. **Yield accrues.** A keeper reports the vault daily. The ledger reads yield as the vault's value minus principal.
3. **Limits open from earned yield only.** Each key's spending limit opens only up to yield already earned, never ahead of it, so spend can never reach principal.
4. **Keys spend.** Developers or agents call models through our proxy at `/v1` with an Inferest key (`sk-inf-…`). Each call is checked against the key's remaining budget before it runs and metered after it returns. The same key pays for web tools over MCP.
5. **Settle each period.** Usage is paid out to the provider float. Of the yield that was not used, 10% is our fee and the remaining 90% goes back to the customer's wallet as vault shares, where it becomes principal.

**What the customer trusts us with, stated plainly.** Principal stays in the customer's wallet as vault shares. The yield is minted to our Splitter contract as vault shares. At settlement it can pay usage only to our float address and the fee only to our fee address, both fixed at deploy, and it sends the remaining shares back to the customer's wallet as new principal. The fee is capped on-chain at 20%. The provider account (OpenRouter) is prefunded by us, and each settlement repays that float in USDC.

**Why stablecoins.** Stablecoins are what an organization holds to spend, so they are where an AI bill should be paid from, and their yield is predictable enough to plan a budget on. The vault design is plain ERC-4626, so other assets are a configuration and pricing question, not a rebuild.

---

## Who it is for

**Organizations that hold crypto in their treasury and pay for AI.** That is the qualifier. In order of who we sell to first:

1. **Crypto foundations** with a treasury and in-house or grant-funded developers.
2. **Crypto-native startups** that keep part of their runway on-chain.
3. **Companies and institutions starting to hold crypto on the balance sheet**, such as fintechs and listed digital asset treasury companies, for whom earning on that treasury is now the mandate. More than 200 listed companies held digital assets on their balance sheets as of early 2026 ([CoinDesk](https://www.coindesk.com/opinion/2026/04/04/digital-asset-treasuries-must-now-earn-their-keep)).

**The math fits a treasury.** To cover AI spend with yield alone, principal has to be about 23 times the annual budget (at 4.5% APY, with the roughly 5% cost of buying provider credit passed through; `docs/04`). One developer spending $200 a month needs about $56,000 deposited; twenty developers at $500 a month need about $2.8M. For a treasury in the tens of millions that is a fraction of its holdings, and partial coverage still lowers the bill.

**Agents are the second door.** Agent wallets are shipping now (Coinbase launched agent wallets with spend limits in February 2026), but paying for an agent's inference out of its wallet's yield is still empty ground. A $1,000 agent wallet earns about $3.50 of credit a month, so for small agents this is a running-cost subsidy paired with cheap models, not free inference. The engine is the same; the package is an SDK or wallet plugin.

---

## How we make money

**Now: 10% of the yield the customer does not use.** A customer who spends all of its yield pays no fee; one who spends none keeps 90% of it. This fits the customer we lead with: a treasury deposits for the yield first and AI second, so it naturally leaves yield unused. For example, $2.81M earning $126K a year with half of it used pays us about $6,300.

**Next: a margin on inference.** Once we buy capacity from providers directly instead of at list price, the gap between what we pay and the credit we issue is ours. Inference sold forward is already offered at 20 to 30% below market ([Touchmark](https://techfundingnews.com/touchmark-wants-to-turn-ai-inference-into-a-futures-market/)).

The fee rate is a placeholder. In the current build we also absorb the roughly 5% cost of buying provider credit, so the customer gets $1 of credit per $1 of yield.

---

## What else is out there

The idea of turning crypto into AI credit is proven. What is missing is doing it with a stable asset a treasury already holds.

| | What it does | Why it is not Inferest |
|---|---|---|
| [Venice](https://docs.venice.ai/overview/vvv-diem) | Stake its token VVV, mint DIEM; each staked DIEM grants $1 of Venice API credit a day. VVV reached about a $1.5B market cap, the best evidence that people will lock capital to receive inference | You buy and hold Venice's own volatile token, and the credit works only on Venice |
| [iAI by 0G](https://iai.finance/) | Stake 0G, lock the staked 0G to mint iAI; each staked iAI earns about 1.27 compute credits a day, which 0G values at more than $1. Launched September 29, 2026 | Collateral is the network's own token, half the staking yield always goes to the issuer, and credits work only in 0G's own apps |
| Agent wallets (such as Coinbase's) | An agent holds and spends money under spend limits | Spending comes from principal; nothing makes the yield pay for the agent's thinking |
| AI spend tools (Ramp, corporate cards) | Cap and track AI spend per person | In fiat, from the operating account, after the off-ramp: the three steps Inferest removes |

**Inferest's position:** neutral collateral (USDC), any OpenAI-compatible client, the customer keeps all of its yield except our 10% of what goes unused.

---

## The demo

About three minutes, treasury first. Real yield on a demo deposit is cents, so the demo chain moves time forward: months of yield in minutes.

| Time | Page | What happens |
|---|---|---|
| 0:00 to 0:20 | Home | The problem in one line, then the calculator: $100,000 at 4.5% on Kimi K2.6 buys about 208M tokens a month, about 45,700 calls |
| 0:20 to 1:50 | Treasury | A finance lead signs in with an email code and deposits USDC; the principal bar shows the shares in their wallet; yield accrues; they create a key, run one curl call, and the key's row moves; they settle: usage paid, fee taken, the rest stays in the vault |
| 1:50 to 2:40 | Agents | Our hosted agent: a 1,000 USDC book, half parked in its vault (that yield is its budget), half at work on paper trades. A fence it cannot change checks every move. Runs a week apart, each paid for from its own yield, and a month-end settlement |
| 2:40 to 3:00 | Close | The principal never moved. What comes next |

**Try it yourself** (once the public demo is up): open `[public demo URL]`, sign in with an email, click Get demo funds, deposit, create a key, and paste the curl snippet into a terminal. The step-by-step path is in [`07-walkthrough.md`](07-walkthrough.md). Video: `[video link]`.

---

## What's real today

_As of 2026-10-03. Update this box as work ships; the rest of the page should not need to change._

| Area | Today | Next |
|---|---|---|
| Contracts | Built and tested: one vault per customer, the Splitter, the factory, the deploy script | A public demo on a Tenderly Virtual TestNet of Arbitrum One; the real chain is still open |
| Chain | Runs on a local fork of Arbitrum One; no real money has moved | `[public deployment]` |
| Keys and proxy | Built: metered `sk-inf-` keys at `/v1`, paid tools at `/mcp`, real model calls | |
| Treasury page | Built and walked through in a real browser end to end | |
| Agent | Built: own wallet, own vault, fence, real vault moves; trades are paper | Real trades `[when the team ships them]` |
| Provider float | OpenRouter prefunded by us and refilled by hand (OpenRouter has no crypto purchase API) | A card or invoice that refills it automatically |
| Assets | USDC | Other assets through ERC-4626 sources |
| Customers | None yet | Interviews with five treasury organizations |
