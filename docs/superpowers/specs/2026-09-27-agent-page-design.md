# Agent page design

_A hosted financial agent that pays for its own thinking from its own capital, shown live on an Agents page, with Home and Treasury beside it. Functional first, in the Treasury page's visual system; the design pass comes from pen.dev once the page works, as it did for Treasury._

## Goal

One thesis, two doors. Inferest is the rail that turns a wallet's yield into inference credit. The Treasury page is the product a finance lead can use today. The Agents page is the proof of the claim that makes the design necessary: an agent with a wallet cannot get a card, so it funds its own model and tool calls from the interest its capital earns, and no human tops anything up.

The demo agent is a showcase customer, not the product. It is a financial agent with a 1,000 USDC book: half parked in its Inferest vault, whose yield is its thinking budget, and half at work. Every run it reads its book, researches with paid tools, decides how much to park, which yield source to park in, and what to buy or sell, then acts within a fence it cannot change. The page shows the runs, the spend drawn from yield, the moves with their transactions, and each settlement.

## Site shape

| Path | Page | Notes |
|---|---|---|
| `/` | Home | The current signed-out hero and its three facts, plus two doors: "For treasuries" to `/treasury` and "For agents" to `/agents`. No sign-in card. |
| `/treasury` | Treasury | The page that is `/` today, unchanged, including its sign-in card and the `#use-a-key` anchor. `/setup` redirects to `/treasury#use-a-key`. |
| `/agents` | Agents | Public. Anyone can watch; nothing on it needs a session. |

The top bar on all three carries the wordmark and three links, Home, Treasury, Agents. Treasury and Agents also carry the network pill, and Treasury the account. Home loads no script and has no pill. Files: `app/dashboard/home.html`, `treasury.html` (today's `index.html`), `agents.html`, `agents.js`, one shared `styles.css`. `serveStatic` maps the three clean paths and keeps serving the existing assets.

## The agent

- **Book.** 1,000 USDC to start. The parked half sits in the agent's Inferest vault over one of the allowlisted yield sources. The working half is USDC in the wallet plus paper positions.
- **Floor.** The vault never goes below 200 USDC, so the agent can always think.
- **Three decisions per run.** The split (deposit, withdraw, or hold, with an amount). The yield source (stay, or move to another allowlisted vault). Trade calls on the working half (buy or sell ETH, BTC, or ARB against USDC, with a size, the price it used, and one sentence of reasoning).
- **Step one is paper for trades only.** Split moves and source moves are real transactions signed by the agent's wallet. Trade calls are recorded as paper positions marked at the price the agent fetched. Step two, out of scope here, executes them as small swaps on the chain's pools.
- **Wallet.** A hosted hot wallet from `AGENT_PRIVATE_KEY`, funded by the operator on a real chain and by the faucet cheat on a fork. On a fork, the first start funds an empty wallet through the faucet and then transfers every USDC above `AGENT_BOOK_USDC` to the dead address, so the wallet holds exactly the book the prompt describes; the transfer is logged as a `sweep` action. This never happens on a real chain.

## One run

1. **Read the book, no model.** From the chain with the agent's wallet: USDC in the wallet, shares and value in the current Inferest vault, and the share price of every allowlisted target (`convertToAssets(1e18)` on the ERC-4626 target itself, not the Inferest vault, so a small growth still shows in the sample). The runner stores the share prices as samples with the chain's timestamp, and each source's annualized rate is derived from its last two samples: `(p1 / p0 - 1) * (365 days / (t1 - t0))`. With one sample the rate is unknown and the agent stays. It also reads its open paper positions and their last marks.
2. **Think, the only model calls.** One chat loop through the proxy on the agent's own Inferest key with the MCP tools attached (`search_tools`, `tool_details`, `run_tool`), plus one local function tool, `decide`, whose arguments are the decision. The loop ends when the model calls `decide`, or after `AGENT_MAX_TURNS` turns, or after `AGENT_MAX_TOOL_CALLS` paid tool calls. Only `run_tool` calls count toward `AGENT_MAX_TOOL_CALLS`; `search_tools` and `tool_details` are free. When that cap or the last allowed turn is reached, the loop makes one final call that offers only `decide` with `tool_choice` forced to it, and the run ends with that decision if it is valid, or without a decision otherwise. The system prompt states the role, the book, the rules, the allowed actions, and that the note must be under 120 words. A decision is `{ note, split: { action: "deposit" | "withdraw" | "hold", amountUsdc }, source: { action: "stay" | "move", target }, trades: [{ side: "buy" | "sell", asset: "ETH" | "BTC" | "ARB", sizeUsdc, price, reasoning }] }`.
3. **Act, no model, the runner is the fence.** Each part of the decision is checked against the rules below. Anything outside is dropped and logged as a refused action with the reason; the rest is executed. A split move is an approve and deposit, or a redeem, on the current vault. A source move is: redeem all principal from the current vault, create a vault over the new target through the Factory with the agent's wallet (or reuse one the agent already has over that target), accept management, approve, deposit, register it through `POST /api/vaults`, mint a key on it through `POST /api/keys`, and revoke the old vault's key. The old vault's yield already in the Splitter settles at month end and returns to the agent's wallet as shares of that vault; the runner redeems any such shares at the start of its next run. Trade calls open or close paper positions.
4. **Log.** One row per run with the book before and after, the decision, the note, the status, and the run window; one row per action with its transaction hash. Model and tool cost per run are not computed by the runner: the server joins the store's existing model and tool call rows on the agent's key ids and the run window.

**Cadence and the clock.** The runner sleeps `AGENT_INTERVAL_MS` between runs. On a fork or a Tenderly testnet (`AGENT_DEMO_DAYS` above zero) it first advances the chain clock by that many days through the chain's time-travel method and mines a block, so yield accrues and the rates diverge; every fourth run is month end and the runner calls `POST /api/admin/settle` for its vaults. On a real chain `AGENT_DEMO_DAYS` is zero, time is real, and the keeper settles as it does today.

**Two moments the page keeps.** A 402 from the proxy ends the run with status `out_of_budget` and the note "out of thinking budget until yield accrues". A split that would leave the vault under the floor is refused with "no room to think".

## The fence

Rules the model cannot change, applied by the runner before any signature:

- The vault's value after a split move is at least `AGENT_FLOOR_USDC`.
- A deposit is at most the wallet's USDC; a withdrawal is at most the vault's value minus the floor.
- At most one split action and one source action per run.
- A source target must be in the allowlist and differ from the current one. A move to a source whose rate is still unknown (fewer than two samples at different times) is refused with "rate unknown yet".
- Trades: asset in ETH, BTC, ARB; at most three per run; a buy at most `AGENT_TRADE_CAP_BPS` of the working half's USDC; a sell at most the open position in that asset; price above zero.
- At most `AGENT_MAX_TOOL_CALLS` paid tool calls per run; the key's own budget bounds the model calls.

## Architecture

The runner is a separate program that talks to the server only through its public surface, so it is exactly what an outside customer would run, and it doubles as the reference implementation for "run this with your own agent".

- **Program.** `agent/run.ts`, with `agent/book.ts` (chain reads and samples), `agent/think.ts` (the loop and the `decide` tool), `agent/fence.ts` (pure validation), `agent/act.ts` (transactions and the operator calls), `agent/log.ts` (its tables). Started with `npm run agent` beside `npm run serve`; `--once` runs a single run and exits.
- **Surface it uses.** The proxy at `/v1/chat/completions`, the MCP endpoint at `/mcp`, and, with `ADMIN_TOKEN`, `POST /api/vaults`, `POST /api/keys`, `POST /api/keys/:id/rotate`, `POST /api/keys/:id/revoke`, `POST /api/admin/settle`, and `POST /api/admin/report` for its own vault after moving a fork's clock; the public `GET /api/agent` for its log line. The chain through `RPC_URL`.
- **Key handling.** The agent's Inferest key is never stored. On every start the runner rotates the key of its current vault and keeps the fresh secret in memory; the key id lives in `agent_meta`. On first start it creates its vault, registers it, and mints the key.
- **Tables.** Owned and created by the runner in the same SQLite file as the store, all prefixed `agent_`: `agent_meta(k, v)` for the current vault, key id, and vaults per target; `agent_samples(at, target, share_price)`; `agent_runs(id, started_at, finished_at, clock_at, status, note, book_before, book_after, decision, error)`; `agent_actions(id, run_id, kind, detail, tx)` with kinds `deposit`, `withdraw`, `move_source`, `paper_open`, `paper_close`, `sweep`, `refused`; `agent_positions(id, opened_run, closed_run, asset, side, size_usdc, entry_price, mark_price, close_price)`. The runner reads no other table. The store's migration leaves `agent_` tables alone. The server also creates the `agent_` tables at startup through `openAgentLog`, so the endpoint never meets a missing table, and that switches the file to WAL.
- **Server.** `GET /api/agent`, public, no auth, answers `{ agent: { address, vault, source: { target, name }, period, runCount }, book: { walletUsdc, vaultValue, floor, positions }, budget, sources: [{ target, name, rate, current }], runs: [{ id, startedAt, finishedAt, clockAt, status, note, decision, actions, cost: { models, tools } }], settlements }`, where `budget` is the agent vault's entry as `/api/state` builds it and `runs` holds the latest 50. `settlements` covers every vault the agent has used, from the `vaultsByTarget` meta plus the current vault, so settlements survive a source move. It answers 404 when no agent has registered. The chain adapter gains `targetOf(vault)`, but the endpoint reads the current source from the `source` meta.

## Yield sources

`config/arbitrum-one.json` gains `targets: [{ address, name }]`: Fluid USDC plus one or two more live ERC-4626 USDC vaults on Arbitrum One, verified on the fork at implementation time. `target` and `targetName` stay as the default the Treasury page creates over. The deploy script reads `TARGET_VAULTS` (comma separated) and allowlists each, writing `targets` into the deployment file as well. The server refuses a deployment whose targets are not a superset of the config's, and exposes `targets` in its public config.

## The page

Sections, top to bottom, all in the Treasury system's plain cards:

- **Tag and headline.** "Agent · run N · period M", a live chip, the agent's short wallet address. "It pays for its own thinking." / "1,000 USDC. Half parked, half at work. The interest funds the model."
- **The book.** A segmented bar of parked versus working with the floor as a thin line; under it the parked half (source and value) and the working half (USDC and the open paper positions with size, entry, mark, and unrealized change).
- **The budget.** The Treasury page's yield card as is: yield this period, Used split into models and tools, open credit, provider backstop, and the settle preview.
- **Runs.** Newest first. Each card: the clock date, the note, the actions with transaction links and any refused with their reason, the tool calls made, and the run's cost in models and tools. A run in progress shows "thinking". A run that ended on 402 shows its note.
- **Yield sources.** The allowlisted vaults with their derived rates and a mark on the current one.
- **Activity.** Settlements and the agent's on-chain moves, the Treasury page's feed component.
- **Run this with your own agent.** The OpenClaw, Hermes, and MCP snippets from the Treasury page with the placeholder key, a link to `/treasury#use-a-key` to get a key, and a link to `agent/` as the reference implementation.

The page polls `/api/agent` every ten seconds and refreshes in place. Agents loads no Dynamic bundle; Home loads no script at all.

## Configuration

New: `AGENT_PRIVATE_KEY`, `AGENT_BOOK_USDC` (1000), `AGENT_FLOOR_USDC` (200), `AGENT_INTERVAL_MS` (600000), `AGENT_DEMO_DAYS` (7 on forks, 0 on real chains), `AGENT_MODEL` (defaults to `DEMO_MODEL`), `AGENT_MAX_TURNS` (10), `AGENT_MAX_TOOL_CALLS` (4), `AGENT_TRADE_CAP_BPS` (2000), `TARGET_VAULTS` for the deploy script. Reused: `RPC_URL`, `API_URL`, `ADMIN_TOKEN`, `DB_PATH`, `CHAIN_CONFIG`, `DEPLOYMENTS`. All documented in `.env.example`.

## Testing

- Unit, `agent/test/`: the fence over the floor, the caps, the allowlist, the assets, and the per-run limits, including a decision that is partly refused; the rate from two samples and unknown from one; the decision parser rejecting a malformed `decide` call.
- Unit, `app/test/`: the per-run spend join over model and tool rows inside and outside a window; `GET /api/agent` with a fake store, including 404 before registration; the three page routes and the moved `/setup` redirect; public config carrying `targets`.
- The think loop with a fake fetch that answers a tool call, then a `decide` call, the way the proxy tests fake OpenRouter; and one that answers 402.
- Smoke: `npm run agent -- --once` against a fresh fork after `npm run demo:treasury` warmed it, then a browser walkthrough of `/agents` showing that run, a second run after the clock moved, and a settlement.

## Out of scope

Real swaps (step two). Visitors' own agents on the page. More than one agent. A design pass, which follows in pen.dev. Any change to the Treasury page beyond its path and the top bar.
