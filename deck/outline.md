# Inferest: Pitch Deck Outline

_Content spec for design. Every number traces to [`../docs/`](../docs/), [`../engine/ledger.ts`](../engine/ledger.ts) or one of the live pages (`/`, `/treasury`, `/agents`). Nothing on a slide should be invented at design time. Updated 2026-09-27 to what is on `main`._

**Audience:** judges and accelerator reviewers.

**One rule:** each headline is one complete sentence. If a slide needs a paragraph to be understood, the headline is wrong.

---

| # | Section | Headline | Body | Trace |
|---|---|---|---|---|
| 1 | Cover | Inferest | Your interest, now inference. | |
| 2 | Problem | A crypto treasury pays its AI bill in three steps, and each one costs something | sell → off-ramp → card; tax event, fee, delay | `docs/01` |
| 3 | Problem | An agent has a wallet but cannot get a card | a human refills its key | `docs/01` |
| 4 | Proof | Venice proved people will lock principal to receive inference daily | VVV ~$1.5B market cap; 1 DIEM = $1/day | `docs/02` |
| 5 | Gap | Everyone funds it with their own token. Nobody uses neutral yield | landscape table, one column highlighted | `docs/02` |
| 6 | Product | Deposit once; the interest becomes API keys, and what you don't use comes back | the loop diagram from the README; one Inferest key opens OpenRouter's models at `/v1` and the paid tools at `/mcp` | README |
| 7 | Demo: Treasury | A finance lead signs in with an email code, deposits once, and hands out keys that spend only interest | the live `/treasury` page: the hatched principal bar, the yield counter accruing at Fluid USDC's floating rate (about 4.1% on the fork on 2026-09-27, shown in the sources list on `/agents`; about $340 a month on $100,000 at that rate), a new key and the curl call that moves its row, "If you settle now", then the settlement under Activity | `docs/07`, `/treasury`, `/agents` |
| 8 | Demo: Agent | Our agent pays for its own thinking, and a fence it cannot change signs off every move | the live `/agents` page: a 1,000 USDC book, 500 parked in its vault (that yield is its budget), 500 at work; the fence card (vault floor 200 USDC, one split move and one source move per run, ETH, BTC and ARB, at most three trades per run, a buy at most 20% of the working half, four paid tool calls per run); run cards a week apart on the fork; the month-end settlement. Observed on the fork run of 2026-09-27: each run cost about a cent of models and tools and the agent held one paper ETH position | `docs/07`, `/agents`, `agent/fence.ts` |
| 9 | Economics | A deposit of about 23 times the annual AI budget covers it entirely | unit economics table; the calculator on Home does the same sums live: $100,000 at 4.5% on Kimi K2.6 is 208M tokens a month, about 45,700 calls | `docs/04`, `app/dashboard/calc.js` |
| 10 | Custody | Principal never leaves the customer's wallet | built: one Octant ERC-4626 vault per customer, shares in the customer's wallet, profit minted to our Splitter, which spends only usage + fee; a key's limit opens only on yield already earned | `docs/06`, `contracts/` |
| 11 | Next | Five treasury interviews, one rail contract, one real book on Arbitrum One | a public testnet anyone can try, the agent on a small real book with real swaps, then the first non-custodial pilot | `hackathon/PLAN.md` (interviews, rail), README "Not built (yet)" (testnet, real book, swaps) |

Float top-up, speaker note for slides 6 and 10: OpenRouter is prefunded by us, and settlement sends each month's usage in USDC to our float wallet. Refilling OpenRouter from that wallet is manual today, because OpenRouter has no crypto purchase API, only a hosted checkout. Production phase: a programmable card funded from the float wallet pays that checkout automatically, or an enterprise invoice replaces the prepayment.

Keys, speaker note for slides 6 and 7: developers get Inferest keys, not provider keys. Our proxy checks the key's yield budget before each call and meters the cost after; one OpenRouter key per vault sits behind it with its limit held at the vault's open credit as a backstop. A client changes only its base URL, and the same key opens the paid tools over MCP.

Login, speaker note for slide 7: the finance lead signs in with an email code or the treasury wallet through Dynamic; the vault's admin is whoever's wallet created it, verified from Dynamic's token on our server. No operator token in the demo path.

The fence, speaker note for slide 8: the model never signs anything. It returns one decision; the fence in `agent/fence.ts` validates it against the runner's limits, the runner signs what survives with the agent's own wallet, and anything refused is logged on the page in red. The split and source moves are real transactions. The trades are paper for now, marked at the price the agent reports from its research (the prompt tells it to fetch one through a paid tool, and the fence only checks that it is above zero); real swaps are the next step. On the demo fork the chain clock moves seven days before each run so a month of runs fits in minutes.
