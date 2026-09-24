# Inferest: Pitch Deck Outline

_Content spec for design. Every number traces to [`../docs/`](../docs/) or [`../engine/ledger.ts`](../engine/ledger.ts). Nothing on a slide should be invented at design time._

**Audience:** hackathon judges (track undecided, see [`../hackathon/PLAN.md`](../hackathon/PLAN.md)), accelerator applications after that.

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
| 7 | Demo | live | $100,000 deposited, 6 months, $2,225 yield, $2,114 of credit across 3 keys; $500 used, $1,529 returned, principal $101,529 | `hackathon/PLAN.md` |
| 8 | Economics | A deposit of about 23x the annual AI budget covers it entirely | unit economics table | `docs/04` |
| 9 | Target | Principal never leaves the customer's wallet | Octant YDS target architecture | `docs/03` |
| 10 | Next | Five treasury interviews, one rail contract, one non-custodial pilot | | `hackathon/PLAN.md` |
