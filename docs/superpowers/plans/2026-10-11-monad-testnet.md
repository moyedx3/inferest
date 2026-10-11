# Monad Testnet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inferest runs on Monad testnet as a public demo: the same contracts over a demo yield source we deploy, a faucet and a clock that work on a live chain, one config file, and a recorded deployment.

**Architecture:** Two small contracts (`TestUSDC`, `DemoYieldVault`) stand in for the USDC yield source Monad testnet lacks; the Octant strategy, Splitter and factory are untouched. The server grows a second faucet implementation that mints and sends gas from a signer of its own, and an operator route that moves the demo vaults' clocks the way `evm_increaseTime` moves a fork's. The demo script and the agent runner fall back to that route. Chain facts live in `config/monad-testnet.json`.

**Tech Stack:** Solidity 0.8.33 with OpenZeppelin 5.3 and Foundry 1.8.3 (`~/.foundry/bin`, not on PATH), Node 26 native TypeScript (erasable syntax, `.ts` imports), `node:test`, viem 2.56.9. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-11-monad-testnet-design.md`

## Global Constraints

- Erasable TypeScript only; relative imports end in `.ts`; `npm test -- --test-timeout=60000 --test-force-exit` and `npm run typecheck` green after every task (342 tests and clean on `main` at a233c0b).
- Contracts: `cd contracts && ~/.foundry/bin/forge test --no-match-contract ForkTest` green after every contract task (21 tests on `main`). Read the `Suite result` lines; the lint noise above them is upstream. `evm_version = cancun`, `solc = 0.8.33`, unchanged.
- Prose, comments and commit messages: plain sentences, American spelling, no em dashes, no name of a submission event, program, judge or prize. Commit subjects are sentences, not conventional-commit prefixes. Every commit ends with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Branches: the integration branch is `monad-testnet` off `main`, in a git worktree (the shared checkout at `~/inferest` is used by other sessions). Each task is a branch `task-N-<slug>` off `monad-testnet`, reviewed, merged back with `--no-ff` only when clean. Nothing is merged into `main` or pushed without the founder.
- Never stage `.env*` (other than `.env.example`), `inferest.db*`, `contracts/deployments/<chainId>.json` or `<chainId>-demo.json`, `app/dashboard/dynamic.bundle.js`, anything under `private/`. Stage files by name. `docs/superpowers/` and `contracts/deployments/monad-testnet.json` are git-ignored but tracked on purpose: add new files there with `git add -f`.
- Secrets never reach a log line, a store row, a response body or a document. Test keys are synthetic (`0x07` repeated) and never funded.
- The demo contracts are never deployed where real money is; their NatSpec says so.

## Review Focus

1. **A signed-in owner, not the operator, posts to the warp route**: 403, no transaction sent. Test in Task 4.
2. **`DEMO_FAUCET=mint` with a chain config that has no `demo` block, or a faucet key equal to the keeper's**: `loadConfig` throws naming the field, so the server never starts half-configured. Test in Task 2.
3. **The faucet signer holds less than twice the gas gift**: fund answers 503 with a message naming the signer and mints nothing. Test in Task 3 (unit) and Task 4 (route).
4. **A redeem from the demo vault larger than the test USDC it holds, after a long warp**: the shortfall is minted in chunks under the mint cap and paid in full. Test in Task 1.
5. **Real time passing on the live chain with no warp at all**: the demo vault accrues on its own, so a daily report books a profit. Test in Task 1.

---

## Task 0: Worktree and integration branch

**Files:** none in the repository.

- [ ] **Step 1: Check the shared checkout is not yours to switch**

Run: `cd ~/inferest && git branch --show-current && git status --short`
Expected: `main`, and an edit you did not make (`M design/site.pen`). Do not touch it.

- [ ] **Step 2: Create the worktree and the integration branch**

```bash
S=/private/tmp/claude-501/-Users-moyedeun-inferest/8f3d7277-9ea7-4c36-91d9-a4394cc3b763/scratchpad
cd ~/inferest && git worktree add "$S/wt-monad" -b monad-testnet main
ln -s ~/inferest/node_modules "$S/wt-monad/node_modules"
cd "$S/wt-monad" && git submodule update --init --recursive
```

- [ ] **Step 3: Confirm the baseline in the worktree**

Run: `cd "$S/wt-monad" && npm test -- --test-timeout=60000 --test-force-exit 2>&1 | grep -E "^ℹ (tests|pass|fail)" && npm run typecheck && (cd contracts && ~/.foundry/bin/forge test --no-match-contract ForkTest 2>&1 | grep "tests passed")`
Expected: `tests 342`, `pass 342`, `fail 0`; typecheck silent; `21 tests passed`.

- [ ] **Step 4: Commit the spec and this plan on the integration branch**

```bash
git add -f docs/superpowers/specs/2026-10-11-monad-testnet-design.md docs/superpowers/plans/2026-10-11-monad-testnet.md
git commit -m "Add the Monad testnet design and its plan

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 1: The demo contracts

**Files:**
- Create: `contracts/src/demo/TestUSDC.sol`
- Create: `contracts/src/demo/DemoYieldVault.sol`
- Create: `contracts/test/DemoYieldVault.t.sol`
- Create: `contracts/script/DeployDemo.s.sol`

**Interfaces:**
- Consumes: OpenZeppelin 5.3 `ERC20`, `ERC4626`, `Ownable` (`lib/openzeppelin-contracts`, remapped as `@openzeppelin/contracts/`); Octant's `YieldDonatingTokenizedStrategy` and `ITokenizedStrategy` for the cycle test; `Splitter` and `VaultFactory` from `src/`.
- Produces: `TestUSDC.mint(address to, uint256 amount)` (anyone, at most `MAX_MINT = 1_000_000e6`); `DemoYieldVault.warp(uint256 by)` (owner only, at most `MAX_WARP = 10 * 365 days`), `rateBps()`, `clock()`; `DeployDemo.s.sol` writing `deployments/<chainId>-demo.json` with `{ chainId, usdc, target, rateBps }`. Task 3's faucet calls `mint` and `warp` with exactly these signatures.

- [ ] **Step 1: Branch**

```bash
cd "$S/wt-monad" && git checkout -b task-1-demo-contracts monad-testnet
```

- [ ] **Step 2: Write the failing tests**

Create `contracts/test/DemoYieldVault.t.sol`:

```solidity
// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.25;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { YieldDonatingTokenizedStrategy } from "octant/strategies/yieldDonating/YieldDonatingTokenizedStrategy.sol";
import { ITokenizedStrategy } from "octant/core/interfaces/ITokenizedStrategy.sol";
import { Splitter } from "../src/Splitter.sol";
import { VaultFactory } from "../src/VaultFactory.sol";
import { TestUSDC } from "../src/demo/TestUSDC.sol";
import { DemoYieldVault } from "../src/demo/DemoYieldVault.sol";

contract DemoYieldVaultTest is Test {
    uint256 internal constant RATE_BPS = 450;
    uint256 internal constant HALF_YEAR = 365 days / 2;
    uint256 internal constant PRINCIPAL = 100_000e6;

    TestUSDC internal usdc;
    DemoYieldVault internal vault;
    address internal faucet = makeAddr("faucet");
    address internal alice = makeAddr("alice");

    function setUp() public {
        usdc = new TestUSDC();
        vault = new DemoYieldVault(usdc, RATE_BPS, faucet);
    }

    function _deposit(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(vault), amount);
        vault.deposit(amount, who);
        vm.stopPrank();
    }

    function test_testUsdc_sixDecimalsAndCappedMint() public {
        assertEq(usdc.decimals(), 6);
        usdc.mint(alice, usdc.MAX_MINT());
        assertEq(usdc.balanceOf(alice), 1_000_000e6);
        vm.expectRevert(abi.encodeWithSelector(TestUSDC.MintTooLarge.selector, usdc.MAX_MINT() + 1));
        usdc.mint(alice, usdc.MAX_MINT() + 1);
    }

    function test_warpAccruesAtTheRate() public {
        _deposit(alice, PRINCIPAL);
        assertEq(vault.totalAssets(), PRINCIPAL);
        vm.prank(faucet);
        vault.warp(HALF_YEAR);
        // 100,000 at 4.5% for half a year is 2,250
        assertApproxEqAbs(vault.totalAssets(), PRINCIPAL + 2_250e6, 1);
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(alice)), PRINCIPAL + 2_250e6, 1);
    }

    function test_realTimeAccruesWithoutAWarp() public {
        _deposit(alice, PRINCIPAL);
        vm.warp(block.timestamp + 1 days);
        // one day at 4.5% on 100,000 is 12.328767
        assertEq(vault.totalAssets(), PRINCIPAL + 12_328_767);
    }

    function test_redeemMintsTheShortfall() public {
        _deposit(alice, PRINCIPAL);
        vm.prank(faucet);
        vault.warp(HALF_YEAR);
        uint256 supplyBefore = usdc.totalSupply();
        vm.prank(alice);
        uint256 got = vault.redeem(vault.balanceOf(alice), alice, alice);
        assertApproxEqAbs(got, PRINCIPAL + 2_250e6, 1);
        assertEq(usdc.balanceOf(alice), got);
        assertApproxEqAbs(usdc.totalSupply() - supplyBefore, 2_250e6, 1); // only the yield was minted
        assertLe(vault.totalAssets(), 1); // ERC-4626 rounds the last redeem down by at most one unit
    }

    function test_shortfallAboveTheMintCapIsPaidInChunks() public {
        // twenty deposits of the cap make 20,000,000; ten years at 4.5% owes 9,000,000, nine times MAX_MINT
        for (uint256 i = 0; i < 20; i++) _deposit(alice, usdc.MAX_MINT());
        vm.prank(faucet);
        vault.warp(vault.MAX_WARP());
        vm.prank(alice);
        uint256 got = vault.redeem(vault.balanceOf(alice), alice, alice);
        assertApproxEqAbs(got, 29_000_000e6, 1);
        assertEq(usdc.balanceOf(alice), got);
    }

    function test_onlyTheOwnerWarpsAndNotPastTheCap() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        vault.warp(1);
        vm.expectRevert(abi.encodeWithSelector(DemoYieldVault.WarpTooLong.selector, vault.MAX_WARP() + 1));
        vm.prank(faucet);
        vault.warp(vault.MAX_WARP() + 1);
    }

    function test_rateAboveOneHundredPercentIsRefused() public {
        vm.expectRevert(abi.encodeWithSelector(DemoYieldVault.RateTooHigh.selector, 10_001));
        new DemoYieldVault(usdc, 10_001, faucet);
    }

    /// The whole Inferest cycle over the demo source: deposit, warp half a year, report, settle, redeem.
    function test_fullCycleThroughTheInferestContracts() public {
        address keeper = makeAddr("keeper");
        address floatAddr = makeAddr("float");
        address feeAddr = makeAddr("fee");
        YieldDonatingTokenizedStrategy impl = new YieldDonatingTokenizedStrategy();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        Splitter splitter = new Splitter(predicted, keeper, floatAddr, feeAddr, 1_000);
        VaultFactory factory = new VaultFactory(address(this), address(splitter), address(impl), keeper, keeper);
        factory.setAllowedTarget(address(vault), true);

        usdc.mint(alice, PRINCIPAL);
        vm.startPrank(alice);
        ITokenizedStrategy customer = ITokenizedStrategy(factory.createVault(address(vault), "Demo", "DEMO"));
        customer.acceptManagement();
        usdc.approve(address(customer), PRINCIPAL);
        customer.deposit(PRINCIPAL, alice);
        vm.stopPrank();

        vm.prank(faucet);
        vault.warp(HALF_YEAR);
        vm.prank(keeper);
        (uint256 profit,) = customer.report();
        assertApproxEqAbs(profit, 2_250e6, 10);
        assertApproxEqAbs(splitter.yieldOf(address(customer)), 2_250e6, 10);

        vm.prank(keeper);
        splitter.settle(address(customer), 500e6);
        assertEq(usdc.balanceOf(floatAddr), 500e6);
        assertApproxEqAbs(usdc.balanceOf(feeAddr), 175e6, 10); // 10% of the 1,750 left over

        vm.startPrank(alice);
        uint256 got = customer.redeem(customer.balanceOf(alice), alice, alice);
        vm.stopPrank();
        // principal less Octant's 1,000 seed shares, plus the 1,575 returned
        assertApproxEqAbs(got, PRINCIPAL - 1_000 + 1_575e6, 20);
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd contracts && ~/.foundry/bin/forge test --match-contract DemoYieldVaultTest 2>&1 | tail -5`
Expected: a compiler error, `Source "src/demo/TestUSDC.sol" not found` or similar.

- [ ] **Step 4: Write the test asset**

Create `contracts/src/demo/TestUSDC.sol`:

```solidity
// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.25;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestUSDC
/// @notice Test money for a testnet that has no USDC yield source: six decimals like USDC, and anyone can mint up
///         to MAX_MINT per call. The cap keeps one caller from minting enough to overflow the demo vault's accrual
///         arithmetic. Never deployed where real money is.
contract TestUSDC is ERC20 {
    uint256 public constant MAX_MINT = 1_000_000e6;

    error MintTooLarge(uint256 amount);

    constructor() ERC20("Test USDC", "tUSDC") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        if (amount > MAX_MINT) revert MintTooLarge(amount);
        _mint(to, amount);
    }
}
```

- [ ] **Step 5: Write the demo yield vault**

Create `contracts/src/demo/DemoYieldVault.sol`:

```solidity
// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.25;

import { IERC20, ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { TestUSDC } from "./TestUSDC.sol";

/// @title DemoYieldVault
/// @notice An ERC-4626 yield source for a testnet that has none. Its assets grow at a fixed annual rate on a clock
///         the owner can move forward, and it mints the test asset to cover what it owes on the way out. A customer
///         vault over it behaves as one over a real yield source: it deposits, sees the share price rise, redeems.
///         Never deployed where real money is.
contract DemoYieldVault is ERC4626, Ownable {
    uint256 public constant YEAR = 365 days;
    /// @notice The most one warp can move the clock; the server's warp route accepts the same bound.
    uint256 public constant MAX_WARP = 10 * YEAR;

    /// @notice Simulated annual yield in basis points (450 is 4.5%).
    uint256 public immutable rateBps;
    /// @notice Assets accounted for at `syncedAt`; yield since then is computed on top.
    uint256 public principal;
    /// @notice The clock reading `principal` was last brought up to.
    uint256 public syncedAt;
    /// @notice Seconds the owner has moved the clock forward in total.
    uint256 public clockOffset;

    event Warped(uint256 by, uint256 clockOffset);

    error RateTooHigh(uint256 rateBps);
    error WarpTooLong(uint256 by);

    constructor(TestUSDC asset_, uint256 rateBps_, address owner_)
        ERC20("Inferest demo USDC vault", "demoUSDC")
        ERC4626(IERC20(address(asset_)))
        Ownable(owner_)
    {
        if (rateBps_ > 10_000) revert RateTooHigh(rateBps_);
        rateBps = rateBps_;
        syncedAt = clock();
    }

    /// @notice Block time plus everything the owner has warped.
    function clock() public view returns (uint256) {
        return block.timestamp + clockOffset;
    }

    /// @notice Principal plus simple interest at `rateBps` since the last sync.
    function totalAssets() public view override returns (uint256) {
        return principal + (principal * rateBps * (clock() - syncedAt)) / (10_000 * YEAR);
    }

    /// @notice Moves the clock forward so yield accrues as if that much time had passed.
    function warp(uint256 by) external onlyOwner {
        if (by > MAX_WARP) revert WarpTooLong(by);
        _sync();
        clockOffset += by;
        emit Warped(by, clockOffset);
    }

    function _sync() internal {
        principal = totalAssets();
        syncedAt = clock();
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        _sync();
        super._deposit(caller, receiver, assets, shares);
        principal += assets;
    }

    /// @dev Simulated yield is paid in freshly minted test money, in chunks under the mint cap.
    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
    {
        _sync();
        uint256 held = IERC20(asset()).balanceOf(address(this));
        if (assets > held) {
            uint256 short = assets - held;
            TestUSDC asset_ = TestUSDC(asset());
            uint256 cap = asset_.MAX_MINT();
            while (short > 0) {
                uint256 chunk = short > cap ? cap : short;
                asset_.mint(address(this), chunk);
                short -= chunk;
            }
        }
        super._withdraw(caller, receiver, owner_, assets, shares);
        principal -= assets;
    }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd contracts && ~/.foundry/bin/forge test --match-contract DemoYieldVaultTest -vv 2>&1 | grep -E "\[PASS\]|\[FAIL\]|Suite result"`
Expected: eight `[PASS]` lines and `Suite result: ok. 8 passed`.

- [ ] **Step 7: Write the deploy script**

Create `contracts/script/DeployDemo.s.sol`:

```solidity
// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.25;

import { Script, console2 } from "forge-std/Script.sol";
import { TestUSDC } from "../src/demo/TestUSDC.sol";
import { DemoYieldVault } from "../src/demo/DemoYieldVault.sol";

/// forge script script/DeployDemo.s.sol --rpc-url $RPC_URL --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow
/// Deploys the test asset and the demo yield source for a testnet that has no USDC yield source. DEMO_OWNER (the
/// faucet signer, never the keeper) is the only address that can warp the vault's clock. DEMO_RATE_BPS defaults to
/// 450, which is 4.5% a year. Writes deployments/<chainId>-demo.json; Deploy.s.sol then takes its `target` as
/// TARGET_VAULT. Never for a chain where real money is.
contract DeployDemo is Script {
    function run() external {
        address owner = vm.envAddress("DEMO_OWNER");
        uint256 rateBps = vm.envOr("DEMO_RATE_BPS", uint256(450));

        vm.startBroadcast();
        TestUSDC usdc = new TestUSDC();
        DemoYieldVault vault = new DemoYieldVault(usdc, rateBps, owner);
        vm.stopBroadcast();

        string memory o = "demo";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "usdc", address(usdc));
        vm.serializeAddress(o, "target", address(vault));
        string memory json = vm.serializeUint(o, "rateBps", rateBps);
        string memory path = string.concat("deployments/", vm.toString(block.chainid), "-demo.json");
        vm.writeJson(json, path);
        console2.log("wrote", path);
    }
}
```

- [ ] **Step 8: Dry-run the deploy script in forge's local simulation and check the file it writes**

Without `--rpc-url` and `--broadcast`, `forge script` runs the script in a local EVM (chain id 31337) and still executes `vm.writeJson`:

```bash
cd contracts && DEMO_OWNER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 ~/.foundry/bin/forge script script/DeployDemo.s.sol 2>&1 | grep -E "wrote|Error|Script ran successfully"
cat deployments/31337-demo.json
rm -f deployments/31337-demo.json
```

Expected: `Script ran successfully`, `wrote deployments/31337-demo.json`, and the file holds `chainId: 31337`, `rateBps: 450`, a `target` and a `usdc` address. (The owner above is anvil's second default address, public and worthless; no key is needed for a simulation.)

- [ ] **Step 9: Run the whole contract suite**

Run: `cd contracts && ~/.foundry/bin/forge test --no-match-contract ForkTest 2>&1 | grep -E "tests passed|failed"`
Expected: `29 tests passed, 0 failed`.

- [ ] **Step 10: Commit**

```bash
git add contracts/src/demo/TestUSDC.sol contracts/src/demo/DemoYieldVault.sol contracts/test/DemoYieldVault.t.sol contracts/script/DeployDemo.s.sol
git commit -m "Add a test asset and a demo yield vault for a testnet without a USDC yield source

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 2: Faucet modes in the config, and the chain named from config

**Files:**
- Modify: `app/config.ts`
- Modify: `app/chain.ts:53-56`
- Modify: `app/test/config.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: on `Config`: `faucetMode?: "cheat" | "mint"`, `faucetKey?: Hex`, `demoFund?: { nativeWei: bigint; warpTargets: Hex[] }`; `demoFaucet` is true in either mode. Task 4 wires the faucet from these three. The chain config's `demo` block is `{ "fundNative": "<amount in whole native units, up to 18 decimals>", "warpTargets": ["<address>"] }`.

- [ ] **Step 1: Branch**

```bash
cd "$S/wt-monad" && git checkout -b task-2-config-modes monad-testnet
```

- [ ] **Step 2: Write the failing tests**

Append to `app/test/config.test.ts`:

```ts
test("DEMO_FAUCET=1 keeps the fork's cheat faucet and needs nothing else", () => {
  const cfg = loadConfig({ ...envFor(42161, 42161), DEMO_FAUCET: "1" });
  assert.equal(cfg.demoFaucet, true);
  assert.equal(cfg.faucetMode, "cheat");
  assert.equal(cfg.faucetKey, undefined);
  assert.equal(cfg.demoFund, undefined);
  assert.equal(loadConfig(envFor(42161, 42161)).faucetMode, undefined);
});

test("DEMO_FAUCET=mint needs the chain config's demo block and a faucet key of its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "inferest-config-"));
  const chainPath = join(dir, "chain.json");
  const depPath = join(dir, "deployments.json");
  const target = "0x" + "02".repeat(20);
  const faucetKey = "0x" + "07".repeat(32); // synthetic, never funded
  const write = (demo: unknown) => writeFileSync(chainPath, JSON.stringify({
    chainId: 10143, usdc: "0x01", target, targets: [{ address: target, name: "Demo" }], demo,
  }));
  writeFileSync(depPath, JSON.stringify({ chainId: 10143, target, targets: [target], factory: "0x03", splitter: "0x04" }));
  const env = { ...envFor(10143, 10143), CHAIN_CONFIG: chainPath, DEPLOYMENTS: depPath, DEMO_FAUCET: "mint", DEMO_FAUCET_PRIVATE_KEY: faucetKey };

  write(undefined);
  assert.throws(() => loadConfig(env), /DEMO_FAUCET=mint needs demo.fundNative and demo.warpTargets in the chain config/);

  write({ fundNative: "0.5", warpTargets: [target] });
  const cfg = loadConfig(env);
  assert.equal(cfg.demoFaucet, true);
  assert.equal(cfg.faucetMode, "mint");
  assert.equal(cfg.faucetKey, faucetKey);
  assert.deepEqual(cfg.demoFund, { nativeWei: 500_000_000_000_000_000n, warpTargets: [target] });
  assert.throws(() => loadConfig({ ...env, DEMO_FAUCET_PRIVATE_KEY: "" }), /missing env DEMO_FAUCET_PRIVATE_KEY/);
  assert.throws(() => loadConfig({ ...env, DEMO_FAUCET_PRIVATE_KEY: "0x05" }), /DEMO_FAUCET_PRIVATE_KEY must be 32 bytes/);
  assert.throws(() => loadConfig({ ...env, KEEPER_PRIVATE_KEY: faucetKey }), /DEMO_FAUCET_PRIVATE_KEY must not be the keeper's key/);

  write({ fundNative: "abc", warpTargets: [target] });
  assert.throws(() => loadConfig(env), /demo.fundNative must be a nonnegative amount/);
  write({ fundNative: "0.5", warpTargets: ["0x" + "09".repeat(20)] });
  assert.throws(() => loadConfig(env), /is not one of the chain config's targets/);
  write({ fundNative: "0.5", warpTargets: ["nope"] });
  assert.throws(() => loadConfig(env), /demo.warpTargets entry nope must be one 20-byte hex address/);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test --test-timeout=60000 --test-force-exit app/test/config.test.ts 2>&1 | grep -E "^(✔|✖|ℹ (pass|fail))"`
Expected: both new tests `✖`, `fail 2` (the first fails on `faucetMode`, the second on the missing error).

- [ ] **Step 4: Extend `Config` and `loadConfig`**

In `app/config.ts`, add to the `Config` type after `demoFaucet: boolean;`:

```ts
  /** How POST /api/demo/fund works: "cheat" over a fork's cheat methods (DEMO_FAUCET=1), "mint" over the demo
   *  contracts of a live testnet (DEMO_FAUCET=mint). Unset means no faucet and a real chain. */
  faucetMode?: "cheat" | "mint";
  /** Mint mode: the signer that mints test USDC, sends gas and warps the demo yield sources. Never the keeper. */
  faucetKey?: Hex;
  /** Mint mode: gas sent per fund, and the demo yield sources whose clocks the warp route moves. */
  demoFund?: { nativeWei: bigint; warpTargets: Hex[] };
```

In `loadConfig`, after the `for (const t of targets) if (!allowlisted.has(...)) ...` line, add:

```ts
  const faucetMode: Config["faucetMode"] = env.DEMO_FAUCET === "1" ? "cheat" : env.DEMO_FAUCET === "mint" ? "mint" : undefined;
  let faucetKey: Hex | undefined;
  let demoFund: Config["demoFund"];
  if (faucetMode === "mint") {
    const demo = chain.demo;
    if (!demo || typeof demo.fundNative !== "string" || !Array.isArray(demo.warpTargets)) {
      throw new Error("DEMO_FAUCET=mint needs demo.fundNative and demo.warpTargets in the chain config");
    }
    if (!/^\d+(?:\.\d{1,18})?$/.test(demo.fundNative)) throw new Error("demo.fundNative must be a nonnegative amount with at most 18 decimal places");
    const known = new Set(targets.map((t) => t.address.toLowerCase()));
    const warpTargets = (demo.warpTargets as unknown[]).map((t) => String(t));
    for (const t of warpTargets) {
      if (!/^0x[0-9a-f]{40}$/i.test(t)) throw new Error(`demo.warpTargets entry ${t} must be one 20-byte hex address`);
      if (!known.has(t.toLowerCase())) throw new Error(`demo.warpTargets entry ${t} is not one of the chain config's targets`);
    }
    const key = need("DEMO_FAUCET_PRIVATE_KEY");
    if (!/^0x[0-9a-f]{64}$/i.test(key)) throw new Error("DEMO_FAUCET_PRIVATE_KEY must be 32 bytes as 0x plus 64 hex characters");
    if (key.toLowerCase() === need("KEEPER_PRIVATE_KEY").toLowerCase()) throw new Error("DEMO_FAUCET_PRIVATE_KEY must not be the keeper's key");
    faucetKey = key as Hex;
    demoFund = { nativeWei: parseEther(demo.fundNative), warpTargets: warpTargets as Hex[] };
  }
```

In the returned object, replace `demoFaucet: env.DEMO_FAUCET === "1",` with:

```ts
    demoFaucet: faucetMode !== undefined,
    faucetMode,
    faucetKey,
    demoFund,
```

- [ ] **Step 5: Name the chain from config in `makeChain`**

In `app/chain.ts`, replace the `defineChain` call (lines 53 to 56) with:

```ts
  const chain = defineChain({
    id: cfg.chainId, name: cfg.chainName, nativeCurrency: cfg.nativeCurrency,
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
```

This is not observable from the RPC (the signed transaction carries only the chain id, which `chain.test.ts` already pins), so it has no test of its own; typecheck covers the shape.

- [ ] **Step 6: Run the tests to verify they pass, and the whole suite**

Run: `node --test --test-timeout=60000 --test-force-exit app/test/config.test.ts 2>&1 | grep -E "^ℹ (pass|fail)" && npm test -- --test-timeout=60000 --test-force-exit 2>&1 | grep -E "^ℹ (tests|pass|fail)" && npm run typecheck`
Expected: config `fail 0`; `tests 344`, `pass 344`, `fail 0`; typecheck silent.

- [ ] **Step 7: Document the two variables**

In `.env.example`, replace the two lines

```
# 1 exposes POST /api/demo/fund, which funds a signed-in wallet through the fork's cheat methods; never on a real chain
DEMO_FAUCET=
```

with

```
# 1 exposes POST /api/demo/fund over a fork's cheat methods; mint exposes it over the demo contracts of a live testnet
# (config/monad-testnet.json) and adds the operator-only POST /api/demo/warp; never on a real chain
DEMO_FAUCET=
# mint mode only: the signer that mints test USDC, sends gas and warps the demo yield sources; it owns them; never the keeper's key
DEMO_FAUCET_PRIVATE_KEY=
```

- [ ] **Step 8: Commit**

```bash
git add app/config.ts app/chain.ts app/test/config.test.ts .env.example
git commit -m "Let DEMO_FAUCET select a fork's cheat faucet or a testnet's mint faucet, and name the chain from config

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 3: The mint faucet

**Files:**
- Modify: `app/faucet.ts`
- Modify: `app/test/faucet.test.ts`

**Interfaces:**
- Consumes: `TestUSDC.mint(address,uint256)` and `DemoYieldVault.warp(uint256)` from Task 1.
- Produces: `Faucet` gains `warp?(seconds: bigint): Promise<string[]>`; `createMintFaucet(d: { rpcUrl: string; chainId: number; chainName: string; nativeCurrency: { name: string; symbol: string; decimals: number }; usdc: Hex; signerKey: Hex; nativeWei: bigint; warpTargets: Hex[] }): Faucet`; `class FaucetDry extends Error`; `MAX_WARP_SECONDS = 315_360_000n`. Task 4 wires and maps these.

- [ ] **Step 1: Branch**

```bash
cd "$S/wt-monad" && git checkout -b task-3-mint-faucet monad-testnet
```

- [ ] **Step 2: Write the failing tests**

Append to `app/test/faucet.test.ts` (and extend its first import line to `import { test, type TestContext } from "node:test";`):

```ts
import { decodeFunctionData, keccak256, parseAbi, parseTransaction, toHex, type Hex } from "viem";
import { createMintFaucet, FaucetDry, MAX_WARP_SECONDS } from "../faucet.ts";

const FAUCET_KEY = `0x${"07".repeat(32)}` as Hex; // synthetic, never funded
const TUSDC = "0x00000000000000000000000000000000000000dd";
const VAULT_A = "0x00000000000000000000000000000000000000ee";
const VAULT_B = "0x00000000000000000000000000000000000000ef";
const NATIVE = 500_000_000_000_000_000n; // 0.5 MON
const mintAbi = parseAbi(["function mint(address to, uint256 amount)"]);
const warpAbi = parseAbi(["function warp(uint256 by)"]);

/** A node fake for viem's send path: every raw transaction is accepted and reported mined (or reverted). */
function node(t: TestContext, options: { balance?: bigint; revert?: boolean } = {}) {
  const sent: Hex[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    const { id, method, params } = JSON.parse(String(init.body));
    let result: unknown;
    switch (method) {
      case "eth_fillTransaction": return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "unsupported" } });
      case "eth_chainId": result = toHex(10143); break;
      case "eth_getTransactionCount": result = toHex(sent.length); break;
      case "eth_getBlockByNumber": result = { number: "0x1", hash: "0x" + "01".repeat(32), transactions: [], baseFeePerGas: toHex(100_000_000_000n) }; break;
      case "eth_maxPriorityFeePerGas": result = toHex(2_000_000_000n); break;
      case "eth_gasPrice": result = toHex(102_000_000_000n); break;
      case "eth_estimateGas": result = toHex(60_000n); break;
      case "eth_getBalance": result = toHex(options.balance ?? NATIVE * 10n); break;
      case "eth_sendRawTransaction": sent.push(params[0]); result = keccak256(params[0]); break;
      case "eth_getTransactionReceipt": result = {
        transactionHash: params[0], status: options.revert ? "0x0" : "0x1", blockHash: "0x" + "01".repeat(32), blockNumber: "0x1",
        transactionIndex: "0x0", cumulativeGasUsed: "0xea60", gasUsed: "0xea60", logs: [], logsBloom: "0x" + "00".repeat(256),
        effectiveGasPrice: toHex(102_000_000_000n), type: "0x2",
      }; break;
      default: throw new Error(`unexpected RPC method ${method}`);
    }
    return Response.json({ jsonrpc: "2.0", id, result });
  });
  return { sent, decoded: () => sent.map((raw) => parseTransaction(raw)) };
}

const mintFaucet = (over: Partial<Parameters<typeof createMintFaucet>[0]> = {}) => createMintFaucet({
  rpcUrl: "http://faucet-rpc.invalid", chainId: 10143, chainName: "Monad Testnet",
  nativeCurrency: { name: "Testnet MON Token", symbol: "MON", decimals: 18 },
  usdc: TUSDC, signerKey: FAUCET_KEY, nativeWei: NATIVE, warpTargets: [VAULT_A, VAULT_B], ...over,
});

test("the mint faucet mints test USDC to the wallet and then sends it gas", async (t) => {
  const { decoded } = node(t);
  const r = await mintFaucet().fund(TO);
  assert.deepEqual(r, { native: NATIVE, usdc: FAUCET_USDC });
  const [mint, gas] = decoded();
  assert.equal(mint.to?.toLowerCase(), TUSDC);
  assert.equal(mint.chainId, 10143);
  const call = decodeFunctionData({ abi: mintAbi, data: mint.data! });
  assert.equal(call.functionName, "mint");
  assert.equal(String(call.args![0]).toLowerCase(), TO);
  assert.equal(call.args![1], FAUCET_USDC);
  assert.equal(gas.to?.toLowerCase(), TO);
  assert.equal(gas.value, NATIVE);
  assert.equal(gas.data, undefined);
});

test("the mint faucet sends no gas when fundNative is zero", async (t) => {
  const { sent } = node(t);
  const r = await mintFaucet({ nativeWei: 0n }).fund(TO);
  assert.equal(r.native, 0n);
  assert.equal(sent.length, 1);
});

test("a nearly dry faucet signer refuses before minting anything", async (t) => {
  const { sent } = node(t, { balance: NATIVE * 2n - 1n });
  await assert.rejects(mintFaucet().fund(TO), (e: unknown) => e instanceof FaucetDry && /holds too little MON to fund a wallet/.test((e as Error).message));
  assert.equal(sent.length, 0);
});

test("a reverted faucet transaction is reported with its hash", async (t) => {
  const { sent } = node(t, { revert: true });
  await assert.rejects(mintFaucet().fund(TO), /faucet transaction reverted: 0x[0-9a-f]{64}/);
  assert.equal(sent.length, 1);
});

test("warp moves every demo yield source's clock and returns one hash per source", async (t) => {
  const { sent, decoded } = node(t);
  const txs = await mintFaucet().warp!(15_768_000n);
  assert.deepEqual(txs, sent.map((raw) => keccak256(raw)));
  const [a, b] = decoded();
  assert.equal(a.to?.toLowerCase(), VAULT_A);
  assert.equal(b.to?.toLowerCase(), VAULT_B);
  for (const tx of [a, b]) assert.deepEqual(decodeFunctionData({ abi: warpAbi, data: tx.data! }), { functionName: "warp", args: [15_768_000n] });
});

test("warp refuses zero, negative and more than ten years without a transaction", async (t) => {
  const { sent } = node(t);
  for (const by of [0n, -1n, MAX_WARP_SECONDS + 1n]) await assert.rejects(mintFaucet().warp!(by), /between one second and ten years/);
  assert.equal(sent.length, 0);
});

test("the cheat faucet has no warp: a fork moves its own clock", () => {
  assert.equal(createFaucet({ rpcUrl: "http://rpc", usdc: USDC }).warp, undefined);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test --test-timeout=60000 --test-force-exit app/test/faucet.test.ts 2>&1 | grep -E "^(✖|ℹ (pass|fail))" | head`
Expected: the file fails to load (`createMintFaucet` is not exported), `fail` at least 1.

- [ ] **Step 4: Implement the mint faucet**

In `app/faucet.ts`, replace the first line (`import { encodeAbiParameters, ... } from "viem";`) with:

```ts
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, http, keccak256, pad, parseAbi, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
```

Replace the `Faucet` type with:

```ts
export type Faucet = {
  fund(address: string): Promise<{ native: bigint; usdc: bigint }>;
  /** Moves the demo yield sources' clocks forward by `seconds` and returns the transaction hashes. Absent on a
   *  fork, where the chain's own clock moves through evm_increaseTime. */
  warp?(seconds: bigint): Promise<string[]>;
};

/** The faucet signer cannot cover a fund. The route answers 503 with this message instead of a stack trace. */
export class FaucetDry extends Error {}

/** The most one warp may move a demo clock: DemoYieldVault.MAX_WARP, ten years. */
export const MAX_WARP_SECONDS = 10n * 365n * 86_400n;
```

Append at the end of the file:

```ts
const testUsdcAbi = parseAbi(["function mint(address to, uint256 amount)"]);
const demoVaultAbi = parseAbi(["function warp(uint256 by)"]);

/**
 * Funds a wallet on a live testnet that carries the demo contracts: mints FAUCET_USDC of test USDC to it, then
 * sends it `nativeWei` of gas from the faucet signer. The same signer owns every demo yield source and moves
 * their clocks on warp(). It is never the keeper, so a faucet transaction from a public route cannot take a
 * nonce the keeper is about to use.
 */
export function createMintFaucet(d: {
  rpcUrl: string; chainId: number; chainName: string; nativeCurrency: { name: string; symbol: string; decimals: number };
  usdc: Hex; signerKey: Hex; nativeWei: bigint; warpTargets: Hex[];
}): Faucet {
  const chain = defineChain({
    id: d.chainId, name: d.chainName, nativeCurrency: d.nativeCurrency, rpcUrls: { default: { http: [d.rpcUrl] } },
  });
  const account = privateKeyToAccount(d.signerKey);
  const pub = createPublicClient({ chain, transport: http(d.rpcUrl) });
  const wallet = createWalletClient({ chain, account, transport: http(d.rpcUrl) });
  const mined = async (hash: Hex): Promise<string> => {
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`faucet transaction reverted: ${hash}`);
    return hash;
  };
  return {
    async fund(address) {
      const to = address as Hex;
      const balance = await pub.getBalance({ address: account.address });
      if (balance < d.nativeWei * 2n) {
        throw new FaucetDry(`the faucet signer ${account.address} holds too little ${d.nativeCurrency.symbol} to fund a wallet`);
      }
      await mined(await wallet.writeContract({ address: d.usdc, abi: testUsdcAbi, functionName: "mint", args: [to, FAUCET_USDC] }));
      if (d.nativeWei > 0n) await mined(await wallet.sendTransaction({ to, value: d.nativeWei }));
      return { native: d.nativeWei, usdc: FAUCET_USDC };
    },
    async warp(seconds) {
      if (!(seconds > 0n && seconds <= MAX_WARP_SECONDS)) throw new Error("warp must be between one second and ten years");
      const txs: string[] = [];
      for (const target of d.warpTargets) {
        txs.push(await mined(await wallet.writeContract({ address: target, abi: demoVaultAbi, functionName: "warp", args: [seconds] })));
      }
      return txs;
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass, and the whole suite**

Run: `node --test --test-timeout=60000 --test-force-exit app/test/faucet.test.ts 2>&1 | grep -E "^ℹ (pass|fail)" && npm test -- --test-timeout=60000 --test-force-exit 2>&1 | grep -E "^ℹ (tests|pass|fail)" && npm run typecheck`
Expected: faucet `pass 12`, `fail 0`; `tests 351`, `pass 351`, `fail 0`; typecheck silent. If a test fails with `unexpected RPC method <name>`, viem asked the node something the fake does not answer: add that method to the fake's switch with a sensible value, the way `app/test/chain.test.ts` does, rather than loosening the assertion.

- [ ] **Step 6: Commit**

```bash
git add app/faucet.ts app/test/faucet.test.ts
git commit -m "Add a faucet that mints test USDC, sends gas and warps the demo yield sources on a live testnet

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 4: The warp route, a 503 for a dry faucet, and the CLI wiring

**Files:**
- Modify: `app/server.ts:12` (import), the `/api/demo/fund` route (around line 300), and a new route after it
- Modify: `app/cli.ts:13` (import) and the `faucet:` line in `createApp` (around line 47)
- Modify: `app/test/server.test.ts` (the `start` helper, three new tests)

**Interfaces:**
- Consumes: `Faucet.warp`, `FaucetDry`, `MAX_WARP_SECONDS` from Task 3; `Config.faucetMode`, `faucetKey`, `demoFund` from Task 2.
- Produces: `POST /api/demo/warp { seconds }` answering `{ ok: true, seconds, txs: string[] }`; operator only; 404 when the faucet has no warp; 400 outside `[1, 315360000]`. `POST /api/demo/fund` answers 503 `{ error }` on `FaucetDry`. Task 5 calls the warp route from the demo script and the agent runner.

- [ ] **Step 1: Branch**

```bash
cd "$S/wt-monad" && git checkout -b task-4-warp-route monad-testnet
```

- [ ] **Step 2: Extend the test helper and write the failing tests**

In `app/test/server.test.ts`, add after the `createAuth` import:

```ts
import { FaucetDry } from "../faucet.ts";
```

Change the `start` signature's `opts` type to:

```ts
opts: { login?: boolean; faucet?: (address: string) => void; warp?: (seconds: bigint) => string[]; dry?: boolean; ownerCooldown?: AppDeps["ownerCooldown"] } = {}
```

and replace the `faucet:` line inside `start` with:

```ts
    faucet: opts.faucet || opts.warp ? {
      fund: async (a) => {
        if (opts.dry) throw new FaucetDry("the faucet signer 0x00000000000000000000000000000000000000ff holds too little MON to fund a wallet");
        opts.faucet?.(a);
        return { native: 10n ** 18n, usdc: 100_000_000_000n };
      },
      ...(opts.warp ? { warp: async (s: bigint) => opts.warp!(s) } : {}),
    } : undefined,
```

Append after the test `the faucet funds a session's own wallet and refuses a foreign address`:

```ts
test("the warp route is operator-only, validates seconds and reports the transactions", async () => {
  const warped: bigint[] = [];
  const { base, server } = await start(undefined, { faucet: () => {}, warp: (s) => { warped.push(s); return ["0xaa", "0xbb"]; } });
  const ok = await post(base, "/api/demo/warp", { seconds: 15_768_000 });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, seconds: 15_768_000, txs: ["0xaa", "0xbb"] });
  assert.deepEqual(warped, [15_768_000n]);
  assert.equal((await postAs(base, "/api/demo/warp", { seconds: 60 }, tokenFor([OWNER]))).status, 403);
  for (const seconds of [0, -5, 1.5, "soon", 315_360_001]) {
    assert.equal((await post(base, "/api/demo/warp", { seconds })).status, 400, `seconds ${seconds}`);
  }
  assert.equal((await fetch(base + "/api/demo/warp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seconds: 60 }) })).status, 401);
  assert.equal(warped.length, 1);
  server.close();
});

test("the warp route is absent on a fork, where the faucet has no warp", async () => {
  const { base, server } = await start(undefined, { faucet: () => {} });
  assert.equal((await post(base, "/api/demo/warp", { seconds: 60 })).status, 404);
  assert.equal((await post(base, "/api/demo/fund", { address: OTHER })).status, 200);
  server.close();
});

test("a dry faucet answers 503 with the reason", async () => {
  const { base, server } = await start(undefined, { faucet: () => {}, dry: true });
  const r = await post(base, "/api/demo/fund", { address: OTHER });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /holds too little MON to fund a wallet/);
  server.close();
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test --test-timeout=60000 --test-force-exit app/test/server.test.ts 2>&1 | grep -E "^(✖|ℹ (pass|fail))"`
Expected: the three new tests `✖`, `fail 3` (404 instead of 200, 404 instead of 404 passes only the second assertion, 500 instead of 503).

- [ ] **Step 4: Add the route and the 503 mapping**

In `app/server.ts`, replace line 12 with:

```ts
import { FaucetDry, MAX_WARP_SECONDS, type Faucet } from "./faucet.ts";
```

In the `/api/demo/fund` route, replace

```ts
      const funded = await d.faucet.fund(address);
```

with

```ts
      let funded: { native: bigint; usdc: bigint };
      try {
        funded = await d.faucet.fund(address);
      } catch (e) {
        if (!(e instanceof FaucetDry)) throw e;
        d.keeper.log(`faucet dry: ${e.message}`);
        return send(res, 503, { error: e.message });
      }
```

Immediately after that route's closing brace, add:

```ts
    if (url.pathname === "/api/demo/warp") {
      if (!d.faucet?.warp) return send(res, 404, { error: "not found" });
      if (caller.kind !== "operator") return send(res, 403, { error: "operator only" });
      const seconds = Number(body.seconds);
      if (!Number.isInteger(seconds) || seconds < 1 || BigInt(seconds) > MAX_WARP_SECONDS) {
        return send(res, 400, { error: "seconds must be a whole number between 1 and ten years" });
      }
      const txs = await d.faucet.warp(BigInt(seconds));
      d.keeper.log(`demo clock moved ${seconds} seconds in ${txs.length} transactions`);
      return send(res, 200, { ok: true, seconds, txs });
    }
```

- [ ] **Step 5: Wire the faucet by mode in the CLI**

In `app/cli.ts`, replace line 13 with:

```ts
import { createFaucet, createMintFaucet, type Faucet } from "./faucet.ts";
```

Before `const [cmd, arg] = process.argv.slice(2);`, add:

```ts
/** The demo faucet: a fork's cheat methods, or minted test money and gas on a live testnet. Unset on a real chain. */
const faucet: Faucet | undefined = cfg.faucetMode === "cheat"
  ? createFaucet({ rpcUrl: cfg.rpcUrl, usdc: cfg.usdc })
  : cfg.faucetMode === "mint" && cfg.faucetKey && cfg.demoFund
    ? createMintFaucet({
        rpcUrl: cfg.rpcUrl, chainId: cfg.chainId, chainName: cfg.chainName, nativeCurrency: cfg.nativeCurrency,
        usdc: cfg.usdc, signerKey: cfg.faucetKey, nativeWei: cfg.demoFund.nativeWei, warpTargets: cfg.demoFund.warpTargets,
      })
    : undefined;
```

and replace the line `faucet: cfg.demoFaucet ? createFaucet({ rpcUrl: cfg.rpcUrl, usdc: cfg.usdc }) : undefined,` inside `createApp({...})` with `faucet,`.

- [ ] **Step 6: Run the tests to verify they pass, and the whole suite**

Run: `node --test --test-timeout=60000 --test-force-exit app/test/server.test.ts 2>&1 | grep -E "^ℹ (pass|fail)" && npm test -- --test-timeout=60000 --test-force-exit 2>&1 | grep -E "^ℹ (tests|pass|fail)" && npm run typecheck`
Expected: server `fail 0`; `tests 354`, `pass 354`, `fail 0`; typecheck silent.

- [ ] **Step 7: Commit**

```bash
git add app/server.ts app/cli.ts app/test/server.test.ts
git commit -m "Add the operator warp route, answer 503 when the faucet is dry, and build the faucet by mode

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 5: The demo script and the agent runner on a live testnet

**Files:**
- Create: `app/demo-clock.ts`
- Create: `app/test/demo-clock.test.ts`
- Modify: `demo/lib.ts:1-5, 25-29, 39`
- Modify: `agent/run.ts:12, 95-98, 115-126`
- Modify: `docs/09-runner-safety-review.md:115` (one clause)

**Interfaces:**
- Consumes: `POST /api/demo/warp` and `POST /api/demo/fund` from Task 4.
- Produces: `moveClock(d: { rpc: (method: string, params: unknown[]) => Promise<unknown>; api: (path: string, body?: unknown) => Promise<unknown>; seconds: number }): Promise<"chain" | "sources">`.

- [ ] **Step 1: Branch**

```bash
cd "$S/wt-monad" && git checkout -b task-5-demo-clock monad-testnet
```

- [ ] **Step 2: Write the failing tests**

Create `app/test/demo-clock.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { moveClock } from "../demo-clock.ts";

test("moves the chain's own clock when the node has evm_increaseTime", async () => {
  const calls: [string, unknown[]][] = [];
  const posts: string[] = [];
  const how = await moveClock({
    rpc: async (method, params) => { calls.push([method, params]); return null; },
    api: async (path) => { posts.push(path); return {}; },
    seconds: 604_800,
  });
  assert.equal(how, "chain");
  assert.deepEqual(calls, [["evm_increaseTime", ["0x93a80"]], ["evm_mine", []]]);
  assert.deepEqual(posts, []);
});

test("falls back to the server's warp route when the node does not know the method", async () => {
  const bodies: unknown[] = [];
  for (const message of ["evm_increaseTime: Method not found", "evm_increaseTime: the method evm_increaseTime does not exist/is not available"]) {
    bodies.length = 0;
    const how = await moveClock({
      rpc: async () => { throw new Error(message); },
      api: async (_path, body) => { bodies.push(body); return {}; },
      seconds: 604_800,
    });
    assert.equal(how, "sources");
    assert.deepEqual(bodies, [{ seconds: 604_800 }]);
  }
});

test("a node error with the JSON-RPC code for an unknown method also falls back", async () => {
  const bodies: unknown[] = [];
  const how = await moveClock({
    rpc: async () => { throw Object.assign(new Error("evm_increaseTime: nope"), { code: -32601 }); },
    api: async (_path, body) => { bodies.push(body); return {}; },
    seconds: 60,
  });
  assert.equal(how, "sources");
  assert.deepEqual(bodies, [{ seconds: 60 }]);
});

test("any other node error is not swallowed", async () => {
  await assert.rejects(moveClock({
    rpc: async () => { throw new Error("evm_increaseTime: connection refused"); },
    api: async () => ({}),
    seconds: 1,
  }), /connection refused/);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test --test-timeout=60000 --test-force-exit app/test/demo-clock.test.ts 2>&1 | grep -E "^(✖|ℹ (pass|fail))" | head -3`
Expected: the file fails to load (`../demo-clock.ts` not found).

- [ ] **Step 4: Write the helper**

Create `app/demo-clock.ts`:

```ts
import { toHex } from "viem";

/** A node that does not implement a method: anvil's and Tenderly's wording, Monad's, and the JSON-RPC code. */
function unknownMethod(e: unknown): boolean {
  const err = e as { code?: number; message?: string };
  return err.code === -32601 || /method not found|not supported|does not exist|not available/i.test(err.message ?? "");
}

/**
 * Moves the demo clock forward by `seconds`: the chain's own clock on a fork (evm_increaseTime, then a block), or
 * the demo yield sources' clocks through the server's operator warp route on a live testnet that has no such
 * method. Returns which one moved. Any node error other than an unknown method is rethrown.
 */
export async function moveClock(d: {
  rpc: (method: string, params: unknown[]) => Promise<unknown>;
  api: (path: string, body?: unknown) => Promise<unknown>;
  seconds: number;
}): Promise<"chain" | "sources"> {
  try {
    await d.rpc("evm_increaseTime", [toHex(d.seconds)]);
    await d.rpc("evm_mine", []);
    return "chain";
  } catch (e) {
    if (!unknownMethod(e)) throw e;
  }
  await d.api("/api/demo/warp", { seconds: d.seconds });
  return "sources";
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test --test-timeout=60000 --test-force-exit app/test/demo-clock.test.ts 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: `pass 4`, `fail 0`.

- [ ] **Step 6: Use it in the demo script**

In `demo/lib.ts`:

Replace line 4 (`import { createFaucet } from "../app/faucet.ts";`) with:

```ts
import { moveClock } from "../app/demo-clock.ts";
```

Remove `toHex, ` from the viem import on line 2; nothing else in the file uses it once `warp` changes.

Replace lines 25 to 29 (from `export const warp = ...` through `export const fundDemoWallet = ...`) with:

```ts
/** Moves the demo clock: the fork's own, or the demo yield sources' through the server on a live testnet. */
export const warp = async (seconds: number) => { await moveClock({ rpc, api, seconds }); };

/** Gas plus 100,000 USDC through the server's faucet route: a fork's cheat methods, or minted test money on a live testnet. */
export const fundDemoWallet = async (to: string) => { await api("/api/demo/fund", { address: to }); };
```

Replace line 39 (the `defineChain` line) with:

```ts
const chain = defineChain({
  id: Number(dep.chainId), name: String(chainCfg.name ?? "fork"),
  nativeCurrency: chainCfg.nativeCurrency ?? { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
```

`api` is a function declaration below, so the hoisting is fine; keep `warp` and `fundDemoWallet` where the old lines were.

- [ ] **Step 7: Use it in the agent runner**

In `agent/run.ts`:

Replace line 12 (`import { createFaucet } from "../app/faucet.ts";`) with:

```ts
import { moveClock } from "../app/demo-clock.ts";
```

Change line 1 to `import { createWalletClient, http, type Hex } from "viem";` (the only `toHex` use was in `advanceClock`).

Replace the two lines

```ts
  // only a wallet the faucet funded in this start is trimmed: a pre-funded wallet, or any real chain, is never touched
  if (cfg.demoDays > 0 && (await usdcBalance()) === 0n) {
    await createFaucet({ rpcUrl: cfg.rpcUrl, usdc }).fund(address);
```

with

```ts
  // only a wallet the faucet funded in this start is trimmed: a pre-funded wallet is never touched, and on a real
  // chain the server has no faucet route, so this call fails and the runner stops
  if (cfg.demoDays > 0 && (await usdcBalance()) === 0n) {
    await api("/api/demo/fund", { address });
```

Replace the body of `advanceClock` from `try {` through the closing of its `catch` with:

```ts
  try {
    await moveClock({ rpc, api, seconds: Math.round(cfg.demoDays * 86_400) });
  } catch (e) {
    console.log(`clock not advanced: ${errorOf(e)}`);
    return false;
  }
```

and update the function's doc comment to:

```ts
/**
 * On a fork or a Tenderly testnet, moves the chain clock so yield accrues between runs; on a live testnet with the
 * demo contracts, moves the demo yield sources' clocks through the server instead. Then has the server read it.
 * True only when this process moved a clock.
 */
```

- [ ] **Step 8: Fix the safety review's reference**

In `docs/09-runner-safety-review.md` line 115, replace `With an empty wallet the faucet's last method is refused and the agent stops (`app/faucet.ts:33-35`), which is safe.` with `With an empty wallet the server's faucet route answers 404 on a real chain and the agent stops (`agent/run.ts`, first start), which is safe.`

- [ ] **Step 9: Run everything**

Run: `npm test -- --test-timeout=60000 --test-force-exit 2>&1 | grep -E "^ℹ (tests|pass|fail)" && npm run typecheck && grep -n "createFaucet" demo/lib.ts agent/run.ts`
Expected: `tests 358`, `pass 358`, `fail 0`; typecheck silent; the grep prints nothing.

- [ ] **Step 10: Commit**

```bash
git add app/demo-clock.ts app/test/demo-clock.test.ts demo/lib.ts agent/run.ts docs/09-runner-safety-review.md
git commit -m "Move the demo clock through the server when the node cannot, and fund demo wallets through its faucet route

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 6: Docs, examples, ignore rules and page copy

**Files:**
- Modify: `.gitignore`, `contracts/foundry.toml`, `deploy/server.env.example`, `deploy/README.md:8-11`, `README.md:55` and `:61`, `docs/06-workflow.md` (Deployment section), `docs/08-status.md` (What is on main, How to run it, What is left item 4), `docs/07-walkthrough.md:6`, `app/dashboard/treasury.html:97`, `app/dashboard/app.js:98`

**Interfaces:** none in code. The docs describe `config/monad-testnet.json` and `contracts/deployments/monad-testnet.json`, which Task 7 writes.

- [ ] **Step 1: Branch**

```bash
cd "$S/wt-monad" && git checkout -b task-6-docs monad-testnet
```

- [ ] **Step 2: Ignore rules and the Foundry endpoint**

In `.gitignore`, after `!contracts/deployments/arbitrum-one.json` add:

```
!contracts/deployments/monad-testnet.json
```

In `contracts/foundry.toml`, under `[rpc_endpoints]` after the `arbitrum` line add:

```toml
monad_testnet = "${MONAD_TESTNET_RPC_URL}"
```

- [ ] **Step 3: The deploy examples**

In `deploy/server.env.example`, replace

```
# enable only on an explicitly verified disposable fork or virtual testnet.
DEMO_FAUCET=0
```

with

```
# 1 only on an explicitly verified disposable fork or virtual testnet; mint only on a live testnet that carries the demo contracts.
DEMO_FAUCET=0
# mint mode only: the demo vault owner, a funded wallet of its own, never the keeper's key.
DEMO_FAUCET_PRIVATE_KEY=
```

In `deploy/README.md`, replace lines 8 to 11 with:

```
Install Docker with Compose v2. Prepare an Arbitrum fork or virtual testnet and
its Inferest contracts using the [deployment workflow](../docs/06-workflow.md).
Compose does not start Anvil or deploy contracts. The default deployment record
is `contracts/deployments/42161.json`, with `config/arbitrum-one.json` as its config.
For Monad testnet, set `CHAIN_CONFIG_FILE=./config/monad-testnet.json` and
`DEPLOYMENTS_FILE=./contracts/deployments/10143.json`, and in `.env.server` set
`DEMO_FAUCET=mint` with `DEMO_FAUCET_PRIVATE_KEY` (the demo vault owner, a funded
wallet of its own); the status page has the full recipe.
```

- [ ] **Step 4: README**

In `README.md` line 55, after the sentence ending `` must match `config/arbitrum-one.json`'s `targets` list. `` add:

```
On a testnet with no USDC yield source, run `script/DeployDemo.s.sol` first with `DEMO_OWNER` set to the faucet signer (it writes `contracts/deployments/<chainId>-demo.json`) and pass that file's `target` as `TARGET_VAULT`; `config/monad-testnet.json` is the first such chain, and `DEMO_FAUCET=mint` serves the Treasury page's demo funds from those contracts.
```

In line 61, replace `` `DEMO_FAUCET=1` adds a "Get demo funds" button on a forked chain. `` with `` `DEMO_FAUCET=1` (a fork) or `DEMO_FAUCET=mint` (a live testnet carrying the demo contracts) adds a "Get demo funds" button. ``

- [ ] **Step 5: The workflow doc**

In `docs/06-workflow.md`, in the `## Deployment` list, after the `**Demos**` bullet add two bullets:

```
- **A testnet without a yield source.** `DemoYieldVault` (`contracts/src/demo/`) is an ERC-4626 vault over `TestUSDC` whose assets grow at a fixed annual rate on a clock its owner can move forward with `warp(seconds)`, minting the test asset to pay what it owes. `DeployDemo.s.sol` deploys both; `Deploy.s.sol` then allowlists the vault as `TARGET_VAULT`. With `DEMO_FAUCET=mint` the server mints demo funds from them and its operator-only `POST /api/demo/warp` moves that clock the way `evm_increaseTime` moves a fork's; the demo script and the agent runner fall back to it. Monad testnet runs this way: spec `docs/superpowers/specs/2026-10-11-monad-testnet-design.md`.
- **Monad.** Monad's EVM runs the Cancun bytecode unchanged. Gas is charged on the limit, not on usage, so `KEEPER_MAX_TX_COST_ETH` (in MON there) is the exact charge; blocks are about 300 ms; verification is Sourcify's Monad instance. Monad mainnet has Circle USDC and Aave's static USDC wrapper, so a mainnet config would need no new contracts.
```

- [ ] **Step 6: The status page**

In `docs/08-status.md`:

In the "What is on main" table, after the `Contracts` row add:

```
| Demo chain contracts | `TestUSDC` and `DemoYieldVault` for a testnet with no USDC yield source: a fixed simulated rate on a clock the faucet signer can warp; `DeployDemo.s.sol`; the mint faucet and the warp route behind `DEMO_FAUCET=mint` | `contracts/src/demo/`, `app/faucet.ts`, spec `docs/superpowers/specs/2026-10-11-monad-testnet-design.md` |
```

After the "Browser checks in this project..." paragraph, add a subsection:

```
### Monad testnet

Monad testnet (chain id 10143) has no USDC yield source, so the demo runs over our `DemoYieldVault` and `TestUSDC`. Facts and decisions: `docs/superpowers/specs/2026-10-11-monad-testnet-design.md`.

Fork mode, as above, with `anvil --fork-url https://testnet-rpc.monad.xyz --port 8545` and `DEMO_FAUCET=1`; the cheat faucet and the clock warp work on the fork.

Live mode, in `.env.local`: `RPC_URL=https://testnet-rpc.monad.xyz`, `PUBLIC_RPC_URL=https://testnet-rpc.monad.xyz`, `CHAIN_CONFIG=config/monad-testnet.json`, `DEPLOYMENTS=contracts/deployments/10143.json`, `DEMO_FAUCET=mint`, `DEMO_FAUCET_PRIVATE_KEY` (the demo vault owner), `KEEPER_PRIVATE_KEY`, both holding MON from `https://faucet.monad.xyz`; `AGENT_DEMO_DAYS=7` for the agent. Then:

1. Deploy once, in this order (the README's deploy line, with `DEMO_OWNER` = the faucet signer's address): `forge script script/DeployDemo.s.sol ...` writes `contracts/deployments/10143-demo.json`; `TARGET_VAULT=<its target> forge script script/Deploy.s.sol ...` writes `contracts/deployments/10143.json`. The reviewed public record is `contracts/deployments/monad-testnet.json`.
2. `npm run serve`, then `npm run demo:treasury`: its "six months pass" step moves the demo vault's clock through `POST /api/demo/warp`, and the rest runs as on a fork. To move months by hand: `curl -X POST -H "x-admin-token: $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"seconds":15768000}' http://localhost:8787/api/demo/warp`, then Report yield on the page.
3. Treasury page: `docs/07-walkthrough.md`; "Get demo funds" mints 100,000 tUSDC and sends 0.5 MON. The faucet route answers 503 when the faucet signer runs low; top it up from the Monad faucet.
4. Agent: `npm run agent -- --once` as above; each run warps the demo vault a week through the server, so the run cards show real dates while the yield jumps.
```

In "What is left" item 4, append after `nothing in code.`:

```
Monad testnet is built through to the deploy: the demo contracts, the mint faucet, the warp route and the fallbacks are on main; what is left is the deployment, the record, and a walkthrough (Task 7 of the plan).
```

- [ ] **Step 7: Page and walkthrough copy**

In `app/dashboard/treasury.html` line 97, change `Gas and 100,000 USDC on the demo fork. One click.` to `Gas and 100,000 USDC on the demo chain. One click.`

In `app/dashboard/app.js` line 98, change `" · demo fork"` to `" · demo chain"`.

In `docs/07-walkthrough.md` line 6, change `one click funds your wallet with gas and 100,000 USDC on the fork.` to `one click funds your wallet with gas and 100,000 USDC on the demo chain.`

These are two words on a page; the screenshot acceptance happens in Task 7's walkthrough.

- [ ] **Step 8: Check the prose and the suite**

Run: `grep -rn -- $'—' .gitignore contracts/foundry.toml deploy/server.env.example deploy/README.md README.md docs/06-workflow.md docs/08-status.md docs/07-walkthrough.md app/dashboard/treasury.html app/dashboard/app.js | head; npm test -- --test-timeout=60000 --test-force-exit 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: the grep prints nothing (no em dashes); `pass 358`, `fail 0`.

- [ ] **Step 9: Commit**

```bash
git add .gitignore contracts/foundry.toml deploy/server.env.example deploy/README.md README.md docs/06-workflow.md docs/08-status.md docs/07-walkthrough.md app/dashboard/treasury.html app/dashboard/app.js
git commit -m "Document the demo yield source, the mint faucet and the Monad testnet recipe

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 7: Deploy to Monad testnet, record it, walk through (founder-run)

This task needs funded keys and the Dynamic dashboard, so a founder runs it; a subagent can review the record and the docs afterward. Run from the integration branch after Tasks 1 to 6 are merged.

**Files:**
- Create: `config/monad-testnet.json`
- Create: `contracts/deployments/monad-testnet.json` (`git add -f`)
- Modify: `contracts/deployments/README.md`, `docs/08-status.md` (the outcome)

- [ ] **Step 1: Three wallets, funded**

A deployer (also the keeper, the owner, the float and the fee address, as on Arbitrum One), and a faucet signer. Get MON for both from `https://faucet.monad.xyz` a day ahead: the deployer needs about 2 MON (five contract deployments at about 100 gwei, gas charged on the limit), the faucet signer 0.5 MON per demo wallet it will fund plus a reserve (the route refuses below 1 MON). Keep the keys in the shell for the deploy and in `.env.local` for the server; never in a file the repository tracks.

- [ ] **Step 2: Deploy the demo contracts, then Inferest**

```bash
export PATH="$HOME/.foundry/bin:$PATH"
export RPC_URL=https://testnet-rpc.monad.xyz
export DEPLOYER_PRIVATE_KEY=<deployer>   # also KEEPER, FLOAT_ADDRESS, FEE_ADDRESS, EMERGENCY_ADMIN below
export KEEPER=<deployer address> FLOAT_ADDRESS=$KEEPER FEE_ADDRESS=$KEEPER EMERGENCY_ADMIN=$KEEPER
export DEMO_OWNER=<faucet signer address>
cd contracts
forge script script/DeployDemo.s.sol --rpc-url $RPC_URL --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow
export TARGET_VAULT=$(node -p "require('./deployments/10143-demo.json').target")
forge script script/Deploy.s.sol --rpc-url $RPC_URL --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow
cat deployments/10143-demo.json deployments/10143.json
```

Expected: both files exist, `10143.json` has `target` equal to the demo file's `target` and `targets` with that one address.

- [ ] **Step 3: Verify the five contracts on Sourcify**

```bash
USDC=$(node -p "require('./deployments/10143-demo.json').usdc")
VAULT=$TARGET_VAULT
IMPL=$(node -p "require('./deployments/10143.json').implementation")
SPLITTER=$(node -p "require('./deployments/10143.json').splitter")
FACTORY=$(node -p "require('./deployments/10143.json').factory")
V="--chain 10143 --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/"
forge verify-contract $V $USDC src/demo/TestUSDC.sol:TestUSDC
forge verify-contract $V $VAULT src/demo/DemoYieldVault.sol:DemoYieldVault --constructor-args $(cast abi-encode "constructor(address,uint256,address)" $USDC 450 $DEMO_OWNER)
forge verify-contract $V $IMPL lib/octant-v2-core/src/strategies/yieldDonating/YieldDonatingTokenizedStrategy.sol:YieldDonatingTokenizedStrategy
forge verify-contract $V $SPLITTER src/Splitter.sol:Splitter --constructor-args $(cast abi-encode "constructor(address,address,address,address,uint16)" $FACTORY $KEEPER $FLOAT_ADDRESS $FEE_ADDRESS 1000)
forge verify-contract $V $FACTORY src/VaultFactory.sol:VaultFactory --constructor-args $(cast abi-encode "constructor(address,address,address,address,address)" $KEEPER $SPLITTER $IMPL $KEEPER $EMERGENCY_ADMIN)
```

Expected: each prints a Sourcify match. Open `https://testnet.monadvision.com/address/<factory>` and confirm the source shows.

- [ ] **Step 4: Write the config**

Create `config/monad-testnet.json` with the real addresses:

```json
{
  "chainId": 10143,
  "name": "Monad Testnet",
  "nativeCurrency": { "name": "Testnet MON Token", "symbol": "MON", "decimals": 18 },
  "explorer": "https://testnet.monadvision.com",
  "usdc": "<TestUSDC address>",
  "target": "<DemoYieldVault address>",
  "targetName": "Demo USDC vault, 4.5% simulated",
  "targets": [
    { "address": "<DemoYieldVault address>", "name": "Demo USDC vault, 4.5% simulated" }
  ],
  "demo": { "fundNative": "0.5", "warpTargets": ["<DemoYieldVault address>"] }
}
```

- [ ] **Step 5: Write the reviewed record**

Create `contracts/deployments/monad-testnet.json` in the shape of `arbitrum-one.json`: `network: "monad-testnet"`, `environment: "monad-testnet"`, `chainId: 10143`, `deployedAt`, the five addresses (`implementation`, `splitter`, `factory`, `target`, `targets`, `asset` = the TestUSDC address), `sourceCommit` (the integration branch's head), the same `compiler` block, `initialRoles`, `initialFeeBps: 1000`, `runtimeCodeHashes` (`cast keccak $(cast code <address> --rpc-url $RPC_URL)` for each), `transactions` (hash and block from `broadcast/Deploy.s.sol/10143/run-latest.json` and `broadcast/DeployDemo.s.sol/10143/run-latest.json`), `verification` with the Sourcify URLs `https://sourcify-api-monad.blockvision.org/v2/contract/10143/<address>`, plus a `demo` block:

```json
  "demo": {
    "usdc": "<TestUSDC address>",
    "target": "<DemoYieldVault address>",
    "rateBps": 450,
    "owner": "<faucet signer address>",
    "note": "Test money and a simulated yield source. Never real value."
  }
```

Then in `contracts/deployments/README.md` add a section:

```
## Monad testnet

[`monad-testnet.json`](monad-testnet.json) records the Inferest contracts and the demo contracts deployed on
Monad testnet (chain ID `10143`). The yield source there is our `DemoYieldVault` over `TestUSDC`, a simulated
4.5% a year on a clock the faucet signer can move; nothing on this chain is real value. Verified on Sourcify's
Monad instance; links in the JSON. `Deploy.s.sol` writes `10143.json` and `DeployDemo.s.sol` writes
`10143-demo.json` during execution; both stay ignored.
```

- [ ] **Step 6: Run the server and the demo script on the live chain**

Put the live-mode values from the status page's Monad section in `.env.local` (ask a founder to edit it; agents never write `.env*`). Start a fresh database (`mv inferest.db inferest.db.arbitrum` if one exists). Then:

```bash
npm run serve
# in another shell, with a fresh DEMO_TREASURY_KEY whose wallet holds nothing
npm run demo:treasury
```

Expected: step 1 funds the wallet through the faucet route (100,000 tUSDC and 0.5 MON appear on the explorer), creates the vault and deposits; step 3 moves the clock through `POST /api/demo/warp` (the server logs `demo clock moved 15768000 seconds in 1 transactions`) and reports about $2,250 of yield; step 4 calls models; step 5 settles on-chain; step 6 withdraws. Every hash resolves on `https://testnet.monadvision.com/tx/<hash>`.

- [ ] **Step 7: Walk through the Treasury page in a browser**

Follow `docs/07-walkthrough.md` against `http://localhost:8787/treasury` with the Dynamic environment's allowed origins including it. Sign in with an email code, Get demo funds, deposit 100,000, run the warp curl from the status page, Report yield, Sync limits, create a key, run the curl snippet, Settle. Check the network pill reads `Monad Testnet · demo chain`, the deposit card's step reads `on the demo chain`, and every transaction link opens on MonadVision. Take the 1440-wide screenshot of the page after settlement and compare it with `design/` for layout; only the two copy changes may differ.

- [ ] **Step 8: Two agent runs**

```bash
AGENT_PRIVATE_KEY=<a fresh key> AGENT_DEMO_DAYS=7 npm run agent -- --once
AGENT_PRIVATE_KEY=<the same key> AGENT_DEMO_DAYS=7 npm run agent -- --once
```

Expected: the first run funds the wallet through the faucet route, sweeps the surplus, creates its vault and deposits half the book; the second run warps the demo vault a week through the server (server log `demo clock moved 604800 seconds`), reports, thinks, and appears on `/agents` with a cost. The run cards carry today's date.

- [ ] **Step 9: Record the outcome and commit**

In `docs/08-status.md`, change line 21 to say where things run now, for example: `Everything above has run on a local anvil fork of Arbitrum One, on Arbitrum One itself as a supervised pilot (`contracts/deployments/arbitrum-one.json`), and on Monad testnet (`contracts/deployments/monad-testnet.json`, demo money only). The code is public on GitHub.` and replace the "what is left" clause added in Task 6 with the date of the walkthrough and anything that did not work.

```bash
git add config/monad-testnet.json contracts/deployments/README.md docs/08-status.md
git add -f contracts/deployments/monad-testnet.json
git status --short   # must show only these four files; never 10143.json, 10143-demo.json, .env.local or inferest.db
git commit -m "Record the Monad testnet deployment and its walkthrough

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Research notes

Facts the spec and the tasks rest on, confirmed 2026-10-11:

- Chain, RPC limits, explorer, faucet, reset, block time: `https://docs.monad.xyz/developer-essentials/testnet`, `https://docs.monad.xyz/reference/rpc-differences`; `eth_chainId` on `https://testnet-rpc.monad.xyz` answered `0x279f`, `web3_clientVersion` answered `Monad/0.16.3`, base fee `0x174876e800` (100 gwei), `evm_increaseTime` answered `-32601 Method not found`.
- EVM, gas on the limit, contract size, blob rejection: `https://docs.monad.xyz/developer-essentials/differences`, `https://docs.monad.xyz/guides/evm-resources/solidity-resources`.
- Circle USDC addresses and faucet: `https://developers.circle.com/stablecoins/usdc-contract-addresses`, `https://faucet.circle.com/`; EIP-3009 and EIP-2612 confirmed by `eth_call` (`version()` is `2`, both typehashes present).
- x402: `https://docs.monad.xyz/guides/x402`, `https://x402-facilitator.molandak.org/supported` (serves `eip155:10143` and `eip155:143`), `https://docs.cdp.coinbase.com/x402/network-support` (no Monad); `@x402/evm` 2.28.0 adds `eip155:10143`; the installed 2.27.0 lists `monad: 143` only (`node_modules/@x402/evm/dist/esm/chunk-SGFNIWGK.mjs`).
- Dynamic: `https://www.dynamic.xyz/docs/recipes/chains/monad` (mainnet toggle; testnet undocumented); our `transformers.networksData` override in `app/dashboard/src/dynamic.js` already supplies the network.
- viem 2.56.9: `node_modules/viem/chains/definitions/monadTestnet.ts` (id 10143) and `monad.ts` (id 143).
- Yield sources: Aave address book `https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3Monad.sol` (mainnet `stataUSDC` `0xC554aFfE2f581F5E0811e0D42D484ECaC5c6B8e2`); Morpho `https://docs.morpho.org/get-started/resources/addresses/` (mainnet only); no testnet USDC market found for Aave, Morpho, Euler, Curvance, Kinza or Neverland.
- Anvil fork: `anvil --fork-url https://testnet-rpc.monad.xyz` (1.8.3) listened in two seconds, served `eth_getBalance` and `eth_call` against multicall3, and took `anvil_setBalance`, `evm_increaseTime`, `evm_mine`.
- Verification: `https://docs.monad.xyz/guides/verify-smart-contract/foundry`.
- Octant's health check: `lib/octant-v2-core/src/strategies/periphery/BaseHealthCheck.sol`, `_profitLimitRatio` defaults to 10,000 basis points.
