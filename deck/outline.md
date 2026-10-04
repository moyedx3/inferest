# Inferest: Pitch Deck Outline

_Content spec for design and for the pitch video. Every number traces to [`../docs/`](../docs/), [`../engine/ledger.ts`](../engine/ledger.ts), [`../contracts/deployments/arbitrum-one.json`](../contracts/deployments/arbitrum-one.json) or one of the live pages (`/`, `/treasury`, `/agents`). Nothing on a slide should be invented at design time. The story follows [`../docs/10-about.md`](../docs/10-about.md). Updated 2026-10-05 to what is on `main`._

**Audience:** judges and accelerator reviewers.

**One rule:** each headline is one complete sentence. If a slide needs a paragraph to be understood, the headline is wrong.

**Pitch video:** about three minutes. The "Say" line under each slide is the spoken part; read it as written or in your own words. Slides 8 and 9 are screen recordings of the live pages, taken from the demo video.

---

| # | Section | Headline | Body | Trace |
|---|---|---|---|---|
| 1 | Cover | Inferest | Your interest, now inference. Under it: "Pay for AI with the interest on your stablecoins." | `docs/10` |
| 2 | Why | Our developers kept asking for more LLM credits | Every request was the same loop: someone asks, someone approves, someone tops up a card. We wanted that budget to fund itself | `docs/10` "Why we built it" |
| 3 | Problem | A crypto treasury pays its AI bill in three steps, and each one costs something | sell or off-ramp → move fiat to the operating account → top up by card; a tax event, a fee, a delay. Meanwhile the USDC earns yield that never reaches the bill | `docs/01` |
| 4 | Problem | AI spend has become a real budget line | token spend up 497% and usage up 1,001% from January 2025 to April 2026 on Ramp; $442 per employee a month at companies using 26+ models; Uber spent its full-year AI coding budget by April | `docs/01` (Ramp, TechCrunch) |
| 5 | Product | Deposit once; the interest becomes API keys, and the principal never moves | the loop: deposit USDC into your own vault → yield accrues → limits open on earned yield only → keys spend through one base URL → settle monthly. One Inferest key opens OpenRouter's models at `/v1` and paid tools at `/mcp` | README "The loop", `docs/10` |
| 6 | Custody | Principal never leaves the customer's wallet | one Octant ERC-4626 vault per customer, shares in the customer's wallet. Yield is minted to our Splitter, which can pay usage only to our float and the fee only to our fee address, then sends the leftover shares back to the customer. The fee is capped on chain at 20% | `docs/06`, `contracts/src/Splitter.sol` |
| 7 | Live | It is live on Arbitrum One mainnet | VaultFactory, Splitter and the strategy implementation deployed 2026-10-04, verified on Sourcify (exact match); a pilot vault over Fluid USDC; 21 contract tests and 342 app tests in CI on every pull request | `contracts/deployments/arbitrum-one.json`, `.github/workflows/ci.yml` |
| 8 | Demo: Treasury | A finance lead signs in with an email, deposits once, and hands out keys that spend only interest | the `/treasury` page: the hatched principal bar, yield accruing, a new key, the curl call that moves its row, "If you settle now", the settlement under Activity. Recorded on a fork so a month passes in seconds | `docs/07`, `/treasury` |
| 9 | Demo: Agent | An agent pays for its own thinking, and a fence it cannot change checks every move | the `/agents` page: a 1,000 USDC book, 500 parked in its vault (that yield is its budget), 500 at work on paper trades; the fence card; run cards a week apart; the month-end settlement. Each run costs about a cent of models and tools | `docs/07`, `/agents`, `agent/fence.ts` |
| 10 | Customers | We sell to organizations that hold crypto in their treasury and pay for AI | first crypto foundations, then crypto-native startups, then companies starting to hold crypto on the balance sheet (200+ listed companies hold digital assets). Agents with wallets are the second door, sold through wallet platforms | `docs/10`, `docs/01` (CoinDesk) |
| 11 | Economics | A deposit of about 23 times the annual AI budget covers it entirely | one developer at $200 a month needs about $56,000; twenty at $500 need about $2.8M, a fraction of a treasury in the tens of millions. The Home calculator does the sums live: $100,000 at 4.5% on Kimi K2.6 is about 208M tokens a month | `docs/04`, `app/dashboard/calc.js` |
| 12 | Revenue | We earn 10% of the yield a customer does not use, and a margin on inference next | a treasury deposits for yield first and AI second, so it leaves yield unused: $2.81M with half its yield used pays about $6,300 a year. Next, buying capacity from providers directly; inference sold forward is offered 20 to 30% below market (Touchmark) | `docs/04`, `docs/10` |
| 13 | Landscape | Others turn their own token into AI credit; we use the stablecoins a treasury already holds | Venice (stake VVV, $1 of credit a day per DIEM, about $1.5B market cap) and iAI by 0G (stake 0G, about 1.27 credits a day, half the yield to the issuer, credits only in 0G apps) prove the demand. Agent wallets spend principal; AI spend tools work in fiat after the off-ramp | `docs/10` "What else is out there" |
| 14 | Next | A public app anyone can try, the agent on a real book, five treasury interviews | the hosted dashboard on the mainnet contracts; the agent with a small real book and real swaps after the runner safety fixes; interviews with five foundations and startups; other assets through ERC-4626 sources | `docs/08`, `docs/09`, `hackathon/PLAN.md` |

---

## Say (pitch video, about three minutes)

1. "Inferest. Your interest, now inference."
2. "Our developers kept asking for more LLM credits. Every time, someone approved it and someone topped up a card. We wanted that budget to pay for itself."
3. "Teams that hold their treasury on-chain have it worse. To pay an AI bill they off-ramp, move the money, and pay by card. All the while, their USDC earns yield that never touches the bill."
4. "And that bill keeps growing. Across Ramp's customers, spending on AI tokens grew almost five hundred percent in fifteen months."
5. "So: deposit USDC once. The interest becomes API keys for your developers. The principal stays where it is."
6. "It stays in your wallet. Our Splitter contract can only pay for what you used and our fee, and everything else goes back to you."
7. "And it's live. The contracts are on Arbitrum One mainnet, verified."
8. "Here's the finance lead's view. Sign in, deposit, and a month later the yield has opened limits on the keys. A developer changes one base URL and calls a model. At month end we settle."
9. "The same engine works for agents. Ours parks half its book in a vault and pays for its own thinking from the yield. A fence it can't change checks every move."
10. "We're selling first to crypto foundations and crypto-native startups. They hold stablecoins, and their AI bills are growing."
11. "The math works for a treasury. About twenty-three times your annual AI budget covers it entirely."
12. "We take ten percent of the yield you don't use. Treasuries deposit for yield first, so most of them leave some unused."
13. "Venice and 0G showed people will lock capital to get AI credit, but you have to hold their token. We use the stablecoins you already have."
14. "Next: the public app, our agent on a real book, and five treasury pilots. Inferest."

---

Float top-up, speaker note for slides 5 and 6: OpenRouter is prefunded by us, and settlement sends each month's usage in USDC to our float wallet. Refilling OpenRouter from that wallet is manual today, because OpenRouter has no crypto purchase API, only a hosted checkout. Production phase: a programmable card funded from the float wallet pays that checkout automatically, or an enterprise invoice replaces the prepayment. Total OpenRouter spend is capped in the server.

Keys, speaker note for slides 5 and 8: developers get Inferest keys, not provider keys. Our proxy checks the key's yield budget before each call and meters the cost after; one OpenRouter key per vault sits behind it with its limit held at the vault's open credit as a backstop. A client changes only its base URL, and the same key opens the paid tools over MCP.

Login, speaker note for slide 8: the finance lead signs in with an email code or the treasury wallet through Dynamic; the vault's admin is whoever's wallet created it, verified from Dynamic's token on our server. No operator token in the demo path.

Mainnet, speaker note for slide 7: this is a supervised pilot. The server admits one customer wallet, keeper transactions can be run by hand, and there is a gas reserve and a per-transaction cost cap. One address holds the owner, keeper, float, fee and emergency roles for now. The hosted app is not public yet; the demo is recorded on a fork of Arbitrum One.

The fence, speaker note for slide 9: the model never signs anything. It returns one decision; the fence in `agent/fence.ts` validates it against the runner's limits (vault floor 200 USDC, one split move and one source move per run, ETH, BTC and ARB, at most three trades per run, a buy at most 20% of the working half, four paid tool calls per run), the runner signs what survives with the agent's own wallet, and anything refused is logged on the page in red. The split and source moves are real transactions. The trades are paper for now, marked at the price the agent reports from its research; real swaps are the next step. On the demo fork the chain clock moves seven days before each run so a month of runs fits in minutes.
