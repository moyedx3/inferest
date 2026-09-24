# Problem and Customers

_Source: [`../sources/yield-to-inference-2026-09-24.md`](../sources/yield-to-inference-2026-09-24.md), researched 2026-09-24._

---

## The problem

Principal stays in a yield vault. Only the interest converts into LLM API credit, delivered as a key. Positioning: **use now, pay with yield.**

**Operating expenses go out in fiat. The treasury sits on-chain.** So an organization with a crypto treasury pays for AI in steps:

1. Sell crypto and off-ramp
2. Move the fiat to the operating account
3. Top up credits by card

Each step adds a tax event, a conversion fee or an approval delay. Meanwhile the idle treasury earns yield that never reaches the AI bill.

**Autonomous agents are blocked harder.** They hold on-chain wallets but have no card, so a person has to fund their API key for them to keep running.

The engine solves two things: it makes treasury to AI spend **one stop**, and it pays for the spend with **the idle assets' yield** instead of principal. Yield the customer does not use comes back, less a 10% fee.

---

## Two customers, one engine

The same engine is packaged twice. ICP1 is direct B2B sales. ICP2 is B2B2C through agent platforms.

| | ICP1: crypto treasury organizations | ICP2: agent wallet and financial agent teams |
|---|---|---|
| Examples | Listed digital asset treasury companies, foundations like Solana, validator operators, crypto-native startups | Trading and perp agents, agent wallet SDKs, users of agent frameworks like OpenClaw |
| Buyer | CFO, finance lead | Agent platform PM, developer |
| User | In-house developers | The agent itself |
| Core value | AI spend straight from treasury with no off-ramp, offset by interest | The agent tops up its own inference from its wallet's yield with no human in the loop |
| Package | Dashboard plus per-developer API keys | SDK or plugin plus per-agent keys |

### ICP1: two trends meet

**Treasuries have moved on-chain and now have to earn.** As of early 2026, more than 200 listed companies hold digital assets on their balance sheets, and the conversation has moved from accumulation to generating yield ([CoinDesk](https://www.coindesk.com/opinion/2026/04/04/digital-asset-treasuries-must-now-earn-their-keep)).

**AI spend per employee has become a real budget line.** 
- Across businesses on Ramp's token spend product, token usage grew 1,001% and spend 497% from January 2025 to April 2026; median spend was $46 per employee per month, and $442 at companies using 26 or more models ([Ramp](https://ramp.com/blog/ai-token-cost-for-businesses)). 
- At the high end it is larger still: one seed-stage AI infrastructure startup went from about $200 to $3,000 per developer per month in six months ([The Pragmatic Engineer](https://blog.pragmaticengineer.com/the-pulse-token-spend-breaks-budgets-what-next/)). 
- Uber used up its full-year AI coding budget by April, and Meta's Adam Mosseri expects engineers' token spend to approach their salaries within a year or two, with per-engineer caps to follow ([TechCrunch](https://techcrunch.com/2026/07/14/metas-adam-mosseri-says-ai-token-budgets-could-soon-be-capped-per-engineer/)).

**Inferest sits where the two meet**: an organization whose idle assets are on-chain and whose fastest-growing expense is AI. It gives the yield a job, and it gives per-person AI budgets a cap that is enforced by the key itself.

### ICP2: the infrastructure is already there

**Agents that act for people are shipping now.** 
- Meta launched Muse on September 8, 2026: it books travel, fills out forms, negotiates bills and keeps working after the app is closed, paying through Stripe's Link and one-time cards ([Meta](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)). 
- Instinct, a text-message agent still in private beta, passed 100,000 users and raised at a $2.5B valuation ([CellCog](https://cellcog.ai/blog/what-is-instinct-ai/)). 

None of these is a financial agent, and a mainstream agent that manages its own on-chain capital does not exist yet. **Our bet: when it arrives, it can pay for its own thinking.** An agent holding a balance in a vault funds its inference from the yield, with no human topping up its key.

**Wallets are ready for it.** 
- Coinbase launched agent-specific wallets in February 2026 with x402 payments and spend limits built in ([Coinbase](https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets)). 
- The agent wallet market is consolidating fast: Privy to Stripe, Dynamic to Fireblocks ([Crossmint comparison](https://www.crossmint.com/learn/agent-wallets-compared)). 

**Wallets exist. Paying for inference out of wallet money is still an empty slot.**
