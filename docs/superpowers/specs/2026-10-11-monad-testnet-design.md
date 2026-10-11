# Monad testnet design

_Inferest on Monad testnet as a public demo anyone can click: the same contracts, both pages, both demo scripts, on a chain that has no USDC yield source of its own. Written 2026-10-11 from the research below and the code on `main` at a233c0b. The plan is `docs/superpowers/plans/2026-10-11-monad-testnet.md`._

## Goal

A finance lead or a judge opens the Treasury page on a server pointed at Monad testnet, signs in, gets demo funds, deposits, sees yield, creates a key, calls a model, settles and withdraws, with every transaction on a public explorer. The hosted agent runs there too. Nothing in the engine, the keeper, the proxy or the pages changes for the chain; what changes is one config file, a pair of small demo contracts the chain lacks, a faucet that works on a live chain instead of a fork, and a way to move the demo clock without `evm_increaseTime`.

## What Monad testnet supports

Confirmed on 2026-10-11 against the live RPC, the installed packages and primary docs. Source URLs are in the plan's research notes; the facts the design rests on:

| Need | Monad testnet | Consequence |
|---|---|---|
| Chain | id 10143, client `Monad/0.16.x`, blocks about 300 ms, finality under a second. Public RPC `https://testnet-rpc.monad.xyz` (QuickNode, 50 rps, 25 rps for `eth_call`). Explorer `https://testnet.monadvision.com` (viem's `testnet.monadexplorer.com` redirects there). Faucet `https://faucet.monad.xyz`. The testnet was reset from genesis on 2025-12-16; one testnet only. | `config/monad-testnet.json`; `PUBLIC_RPC_URL` can be the public RPC |
| EVM | Bytecode-compatible through the Osaka fork: PUSH0, transient storage, MCOPY, EIP-7702. Blob transactions rejected. Contract size limit 128 KB, 30M gas per transaction. | Our Solidity 0.8.33, `evm_version = cancun` build deploys unchanged; same bytecode as Arbitrum One |
| Gas | Charged on the gas limit, not on gas used. Base fee about 100 gwei on testnet. | `KEEPER_MAX_TX_COST_ETH` (gas times fee ceiling) is the exact charge there; the unit is MON. A vault creation costs a few tenths of a MON, so demo wallets need gas as well as test USDC |
| USDC | Circle-native testnet USDC at `0x534b2f3A21130d7a60830c2Df862319e593943A3`, FiatToken v2 with EIP-3009 and EIP-2612; Circle's faucet lists Monad testnet; CCTP V2 live. Mainnet USDC `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`. | Real USDC exists, but no yield source accepts it (next row) and Circle's faucet cannot fund a 100,000 USDC demo |
| Yield source | None. No lending market or ERC-4626 vault with a USDC market on the testnet (Aave, Morpho, Euler, Curvance, Kinza and Neverland checked). Mainnet has Aave V3 with a static USDC wrapper (`stataUSDC`, ERC-4626, `0xC554aFfE2f581F5E0811e0D42D484ECaC5c6B8e2`) and Morpho. | The testnet needs a yield source we deploy. Mainnet needs none: Circle USDC plus Aave's wrapper is the Arbitrum One pattern exactly |
| x402 | A Monad Foundation facilitator (`https://x402-facilitator.molandak.org`) serves `eip155:10143` and `eip155:143`, x402 version 2. `@x402/evm` 2.28.0 lists `eip155:10143` with Circle USDC as its default asset; the installed 2.27.0 knows Monad mainnet only. Coinbase's facilitator does not serve Monad. | Unchanged. Our paid tools pay Orthogonal, whose server accepts Base USDC; the tool wallet stays on Base whatever chain the vaults are on |
| Login | Dynamic lists Monad mainnet as a dashboard toggle; the testnet is undocumented. | Unchanged. The dashboard already replaces Dynamic's network entry with ours whenever `PUBLIC_RPC_URL` is set (`app/dashboard/src/dynamic.js`), which is how a fork works today |
| viem | 2.56.9 exports `monadTestnet` (10143) and `monad` (143). | Nothing to add; `makeChain` defines the chain from config |
| Forking | `anvil --fork-url https://testnet-rpc.monad.xyz` (Foundry 1.8.3) starts in two seconds, auto-selects the Monad hardfork, serves state, and takes `anvil_setBalance`, `evm_increaseTime` and `evm_mine`. The public RPC lacks `eth_getProof`. | The existing fork recipe (`DEMO_FAUCET=1`, the clock warp, the cheat faucet) works over a Monad testnet deployment unchanged |
| Verification | Sourcify at `https://sourcify-api-monad.blockvision.org/`, no key: `forge verify-contract --chain 10143 --verifier sourcify --verifier-url ...`. Monadscan needs a key. | Same record format as `contracts/deployments/arbitrum-one.json` |

## Decisions

1. **The yield source is ours: `DemoYieldVault` over `TestUSDC`.** An ERC-4626 vault whose assets grow at a fixed annual rate (450 basis points, set at deploy) on a clock its owner can move forward, and which mints the test asset to pay what it owes on the way out. The Octant strategy, the Splitter and the factory see an ordinary ERC-4626 target; `VaultFactory.createVault` allowlists it like Fluid. Why not Circle's testnet USDC: a vault cannot mint it, so simulated yield would have to be pre-funded from a faucet that drips small amounts, and the 100,000 USDC demo on the Treasury page could not be funded at all. The test asset is named plainly (`Test USDC`, symbol `tUSDC`, six decimals) and the vault `Inferest demo USDC vault`. Both are marked never for real money. Anyone may mint up to 1,000,000 tUSDC per call; the cap keeps one caller from minting enough to overflow the vault's accrual arithmetic.
2. **Two run modes, selected by `DEMO_FAUCET`.** `DEMO_FAUCET=1` is the fork mode that exists today: the cheat faucet, `evm_increaseTime`. `DEMO_FAUCET=mint` is the live-testnet mode: `POST /api/demo/fund` mints test USDC to the wallet and sends it gas from a faucet signer, and a new operator-only `POST /api/demo/warp { seconds }` moves the demo vaults' clocks. Both modes count as a demo chain everywhere the code asks (`cfg.demoFaucet`): no owner cooldown, the funds button shown, Dynamic's network marked testnet.
3. **The faucet signer is its own key.** `DEMO_FAUCET_PRIVATE_KEY` owns every `DemoYieldVault` (so it alone can warp) and pays for mints and gas gifts. It is never the keeper's key: a faucet transaction from a public route must not take a nonce the keeper is about to use for a report or a settlement. `loadConfig` refuses the keeper's key in that slot.
4. **The clock moves through the server.** The demo script's `warp` and the agent runner's `advanceClock` try `evm_increaseTime` first and, when the node does not know the method, call `POST /api/demo/warp` with the same number of seconds. One helper, `moveClock` in `app/demo-clock.ts`, does this for both. On a live testnet the agent's run dates stay real while its yield jumps; that is stated on the status page.
5. **Nothing chain-specific in code.** `makeChain` takes the chain name and native currency from config instead of hard-coding Ether; `config/monad-testnet.json` carries the chain, the explorer, the test asset, the demo vault as the only target, and a `demo` block (`fundNative`, `warpTargets`). The deployment record `contracts/deployments/monad-testnet.json` is the reviewed public copy, force-added like Arbitrum's.
6. **The contract build does not change.** Solidity 0.8.33, `evm_version = cancun`, Octant pinned by commit; the same bytecode Arbitrum One runs. Verified on Sourcify's Monad instance.
7. **Paid tools stay on Base.** Monad has an x402 facilitator and Circle USDC, but the tool payments go to Orthogonal, which prices in Base USDC. Accepting x402 payments into Inferest on Monad is a product idea, not part of this.

## The demo contracts

`contracts/src/demo/TestUSDC.sol` and `contracts/src/demo/DemoYieldVault.sol`, AGPL like the factory, tested in `contracts/test/DemoYieldVault.t.sol`, deployed by `contracts/script/DeployDemo.s.sol`.

```
TestUSDC: ERC20("Test USDC", "tUSDC"), decimals 6
  MAX_MINT = 1,000,000e6
  mint(to, amount)            anyone; reverts MintTooLarge above MAX_MINT

DemoYieldVault: ERC4626 over TestUSDC, Ownable(owner = the faucet signer)
  rateBps (immutable, at most 10,000), principal, syncedAt, clockOffset
  clock()        = block.timestamp + clockOffset
  totalAssets()  = principal + principal * rateBps * (clock() - syncedAt) / (10,000 * 365 days)
  warp(by)       owner only, by <= MAX_WARP (ten years): sync, then clockOffset += by; emits Warped
  _deposit       sync, then principal += assets
  _withdraw      sync; if the vault holds less than `assets`, mint the shortfall in chunks of MAX_MINT; then principal -= assets
```

Simple interest on a clock: real time accrues on its own at 4.5% a year, so a vault reports a profit every day with nobody touching anything, and a warp of 182.5 days books exactly half a year's yield, which is what the Treasury demo's "six months pass" step needs. Octant's health check allows a profit up to 100% of assets per report, so no warp the server accepts can fail it. The vault is shared by every customer vault on the chain, so a warp moves everyone's clock, exactly as `evm_increaseTime` does on a fork.

## The app

- `app/config.ts`: `DEMO_FAUCET` is `1`, `mint` or unset; `faucetMode`, `faucetKey` and `demoFund { nativeWei, warpTargets }` on `Config`. Mint mode needs the chain config's `demo` block and `DEMO_FAUCET_PRIVATE_KEY` (32 bytes, not the keeper's); each warp target must be one of the chain's targets.
- `app/faucet.ts`: `createMintFaucet` beside `createFaucet`; `Faucet` gains an optional `warp(seconds)`; `FaucetDry` when the signer holds less than twice the gas gift, answered as 503 so the page says why; `MAX_WARP_SECONDS` mirrors the contract.
- `app/server.ts`: `POST /api/demo/warp` (operator only, 404 without a warp-capable faucet, 400 outside 1 second to ten years, logs the move). `POST /api/demo/fund` maps `FaucetDry` to 503.
- `app/cli.ts`: builds the faucet by mode.
- `app/demo-clock.ts`: `moveClock({ rpc, api, seconds })`, used by `demo/lib.ts` and `agent/run.ts`. The runner's first-start funding also goes through `POST /api/demo/fund` now, so on a real chain (no faucet route) it still stops, which is what the safety review requires.
- Pages: the words "demo fork" become "demo chain" on the Treasury page and in the walkthrough. Nothing else on a page changes.

## Running it

Fork mode, as today, over the Monad testnet deployment: `anvil --fork-url https://testnet-rpc.monad.xyz`, deploy or reuse the recorded addresses, `DEMO_FAUCET=1`.

Live mode: `RPC_URL` and `PUBLIC_RPC_URL` at the public RPC, `CHAIN_CONFIG=config/monad-testnet.json`, `DEPLOYMENTS=contracts/deployments/10143.json`, `DEMO_FAUCET=mint`, `DEMO_FAUCET_PRIVATE_KEY`, the keeper and the faucet signer holding MON from the Monad faucet. `npm run demo:treasury` runs end to end (its warp becomes a warp route call). The Treasury walkthrough in `docs/07-walkthrough.md` applies, with "Report yield" preceded by an operator warp when months should pass. The agent runs with `AGENT_DEMO_DAYS=7`: each run warps the demo vaults a week through the server.

Deploy order: fund the deployer, the keeper and the faucet signer; `DeployDemo.s.sol` with `DEMO_OWNER` = the faucet signer (writes `deployments/10143-demo.json`); `Deploy.s.sol` with `TARGET_VAULT` = that file's `target` (writes `deployments/10143.json`); verify the five contracts on Sourcify; write the config and the reviewed record; `git add -f` the record.

## Out of scope, and later

- **Monad mainnet.** A config over Circle USDC and Aave's `stataUSDC`, no new contracts, the Arbitrum One pattern; a fork demo of it would run today. Not planned here because it is real money.
- **x402 into Inferest on Monad.** The Foundation facilitator and `@x402/evm` 2.28 make it possible for the MCP server to charge in USDC on Monad. Separate idea.
- **A Circle USDC variant of the testnet demo** at small amounts, with a pre-funded yield reserve instead of minting. Only worth it if a judge insists on Circle's token.
- **The agent's dates.** On a live testnet the run cards show real dates while yield jumps by weeks. Making the page show the demo clock is a page change for later.

## Risks

- **The faucet signer runs dry.** Each fund sends 0.5 MON; the route refuses with 503 below 1 MON and logs it. The operator tops up from the Monad faucet, whose drip amount is not documented; collect a day ahead.
- **Public RPC limits.** 25 requests a second for `eth_call` on the public endpoint; the keeper's minute sync and the dashboard's reads stay well under it for a demo, but a load test would not.
- **The shared demo vault can be griefed.** Anyone can mint tUSDC and deposit into the demo vault; the mint cap bounds how far they can push its arithmetic, and the vault never holds real value. Warping is owner-only.
- **tUSDC in a wallet.** Wallets show `tUSDC`, the page says USDC. The copy is kept; the token name says what it is.
