# Runner safety review: the hosted agent on Arbitrum One with real money

_A read-only review made on 2026-09-27 against `main` at 6f50e85, before the runner ever touched a real chain. Findings are ordered by severity; the last table lists what a real-chain start needs. `docs/08-status.md` says which of these are done. Line numbers refer to that commit; `app/config.ts` and the top of `app/server.ts` have moved a few lines since. After this review, `contracts/deployments/*.json` became git-ignored on purpose, and a real-chain deployment record is added with `git add -f`, which replaces finding 13's last sentence and the table's note on `DEPLOYMENTS`._

Scope: `agent/*.ts`, `app/server.ts`, `app/keeper.ts`, with `app/tools.ts`, `app/proxy.ts`, `app/limits.ts`, `app/cli.ts`, `app/faucet.ts`, `contracts/src/VaultFactory.sol` and the spec (`docs/superpowers/specs/2026-09-27-agent-page-design.md`) read for context. Reviewed on `main` at 6f50e85. Read only. `agent/test/*.test.ts` passes (25 of 25, `node --test --test-timeout=60000 --test-force-exit`).

## Safe today

The model cannot send USDC anywhere except the agent's own vaults and back. Every signed call is one of these: `redeem` or `withdraw` with the agent as receiver and owner (`agent/run.ts:162`, `agent/act.ts:114`, `agent/act.ts:163`), `approve` and `deposit` into a vault taken from the factory's `VaultCreated` event or the runner's own meta (`agent/act.ts:99-104`, `agent/act.ts:120-122`, `agent/act.ts:139`, `agent/act.ts:145`), `createVault` over a target that the fence checks against the allowlist (`agent/fence.ts:25-29`) and that the factory checks again on chain (`contracts/src/VaultFactory.sol:60`), and `acceptManagement`. The only transfer to a third party is the demo burn to the dead address (`agent/run.ts:101`). That burn runs only after the faucet succeeded, and both need `AGENT_DEMO_DAYS > 0` and an empty wallet (`agent/run.ts:96`). The clock move and `POST /api/admin/report` return early at `AGENT_DEMO_DAYS <= 0` (`agent/run.ts:119`), and the runner's month-end settle also needs a moved clock (`agent/run.ts:204`). The fence keeps deposits within the wallet and withdrawals above the floor (`agent/fence.ts:22-23`). Model and tool spend are capped by the key's share of the vault's yield: the proxy returns 402 at zero remaining (`app/proxy.ts:117-121`), the OpenRouter backstop limit sits at usage plus open credit (`app/keeper.ts:63-81`), and each paid tool call is capped at the key's remaining tool budget (`app/tools.ts:78-80`). Secrets stay out of the model's context, the run log and the public endpoint. So the worst case for principal is the risk of the yield sources plus gas. The problems are elsewhere. The runner trusts SQLite over the chain, which can orphan or double-park funds after a crash. Nothing stops two runners from racing on one key. And several failure modes stop the agent quietly or show the wrong thing to the human watching.

## Findings

### 1. The runner's state lives only in SQLite and is never reconciled with the chain (blocking before real money)

Evidence: `agent/run.ts:83-111`, `agent/act.ts:118-159`, `agent/act.ts:167-177`, `agent/run.ts:155-165`, viem's `waitForTransactionReceipt` (default timeout 180 s).

Scenarios. (a) First start, the deposit is mined, then `waitForTransactionReceipt` throws: a 180 s timeout, an RPC error while polling, or a crash before `setMeta("vault")` at `agent/act.ts:157`. `ensureRegistered` throws and the process exits (`agent/run.ts:230-232`). On restart `vault` is unset but `vaultsByTarget` is set, so the `existing` path at `agent/run.ts:108-109` approves and deposits `book / 2` a second time. The whole book ends up parked and the working half is zero. (b) A crash after `createVault` or `acceptManagement` but before `register` writes `vaultsByTarget` (`agent/act.ts:134`) leaves an orphan vault. Each restart creates another one. With a supervisor that restarts on exit and a server that is down, this repeats every restart and costs gas each time. (c) In a source move, the deposit into the new vault is mined and the process dies before `setMeta("vault")`. On restart, meta still names the old vault, which is now empty. The next run's sweep loop (`agent/run.ts:157-165`) treats the new vault as "a vault the agent moved away from" and redeems all of it back to the wallet. The agent then runs with its key on an empty vault, and its budget runs out after the next settlement. (d) If the DB file is lost, or a relative `DB_PATH` (default `inferest.db`, `agent/run.ts:18`) resolves from another working directory, the runner sees no meta. It creates a new vault and deposits another `book / 2`, while the old vault's principal and live key become invisible to the runner and to the page.

No principal is lost: the agent's wallet owns every share. But the runner acts on a wrong picture. Money gets double-parked, swept out or orphaned, and only a human with the key can clean it up.

Smallest fix: at start, and before a move's sweep, derive the vault set from the chain. Use `VaultFactory.vaultsOf(address)` (`contracts/src/VaultFactory.sol:82`) plus `balanceOf` on each vault. Adopt the vault that holds shares as `vault` and fill `vaultsByTarget` from `targetVault()`. Skip the first-start deposit when any of the agent's vaults already holds shares. Record the tx hash in meta before waiting for its receipt, and on restart resolve a stored hash with `getTransactionReceipt` instead of resending.

### 2. No single-instance guard; a second runner rotates the first one's key and closes its run (should fix)

Evidence: `agent/run.ts:220-223`, `agent/log.ts:62-64`, `agent/run.ts:88-90`, `app/server.ts:265-268`.

Scenario: cron runs `npm run agent -- --once` every `AGENT_INTERVAL_MS` (10 min by default). One run can take up to 10 chat calls × 180 s (`agent/think.ts:81`) plus 4 paid calls × 240 s (`agent/run.ts:139`), roughly 46 min. The second instance calls `failStaleRuns(Date.now())`, which marks the first instance's live row as `failed` with "runner stopped". It then rotates the key (`agent/run.ts:89`), which invalidates the secret the first instance is using mid-run, and both processes sign with one account. That gives nonce races (viem picks the pending nonce for each send) and two decisions made from the same book snapshot. The second one mostly reverts, but it spends gas and leaves confusing rows.

Smallest fix: take an exclusive lock at start, for example a `BEGIN IMMEDIATE` row in `agent_meta` holding the pid and a heartbeat, or an OS lockfile. Exit when the lock is held. Have `failStaleRuns` close only rows whose owner is gone.

### 3. `AGENT_BOOK_USDC` is not enforced after the first deposit (should fix)

Evidence: `agent/run.ts:94-111`, `agent/fence.ts:22`, `agent/fence.ts:31`, `agent/run.ts:168`.

Scenario: the wallet was pre-funded by hand with 5,000 USDC. On a real chain the faucet and burn are skipped (`agent/run.ts:96`). The first start parks `book / 2` = 500 no matter what the balance is, and the remaining 4,500 becomes the "working" half the prompt describes. From then on a deposit may be up to the whole wallet (`agent/fence.ts:22`), and the buy cap is 20% of the whole wallet (`agent/fence.ts:31`). A wallet shared with other funds is fully exposed to the yield sources. If the wallet holds less than `book / 2`, the vault is created and registered, then the deposit reverts and the agent stops. The restart path then retries the approve and deposit on every start.

Smallest fix: cap the fence's `walletUsdc` at `max(0, book − vaultValue)`, or refuse to start when the balance exceeds the book by more than a tolerance. Refuse to start below `book / 2` before any transaction is sent.

### 4. Secrets share one env file and the runner holds the operator token (should fix)

Evidence: `package.json` scripts `serve` and `agent` both load `--env-file-if-exists=.env --env-file-if-exists=.env.local`. `app/config.ts:56` and `app/config.ts:59` read `KEEPER_PRIVATE_KEY` and `TOOL_WALLET_PRIVATE_KEY`. `agent/run.ts:18-19` reads `ADMIN_TOKEN` and `AGENT_PRIVATE_KEY`. `app/server.ts:68` and `app/server.ts:82-83` show that the admin token passes `owns()` for every vault.

Scenario: with the documented setup (spec line 81: all in `.env.example`), the internet-facing server process holds the agent's private key, and the runner, which parses untrusted model output, holds the keeper key, the tool-wallet key and an operator token that can settle, sync, clear pending settlements and mint keys on every customer's vault. Nothing leaks today. Checked: `errorOf` and `errorText` use viem's `shortMessage` and strip the RPC URL (`agent/run.ts:36`, `agent/act.ts:76`). The key is kept in memory only (`agent/run.ts:61-66`). The admin token is sent only as a header (`agent/run.ts:47`). The public `/api/agent` lists key ids but no secrets (`app/server.ts:183-188`). Tool arguments come from the model, which has never seen a secret. The concern is blast radius: one compromise exposes all three wallets.

Smallest fix: give each process its own env file (`--env-file=.env.agent` and `.env.server`). Authenticate the runner with a session or a per-vault credential scoped to its own vaults instead of `ADMIN_TOKEN`. Or at minimum add an operator-token variant that `vaultFor` limits to `customer == agent address`.

### 5. Dust or a paused old source fails every run before the model thinks (should fix)

Evidence: `agent/run.ts:157-165`. The spec (line 33) says settlement leftovers come back as shares of the old vault.

Scenario: after a move, the old vault's month-end settlement returns a few shares to the agent. If `convertToAssets(shares)` rounds to zero, the tokenized strategy's `redeem` reverts ("ZERO_ASSETS"). The same happens if the old target is paused or out of liquidity. The sweep sits inside the run's `try`, so the run is recorded as `failed` and the model never runs. This repeats every run until a human steps in.

Smallest fix: wrap each sweep in its own try/catch and log a `refused` action instead of failing the run. Skip shares whose `convertToAssets` is below a dust threshold.

### 6. A failed re-key after a move is only repaired on restart (should fix)

Evidence: `agent/act.ts:167-177`, `agent/run.ts:86-87`, `agent/run.ts:172-176`.

Scenario: a move deposits into the new vault, and then `POST /api/keys` fails (server busy, OpenRouter slow past the 60 s `api` timeout at `agent/run.ts:48`). Meta now says `vault = new` and `keyVault = old`. The loop keeps thinking with the in-memory key on the old, now empty vault. After that vault's next settlement, every run ends `out_of_budget` with the note "out of thinking budget until yield accrues" (`agent/run.ts:181`), which is wrong. `ensureRegistered` fixes this only on the next process start (`agent/run.ts:87`).

Smallest fix: at the top of `runOnce`, run the same `keyVault !== vault` check and re-key.

### 7. An orphaned Inferest key halves the agent's budget indefinitely (should fix)

Evidence: `agent/act.ts:170-176`, `app/limits.ts:22-25`, `agent/run.ts:93`.

Scenario: `POST /api/keys` succeeds and the process dies before `setMeta("keyId")`. On restart `vault` is set and `keyId` is not, so another key is minted (`agent/run.ts:93`). `previous` is undefined, so nothing is revoked. Both keys have weight 1, so `computeLimits` gives the orphan half the credit, and nobody can spend it. The same thing happens in a move when the process dies between minting and revoking (`agent/act.ts:176`).

Smallest fix: mint keys under a fixed name. At start, revoke every non-revoked key on the agent's vaults whose id is not `keyId`. The `/api/state` entry lists them (`app/server.ts:97-101`).

### 8. Gas is outside every budget, and the fence has no minimum size or daily cap (should fix)

Evidence: `agent/fence.ts:22-23` (any amount above 0), `agent/fence.ts:25-29`, `agent/act.ts:48-53` (no gas-price cap, no ETH balance check), `agent/run.ts:20` (10-minute default cadence).

Scenario: a hostile page read through a paid tool, or a model that flip-flops, asks for a 0.01 USDC deposit every run, or for a source move back and forth once both sources are rated. That is up to 2 transactions per split and 3 to 4 per move, 144 runs a day. Every move also mints a new Inferest key and revokes the old one. Gas comes from the agent's ETH, which neither the key budget nor the fence limits. On Arbitrum this costs dollars a day, not hundreds, but nothing stops it, and when the ETH runs out the next move can fail after its redeem (see finding 1). Nothing warns about low ETH.

Smallest fix: add a minimum split size (for example 10 USDC), a minimum time between source moves (for example 7 days) and a daily cap on transactions. Check the native balance before acting and refuse below a threshold. Pass `maxFeePerGas` from config.

### 9. The page and the run log misreport several failures (should fix)

Evidence: `app/server.ts:184-188` (the run's `error` is not in the payload), `agent/run.ts:147` and `agent/run.ts:226` (a `readBook` failure writes no row), `agent/think.ts:83-84`, `app/proxy.ts:176-195` (an upstream 402 is relayed as is), `app/proxy.ts:102-104` (503 during settlement).

Scenarios: (a) the OpenRouter float is empty. OpenRouter answers 402, the proxy relays it, and the run is labeled "out of thinking budget until yield accrues". That hides an operator problem that affects every customer. (b) An RPC outage or a reverting `convertToAssets` on a target breaks `readBook`. No run row is written, and the only trace is a stdout line. (c) A failed run shows as "failed" on `/agents` with no reason. (d) Setup actions from a first start that failed partway (`setupActions`, `agent/run.ts:63`) are lost when the process exits, so the vault creation and deposit transactions never show up on the page. (e) A revoked `keyId` makes `rotate` answer 409 (`app/server.ts:265`) and the agent stops at every start.

Smallest fix: add the proxy's error `type` to the 402 body so the runner treats only `insufficient_quota` as out of budget. Start the run row before `readBook` and fail it there. Include `error` in `/api/agent` runs. Write setup actions to a run row straight away. On a 409 from `rotate`, fall back to re-keying.

### 10. Paper positions are unbounded, and their prices come from the model (should fix)

Evidence: `agent/fence.ts:31-37` (the cap is per trade and ignores open positions), `agent/fence.ts:34` (3 per run), `agent/act.ts:179-183`, `agent/run.ts:193-195` (the mark is the model's own `price`), `agent/think.ts:38` (every open position goes into the prompt).

Scenario: 3 buys per run × 144 runs a day, each up to 20% of the wallet, adds up to paper exposure many times the working half. The system prompt grows by one line per open position, so each run's model cost rises until it eats the whole budget. `price` only has to be greater than 0 (`agent/fence.ts:36`), and `Infinity` passes, so a hostile page can set any entry or mark and fake the P&L the page shows.

Smallest fix: cap the total open paper size at the working half and the number of open positions (for example 10). Check `price` with `Number.isFinite` and against the price the tool actually returned, or at least within a band of the last mark.

### 11. A stale or load-balanced RPC can give inconsistent reads within one book (note)

Evidence: `agent/book.ts:22-36` (no `blockNumber` on the reads), `agent/rate.ts:3-8`.

Scenario: `clockAt` comes from one backend and the share prices from another, so a sample carries the wrong timestamp and the rate comes out noisy or negative. The rate is informational and gates only "unrated". A distorted rate can still persuade the model to move, but only between allowlisted sources. Decimals do not matter because the rate compares a target with itself (`convertToAssets(1e18)` on both samples). A stale wallet balance makes a deposit revert and the run fail. Nothing becomes unbounded.

Smallest fix: read everything at `block.number` from the first `getBlock`.

### 12. Operator-only chain routes are open to vault owners on a real chain (note)

Evidence: `app/server.ts:282-299`.

Scenario: `POST /api/admin/report`, `/sync` and `/settle` accept a signed-in owner for their own vault through `vaultFor`. On a real chain `report` and `settle` spend the keeper's ETH, so any customer can drain keeper gas with repeated calls. The runner does not call them when `AGENT_DEMO_DAYS` is 0. The keeper reports daily (`app/keeper.ts:467-470`) and settles monthly (`app/keeper.ts:472-492`).

Smallest fix: make `report` and `settle` operator-only unless `DEMO_FAUCET=1`, or rate-limit them per vault.

### 13. The runner does not check that its config matches the chain (note)

Evidence: `agent/run.ts:28-30` and `agent/run.ts:41` (no `chainCfg.chainId === dep.chainId` check, while the server has one at `app/config.ts:31`), `agent/run.ts:96` (the fork mode depends only on `AGENT_DEMO_DAYS`).

Scenario: `AGENT_DEMO_DAYS=7` copied into a real-chain env. With an empty wallet the faucet's last method is refused and the agent stops (`app/faucet.ts:33-35`), which is safe. With a funded wallet every run logs "clock not advanced" and nothing else happens. viem's `writeContract` checks the RPC's chain against `dep.chainId` before signing, so a wrong RPC fails closed. Also, `contracts/deployments/42161.json` was untracked at the time (only `.gitkeep` is tracked), so the real deployment record existed only in the reviewer's working tree; it is now git-ignored on purpose.

Smallest fix: copy the server's chain-id check. Refuse `AGENT_DEMO_DAYS > 0` when `eth_chainId` matches a real chain and `anvil_nodeInfo` or `tenderly_*` is unavailable. Add the real-chain deployment file with `git add -f`.

### 14. Numeric config is only checked for being finite and non-negative (note)

Evidence: `agent/run.ts:23-27`.

Scenario: `AGENT_TRADE_CAP_BPS=50000`, a floor above `book / 2` (withdrawals are then always refused, so this fails safe), or `AGENT_INTERVAL_MS=1000` (runs as fast as the budget allows, and gas with them) are all accepted.

Smallest fix: require `tradeCapBps <= 10000`, `floorUsdc < bookUsdc / 2` and `intervalMs >= 60000` unless `--once`.

### 15. Hostile content can reach the public page as the note (note)

Evidence: `agent/think.ts:47-51` (the note and reasoning strings have no length limit), `app/server.ts:178-212` (public), `app/dashboard/agents.js:192` (escaped).

Scenario: a page the model scraped gets it to write attacker text into `note`, which `/agents` shows publicly. It is escaped, so there is no XSS, but it can deface the page or put words in the operator's mouth. Tool arguments shown on the page are model-written too.

Smallest fix: cut `note` to about 120 words and `reasoning` to about 200 characters in `parseDecision`.

## Answers to the review's seven questions (fork-only paths on a real chain, money bounds, key custody, crash safety, chain interaction, model and tool trust, operations)

1. With `AGENT_DEMO_DAYS` unset or 0, the faucet, the burn, the clock move, the runner's `report` call and the runner's month-end settle never run (`agent/run.ts:96`, `:119`, `:128`, `:204`). A hand-funded wallet on first start parks `book / 2` and keeps the rest as working capital (finding 3). The server's `report` route still exists for owners (finding 12).
2. The fence caps deposits at the wallet balance and withdrawals at the floor. It also allows at most one split and one source move per run, 3 trades, buys at the trade cap and sells at the open position. No tool result reaches a signing path except through the decision, and the fence checks every decision field. Values from the chain cannot unbound anything: a zero or negative rate only affects the prompt, a revert throws and fails the run, `NaN` amounts fail `> 0`. The paper book is not bounded (finding 10). Gas is not bounded (finding 8).
3. See finding 4. Redaction is complete for what reaches logs, rows and the endpoint.
4. See findings 1, 2, 6, 7 and 9d. `failStaleRuns` only closes `running` rows. It does not touch chain state, orphan vaults or keys.
5. Receipts are checked (`agent/act.ts:51`). Reverts are caught at gas estimation or from the receipt. There is no gas-price cap. Nonces are safe within one process but not across two (finding 2). A receipt wait times out at 180 s. Allowances are exact per deposit. Decimals cancel in the rate. The keeper settles month end in the server's 60 s tick (`app/cli.ts:53-55`, `app/keeper.ts:472-492`).
6. The worst a hostile page can do is steer the model within the fence: park or unpark within the floor, churn sources (gas), fake paper prices, spend the key's whole remaining yield on expensive tools, and write the public note. Per run, spend is at most 10 chat calls plus 4 paid tool calls, each paid call capped at the key's remaining tool budget. Per day and per period, spend is at most the yield credit, `yield × (1 − railFee)` shared by the key's weight (`app/limits.ts:21-25`). A 402 mid-run ends it as `out_of_budget`, and tool payments already made are recorded. An empty OpenRouter float is mislabeled the same way (finding 9a).
7. See the table below. When something breaks, a human sees stdout lines (`agent/run.ts:207`, `:226`, `:231`) and a "failed" status with no reason on `/agents`.

## Environment and operational requirements for a real-chain start

| Requirement | Where it is read | If it is missing or wrong |
|---|---|---|
| `AGENT_PRIVATE_KEY` for a dedicated wallet (not the keeper, tool or deployer key) | `agent/run.ts:19` | Missing: throws at load. Shared with the keeper: nonce collisions with settlements. Shared with other funds: all of it is exposed (finding 3) |
| Agent wallet funded with exactly `AGENT_BOOK_USDC` USDC | `agent/run.ts:94-111` | Below `book / 2`: vault created, deposit reverts, agent stops. Above the book: the surplus trades as working capital |
| Agent wallet funded with ETH for gas | `agent/act.ts:48-53` | Sends fail with insufficient funds. A move can fail between redeem and deposit. No warning |
| `AGENT_DEMO_DAYS` unset or `0` | `agent/run.ts:20` | `>0` with a funded wallet: a harmless "clock not advanced" line every run. With an empty wallet: the faucet is refused and the agent stops |
| `RPC_URL` to Arbitrum One, ideally not load-balanced | `agent/run.ts:18` | Down: "run not started" on stdout, no row. Stale: reverts or noisy rates (finding 11) |
| `DEPLOYMENTS` pointing at `contracts/deployments/42161.json` (git-ignored; add a real-chain record with `git add -f`), with `CHAIN_CONFIG` matching | `agent/run.ts:28-29` | Wrong chain: viem refuses to sign. No config cross-check (finding 13) |
| Factory allowlists every `targets` entry | `contracts/src/VaultFactory.sol:60` | A move to a target that is not allowlisted reverts at `createVault` after the redeem. Funds stay in the wallet and the move is recorded as failed |
| `DB_PATH` as an absolute path to the server's own SQLite file, with the runner on the same host | `agent/run.ts:18`, `app/cli.ts:45` | A different file: `/agents` answers 404, and a fresh file makes the runner create and fund a second vault (finding 1d) |
| `API_URL` of the running server and `ADMIN_TOKEN` | `agent/run.ts:18` | Server down at start: "agent stopped", exit 1, so a supervisor with restart is needed. Down mid-loop: runs fail |
| Server running `serve` with the keeper tick | `app/cli.ts:53-55` | No sync: the proxy answers 503 "stale budget". No report: no yield, so every run is `out_of_budget`. No settlement at month end |
| `KEEPER_PRIVATE_KEY` funded with ETH on Arbitrum | `app/config.ts:56` | Daily `report` and the monthly settle fail, and the budget never refreshes |
| OpenRouter account with float, and `KEY_ENCRYPTION_KEY` | `app/cli.ts:18-19` | An empty float is shown as the agent being out of budget (finding 9a) |
| `TOOL_WALLET_PRIVATE_KEY` funded with USDC on Base, plus the Orthogonal key | `app/cli.ts:25-31` | `run_tool` fails with "TOOL_WALLET_PRIVATE_KEY is not set" or the payment is rejected. The model decides without data |
| Exactly one runner instance (daemon, or cron with a lock and a cadence longer than the longest run, about 46 min) | `agent/run.ts:220-229` | Overlap rotates the other instance's key and fails its run (finding 2) |
| `AGENT_INTERVAL_MS` sized to the yield (500 USDC at about 5% is about $0.07 a day) | `agent/run.ts:20` | At 10 minutes most runs end `out_of_budget` and still cost gas if they act |
| Log capture and alerting on stdout (no alerting today) | `agent/run.ts:207`, `:226`, `:231` | Failures show on `/agents` only as "failed" with no reason |
