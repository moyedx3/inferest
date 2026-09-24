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

### ICP1: the timing is good

As of early 2026, more than 200 listed companies hold digital assets on their balance sheets, and the conversation has moved from accumulation to generating yield ([CoinDesk](https://www.coindesk.com/opinion/2026/04/04/digital-asset-treasuries-must-now-earn-their-keep)). Inferest is a concrete answer to "what is the yield for."

> Vault note 51 argued the sharper pain is multisig governance, runway burn and no per-person attribution. **Decided 2026-09-24: lead with the fiat/on-chain mismatch and idle yield.** Attribution is a feature the per-key limits give for free.

### ICP2: the infrastructure is already there

Coinbase launched agent-specific wallets in February 2026 with x402 payments and spend limits built in ([Coinbase](https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets)). The agent wallet market is consolidating fast: Privy to Stripe, Dynamic to Fireblocks ([Crossmint comparison](https://www.crossmint.com/learn/agent-wallets-compared)). **Wallets exist. Paying for inference out of wallet money is still an empty slot.**

ICP2 has a sizing problem, covered in [`04-unit-economics.md`](04-unit-economics.md): a $1,000 wallet earns about $3.50 of credit a month, so the pitch is "base running cost subsidy," not "free inference."
