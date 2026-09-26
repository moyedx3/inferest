# Inferest: Pitch Deck Outline

_Content spec for design. Every number traces to [`../docs/`](../docs/) or [`../engine/ledger.ts`](../engine/ledger.ts). Nothing on a slide should be invented at design time._

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
| 6 | Product | Deposit once; the interest becomes API keys, and what you don't use comes back | the loop diagram | README |
| 7 | Demo | live | Treasury: $100,000 deposited, 6 months, $2,225 of credit across 3 keys, assuming 4.5% APY; $500 used, $1,553 returned, principal $101,553. The live Fluid USDC vault pays about 4.1% today, about $2,060 over six months. Agent: pays its own models and tools from its own yield | `hackathon/PLAN.md` |
| 8 | Economics | A deposit of about 23x the annual AI budget covers it entirely | unit economics table | `docs/04` |
| 9 | Target | Principal never leaves the customer's wallet | Octant YDS target architecture | `docs/03` |
| 10 | Next | Five treasury interviews, one rail contract, one non-custodial pilot | | `hackathon/PLAN.md` |

Float top-up, speaker note for slides 6 and 9: OpenRouter is prefunded by us, and settlement sends each month's usage in USDC to our float wallet. Refilling OpenRouter from that wallet is manual today, because OpenRouter has no crypto purchase API, only a hosted checkout. Production phase: a programmable card funded from the float wallet pays that checkout automatically, or an enterprise invoice removes the float entirely.

Keys, speaker note for slides 6 and 7: developers get Inferest keys, not provider keys. Our proxy checks the key's yield budget before each call and meters the cost after; one OpenRouter key per vault sits behind it with its limit held at the vault's open credit as a backstop. A client changes only its base URL, and the same key opens the paid tools over MCP.

Login, speaker note for slide 7: the finance lead signs in with an email code or the treasury wallet through Dynamic; the vault's admin is whoever's wallet created it, verified from Dynamic's token on our server. No operator token in the demo path.
