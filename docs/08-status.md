# Status and handoff

_Where the build stands, how to run it, how we work on it, and what is left, so a cofounder or an agent can pick up without asking. Updated 2026-09-27 from `main`. Dates, submission targets and their deadlines live only in `private/events.md`, which is git-ignored; get it out of band._

## What is on main

| Area | State | Where |
|---|---|---|
| Contracts | One Octant ERC-4626 vault per customer over an allowlisted yield source, the Splitter, the factory, tests, the deploy script (`TARGET_VAULTS` allowlists sources) | `contracts/`, `docs/06-workflow.md` |
| Ledger kernel | Pure functions for accrued yield, credit limit, settlement, required principal; tested | `engine/ledger.ts` |
| Proxy and tools | `/v1/chat/completions` with `sk-inf-` keys metered against each key's yield budget; one encrypted OpenRouter key per vault as backstop; paid web tools over MCP at `/mcp` paid in USDC through x402 | `app/server.ts`, `app/proxy.ts`, `app/mcp.ts`, `app/tools.ts` |
| Keeper | Reports each vault daily, keeps the backstop limit in step, settles each period; runs inside `npm run serve` | `app/keeper.ts`, `app/cli.ts` |
| Store | SQLite, schema 4, WAL; `KEY_ENCRYPTION_KEY` required | `app/store.ts` |
| Login | Dynamic email code or wallet; a vault's admin is the login whose verified wallet created it; the operator token stays for us | `app/auth.ts`, spec `docs/superpowers/specs/2026-09-26-wallet-login-design.md` |
| Treasury page | Sign in, demo funds on a fork, deposit, keys with snippets, settle, activity; walked through in a real browser end to end | `app/dashboard/treasury.html`, `app.js`; `docs/07-walkthrough.md` |
| Agents page and runner | A hosted agent with its own wallet, half its book in a vault whose yield is its budget, a fence before every signature, paper trades, runs logged for the public page; `GET /api/agent` | `agent/`, `app/dashboard/agents.*`; spec `docs/superpowers/specs/2026-09-27-agent-page-design.md` |
| Home | Calculator (tested), two use-case doors with a live glimpse of the agent, the How it works step-through | `app/dashboard/home.html`, `home.js`, `calc.js` |
| Design | pen.dev source and PNG exports, the logo, the step-through prototype; the design pass is applied | `design/`, spec `docs/superpowers/specs/2026-09-27-design-pass.md` |
| Docs | Problem, landscape, architecture, unit economics, risks, workflow, walkthrough, deck outline | `docs/01` to `07`, `deck/outline.md` |

Everything above has run only on a local anvil fork of Arbitrum One. Nothing is deployed anywhere public and no real money has moved.

## How to run it

```bash
npm install && npm test && npm run typecheck        # 310 tests, no network
cd contracts && forge test                          # read the Suite result lines; the lint noise above them is upstream
```

A demo needs a fork. Over Arbitrum's public RPC a fork serves state for about thirty minutes after its fork block, so start it right before you need it (an archive RPC or a Tenderly Virtual TestNet has no such limit):

1. `anvil --fork-url https://arb1.arbitrum.io/rpc --port 8545`
2. Deploy with the anvil deployer key and `TARGET_VAULT` plus `TARGET_VAULTS` naming both sources in `config/arbitrum-one.json` (the README's deploy line); this writes `contracts/deployments/42161.json`.
3. Move any old `inferest.db` aside, then `npm run serve` (reads `.env` and then `.env.local`; keep the fork's RPC, keeper key, `DEMO_FAUCET=1` and `PUBLIC_RPC_URL` in `.env.local`).
4. Treasury: open `http://localhost:8787/treasury`, sign in, Get demo funds, deposit, create a key, run the curl snippet, settle. `docs/07-walkthrough.md` is the script.
5. Agents: `AGENT_PRIVATE_KEY=<an anvil test key> AGENT_DEMO_DAYS=7 npm run agent -- --once`, repeated; each run moves the chain clock seven days and every fourth run is a month end. Eight runs take about seven minutes and fill `/agents` and the Home glimpse.

Browser checks in this project were driven with Playwright from a small local script, not a browser tool; screenshots against the PNGs in `design/` are the acceptance test.

## How we work

- One branch per task, a fresh reviewer (a subagent with only the diff and the spec) before merge, merge with `--no-ff` only when the review is clean, scan the commits since `origin/main` for secrets, then push `main`.
- The spec is the authority; the plan argues from it; conflicts resolve toward the spec. Specs and plans live under `docs/superpowers/`.
- Never commit: `.env*` except `.env.example`, `inferest.db*`, `contracts/deployments/*.json` (the `.gitkeep` stays), `app/dashboard/dynamic.bundle.js`, `private/`.
- Never put a submission target's name, a judge's name or a prize in a commit, a doc or a page. They live in `private/`.
- Prose: no em dashes, American spelling, plain sentences. Commit subjects are sentences, not conventional-commit prefixes.
- Several people and agents may use one checkout. Check the branch and the status before any checkout or merge; prefer a worktree.

## What is left

In the order we would do them. Each item is a branch of its own with a review before merge.

1. **A public deployment anyone can click.** A Tenderly Virtual TestNet of Arbitrum One (chain id must stay 42161; the admin RPC URL is the owner's), a host that keeps SQLite on disk and runs two long-lived processes (`npm run serve` with the keeper inside it, and the agent runner under a supervisor), a domain, a Dynamic production environment with that origin allowed, a `KEY_ENCRYPTION_KEY`, an `ADMIN_TOKEN` of 32 characters or more, an OpenRouter float, a funded paid-tools wallet. The deployment record for that chain has to be added with `git add -f contracts/deployments/<chainId>.json`, since fork deployments are ignored. The runner has only ever run on forks.
2. **The demo video.** About three minutes: Home, a deposit and a key on Treasury, the curl call, the Agents page. `docs/07-walkthrough.md` is the script.
3. **The deck.** Design `deck/outline.md` in pen.dev. The outline matches main as of 2026-09-27.
4. **Per-target variants.** Each submission target is a config fork (chain, USDC, yield source) plus a pitch; details and dates are in `private/events.md`. Chain-specific values live in `config/` and the deploy script's env, nothing in code.
5. **Before the agent runs with real money.** The runner safety review (`docs/09-runner-safety-review.md`) found one blocking item: the runner's picture of its vaults and keys lives only in SQLite and is never checked against the chain, so a crash or a receipt timeout can double-deposit, orphan a vault, or sweep a new vault. Fix that first (derive the vault set from `VaultFactory.vaultsOf` at start, record a transaction hash before waiting for its receipt). Then the should-fix list: a single-instance lock, enforcing the book size against a hand-funded wallet, separate env files and a credential scoped to the agent's vaults instead of the operator token, a dust-safe sweep, re-keying at the top of a run, orphan-key cleanup, gas and churn caps, honest failure reporting on the page, caps on paper positions and a sanity check on the model's price. The review's last table lists what the environment must provide.
6. **Before flipping the repository to public.** The readiness review (kept out of the repo because it quotes a private name) found no secret in the working tree or in history. It found: a teammate's first name in an early commit and in the notes (the notes are fixed at HEAD; the early commit needs a history rewrite), 139 commits authored with a machine hostname as the email, 203 commits carrying a session URL trailer, no LICENSE, and the `sources/` notes being private working notes. See the decisions below. Done on the hygiene branch: `.obsidian/` and fork deployments ignored, the name removed at HEAD, two stale "no proxy" lines fixed, a cap on JSON request bodies, a constant-time admin token check. After the flip: rate limits on `/v1`, `/mcp`, `/api/*` and login, a cooldown or operator-only rule on the report and settle routes (any signed-in owner can make the keeper spend gas today), a cap on vaults per session, generic 500 messages, a guard that `PUBLIC_RPC_URL` is never the keeper's admin RPC, a synthetic address in the auth test.
7. **Product gaps deferred by design.** Real swaps instead of paper trades, visitors' own agents on the Agents page, more than one agent, the Treasury cosmetic gap that goes to pen.dev.
8. **Small known gaps.** A live region for the step-through while it autoplays, a guard on the fence's asset list, the top bar with a very long email, calculator edge cases at the slider's ends, `agent_samples` growing without bound, and the interview and rail work in `hackathon/PLAN.md`.

## Decisions waiting on the founders

| Decision | Options | Note |
|---|---|---|
| License | MIT, Apache-2.0, BUSL, or none | No LICENSE means all rights reserved; pick one before the flip |
| History rewrite before the flip | Rewrite (`git filter-repo`) to drop the teammate's name from the early commit, optionally change the author identity on the 139 hostname commits and strip the session trailers from 203; or leave history and only fix HEAD | One rewrite covers all three; it force-pushes `main` and every clone must be re-cloned |
| `sources/` in the public repo | Keep (they are the origin of the docs), or untrack and drop from history in the same rewrite | They are Korean working notes with wiki links to unpublished notes and a stop rule |
| `docs/superpowers/` in the public repo | Keep as design history, or move out and relink the README | The specs are the authority for the pages and the runner |
| Report and settle routes on a real chain | Operator-only unless `DEMO_FAUCET=1`, or a per-vault cooldown | Today any signed-in owner can call them at will |
| Real money | Whether, when, and how big a book; a dedicated wallet key and where it lives | After the first public submission, not before; the safety review's blocking item first |
| The first submission's chain and stablecoin route | See `private/events.md` | Needs a decision this week |
