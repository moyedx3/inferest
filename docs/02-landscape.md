# Landscape

_Researched 2026-09-25 from each service's own docs, plus the vault company notes `Companies/Orbio.md` and `Companies/Touchmark.md` (verified 2026-09-23)._

**Turning crypto into inference credit is already being done.** Both services that do it (Venice, Orbio) fund the credit with **their own token**. Nobody funds it with neutral yield on blue-chip assets (USDC lending, ETH and SOL staking). That is the differentiation.

| Service | Funded by | Credit rail | Relation to us |
| --- | --- | --- | --- |
| [Venice](https://docs.venice.ai/overview/vvv-diem) (VVV, DIEM) | Locking its own token VVV | Own inference; 1 staked DIEM = $1 of credit per day | Closest in shape. Principal locked, credit recurs, per-key limits |
| [Orbio](https://www.orbio.so/protocol) (ORBIO, CREDIT) | Half of its own token's trading fees | Gateway on Orbio's managed OpenRouter account | Same rail as our hackathon build, opposite funding |
| [Touchmark](https://touchmark.ai/) | Buyer prepayment | Forward blocks on named open-weight models, metered by its router | Our "real product" supply model |
| x402 gateways ([BlockRun](https://pypi.org/project/blockrun-llm/), [ClawRouter](https://github.com/BlockRunAI/ClawRouter)) | USDC in the agent's wallet, per request | Pay per request, wallet signature is the auth | Substitute for ICP2, and a possible output rail |
| [OpenRouter](https://openrouter.ai/docs/guides/overview/auth/management-api-keys) | Card or crypto prepay, web checkout only | Routes hundreds of models | The rail we ride on |

---

## Venice

Venice is a privacy-focused inference provider with its own models and capacity. Its token VVV lives on Base. Staking VVV gives sVVV and earns emissions (14M new VVV a year, starting at 14% inflation and falling) ([Venice](https://venice.ai/blog/introducing-the-venice-token-vvv)). Locking sVVV mints **DIEM**, a tradable ERC-20, and **each staked DIEM grants $1 of Venice API credit every day, for as long as it stays staked** ([Venice docs](https://docs.venice.ai/overview/vvv-diem)).

The credit is capacity, not a balance. It refreshes at 00:00 UTC, and **unused credit does not roll over**. Getting principal back takes two steps: burn the DIEM to unlock the sVVV behind it, then a 7-day unstaking cooldown. VVV reached a market cap of about $1.5B ([Cryptopolitan](https://www.cryptopolitan.com/venice-vvv-token-hits-record-34-as-its-privacy-ai-staking-model-draws-fresh-bets/)), which is the best evidence that people will lock capital to receive inference.

- **Mint Rate:** sVVV required per DIEM rises as DIEM supply grows, so late minters lock more
- **Spend order:** DIEM first, then bundled credits, then USD
- **Per-key limits:** each key can carry an epoch consumption limit in DIEM or USD
- **Agents:** a wallet can mint a key itself (`generate_web3_key`), and x402 USDC top-up exists as a fallback rail
- **Models:** Venice's own catalog only

**Same as us**
- Lock principal, receive credit on a schedule, get principal back
- Per-key spend limits, so one integration cannot drain the allowance
- Built for agents: a wallet can obtain a key with no human

**Different from us**
- **Principal is Venice's own volatile token.** A customer has to buy VVV first and carries its price risk. Ours is USDC
- **The credit is not yield.** It is a claim on Venice's own GPU capacity, which Venice supplies. Ours is paid for by vault interest, bought on an outside rail
- **Fixed dollars, use it or lose it.** $1 per DIEM per day regardless of rates; unused credit disappears. Ours floats with APY, and unused yield comes back to the customer less 10%
- **One provider's models.** Ours reaches OpenRouter's catalog now and contracted open-weight providers later

## Orbio

Orbio is a pseudonymous project on Robinhood Chain that sells **CREDIT**, a token worth exactly $1 of inference through Orbio's gateway ([Orbio](https://www.orbio.so/protocol)). ORBIO holders stake to earn CREDIT, which is minted hourly and funded by half of the fees on ORBIO trading. CREDIT trades on an order book against USDG and in a Uniswap pool against ORBIO, typically 10 to 80% below face. Activating CREDIT burns it into a non-transferable API balance usable across 400+ models, served from **Orbio's managed OpenRouter account**.

The vault's analysis (`Companies/Orbio.md`): the headline discounts only hold for small orders (a $300 order walks the book from 79% to 74% off), and the subsidy stops if ORBIO volume stops. Until mid-September, sellers could also list their own paid OpenRouter, Anthropic or OpenAI keys; that path has since disappeared from the site, which is consistent with a terms-of-service problem.

- **Activation:** one-way, burns CREDIT, cannot be redeemed for cash. `buyAndActivate()` does purchase and activation in one call, so an agent can top itself up
- **Break-even:** buying CREDIT at $0.40 pays off only if at least 40% is used
- **Pairing:** the Uniswap pool is CREDIT/ORBIO, so buying there requires holding ORBIO

**Same as us**
- **The same rail as our hackathon build**: one OpenRouter account behind a gateway, with keys handed out
- An on-chain stream that turns into inference credit with no card
- Agents can fund themselves on-chain

**Different from us**
- **Funded by token trading fees.** No volume, no credit. Ours is funded by interest on USDC, which does not depend on anyone trading anything
- **The credit is a speculative token** whose price floats with ORBIO. Ours is a dollar limit on a key
- **Resale exposure is Orbio's.** Selling access to its own OpenRouter account is still resale under OpenRouter's standard terms. We carry the same exposure in the hackathon build (`05-risks.md`)

## Touchmark

Touchmark (YC S26, live since 2026-08-14) is a forward market for inference. It sells prepaid monthly blocks of 1 billion tokens on a named open-weight model from a named provider, to commercial buyers only ([Touchmark](https://touchmark.ai/)). The further out the delivery month, the larger the discount: 10% per 30 days, capped at 20% on the site (YC materials say up to 30%). Sales are final and undrawn tokens expire at month end.

Its router is the load-bearing piece. The buyer points an OpenAI-compatible base URL at it, and it meters every request against the block at pinned rates, enforces the contract's rate caps, and decides whether a block is still untouched and so resellable. The vault's verification (`Companies/Touchmark.md`) found the posted prices follow the formula to the cent, so the book is computed, not discovered.

- **Unit:** tokens weighted as output 1.0, input 0.32, cache 0.06
- **Break-even:** 20% off requires using at least 80% of the block
- **Resale:** only with provider consent, and only before the first token is consumed
- **Synthetic series:** "Top-1 Coding Model" is bought now and assigned a model about 20 business days before delivery, which only works because the router can re-point

**Same as us**
- Treats inference as a financial product, not a subscription
- **Its supply model is our "real product" plan** (decision 2): contract providers to run open-weight models, sit in the path as the meter
- Buyers are organizations with real AI budgets

**Different from us**
- **The buyer spends principal.** Touchmark is prepay; we never touch principal
- **Expiry vs return.** Unused tokens expire; our unused yield comes back
- No yield, no on-chain component, no agents

## x402 gateways: BlockRun and ClawRouter

x402 is an HTTP payment protocol: the server answers `402 Payment Required`, and the client pays in USDC with a wallet signature, per request. **BlockRun** is a gateway built on it: 80+ chat models plus image, video and data tools, paid per call in USDC on Base or Solana, or with a card-funded API key ([PyPI](https://pypi.org/project/blockrun-llm/)). **ClawRouter** is its open-source local router (MIT, about 6,600 GitHub stars), which picks the cheapest model that can handle each request and settles the bill from the agent's wallet ([GitHub](https://github.com/BlockRunAI/ClawRouter)).

Their pitch is the ICP2 problem stated plainly: *"Agents can't sign up for accounts. Agents can't enter credit cards. Agents can only sign transactions."*

- **No account, no key:** a wallet is generated on first run and its signature is the authentication
- **Free tier:** several open-weight models on NVIDIA hosting cost nothing
- **Routing:** 15-dimension scoring, claims up to 84% savings versus a fixed model
- **Distribution:** ships as an OpenClaw plugin

**Same as us**
- Agent-first: the wallet is the payer, no human in the loop
- Cheap-model routing to stretch the budget

**Different from us**
- **Every request spends the wallet's principal.** Nothing earns while it waits. Ours pays from interest and leaves principal alone
- Per request, not per period: no limits to sync, no settlement, no float

**Why this is a rail, not only a rival:** our yield could top up an agent's x402 wallet instead of an OpenRouter key. The agent keeps using BlockRun or ClawRouter; we make the balance refill itself.

## OpenRouter

OpenRouter is a gateway to hundreds of models from dozens of providers behind one OpenAI-compatible API, billed from a prepaid dollar balance. Its **Management API** creates, updates and deletes API keys programmatically, with a spend limit on each key and optional daily, weekly or monthly resets ([OpenRouter docs](https://openrouter.ai/docs/guides/overview/auth/management-api-keys)). That is everything our key manager needs.

The gap is funding. The programmatic crypto top-up (`POST /api/v1/credits/coinbase`) was removed after Coinbase deprecated the underlying APIs and now returns `410 Gone`; crypto purchases go through the web checkout only ([OpenRouter docs](https://openrouter.ai/docs/cookbook/administration/crypto-api)). And the standard terms prohibit accessing the service *"for purposes of reselling API access to Models or otherwise developing a competing service"* ([OpenRouter terms](https://openrouter.ai/terms)); the enterprise terms allow serving a customer's end customers.

- **Keys:** `POST /api/v1/keys`, `PATCH /api/v1/keys/{hash}` for limits, per-key usage readable
- **Top-up:** manual web checkout, or Auto Top-Up on a saved card
- **Default provider** in agent frameworks such as Hermes Agent and OpenClaw, so an OpenRouter key drops in with no integration

**Same as us**
- It is our rail for the hackathon: every key we issue is an OpenRouter key

**Different from us**
- A gateway, not a funding source. It does not care where the dollars come from; we are the part that makes them come from yield
- **The two things we need from it are the two things it restricts**: automated crypto top-up and resale. Both are covered in `05-risks.md`
