# Inferest General Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the chain-agnostic Inferest product end to end: per-customer Octant yield-donating vaults, the Splitter, a keeper that turns yield into OpenRouter key limits and settles monthly, a paid-tools MCP server backed by Orthogonal, a dashboard, and two scripted demos (treasury, agent) running on an Arbitrum One fork.

**Architecture:** Contracts (Foundry): an immutable `Splitter` (the donation address of every vault) and a `VaultFactory` that deploys one Octant `ERC4626Strategy` per customer over an allowlisted ERC-4626 yield source. App (Node, TypeScript run natively, no build step): a keeper that reads yield from the Splitter and usage from OpenRouter, writes per-key limits, calls `report()` daily and `settle()` monthly; one HTTP server that hosts the dashboard API, the dashboard, and the MCP tool server. The math lives in `engine/ledger.ts` and `app/limits.ts`, both pure and unit tested.

**Tech Stack:** Solidity 0.8.33, Foundry, OpenZeppelin 5.3.0, Octant v2 core (pinned); Node 26 with native TypeScript, `node:test`, `node:sqlite`, viem 2.56.9, `@modelcontextprotocol/sdk` 1.30.1, zod 3.25, x402-fetch 1.2.0; OpenRouter Management API; Orthogonal (search API + x402); Tenderly Virtual TestNet (Arbitrum One fork) for demos.

**Spec:** [`docs/06-workflow.md`](../../06-workflow.md) (mechanism and decisions), [`README.md`](../../../README.md) (decisions table), [`engine/ledger.ts`](../../../engine/ledger.ts) (math source of truth).

## Global Constraints

- Node >= 22.6 (development machine runs 26.4). TypeScript must be **erasable syntax only**: no `enum`, no `namespace`, no constructor parameter properties. Relative imports carry the `.ts` extension. Type-only imports use `import type` or inline `type`.
- Solidity: `solc = "0.8.33"`, `evm_version = "cancun"`, OpenZeppelin `v5.3.0`, Octant v2 core pinned at commit `2c718d5323d92db94282453c913169f038a99149`.
- `Splitter.sol` and `IVaultRegistry.sol` are MIT and **must not import Octant code**. `VaultFactory.sol`, tests and scripts import Octant and are `AGPL-3.0-or-later`.
- **No hackathon or event names** in any committed file, commit message or branch name. Chain names are fine.
- English prose: no em dashes, American spelling.
- On-chain amounts are USDC base units (6 decimals). The app keeps OpenRouter usage as USD floats (that is the API's unit) and converts to `bigint` base units only when calling `settle`.
- Fee: `feeBps = 1000` (10% of leftover yield). Rail fee: `HACKATHON_PARAMS` (`railFee = 0`, absorbed; `RAIL_COST = 0.05` is our cost).
- Cadence: `report()` daily, limit sync every minute, `settle()` monthly.
- Key budgets: admin-set weights, default 1. Budget per key = weight share of this period's credit.
- End every commit message with: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`
- If `git` prints `xcrun: error ... SDK "macosx" cannot be located`, run `/usr/bin/git` instead.

## Review Focus

1. **A vault over an unvetted yield source.** Anyone can call the factory; a fake ERC-4626 could report yield that does not exist, and we would open limits against it. Expected: `createVault` reverts for any target not on the owner's allowlist, and the API refuses to register a vault the factory did not create. Tests: Task 3 `test_createVault_revertsForTargetNotAllowed`, Task 12 `POST /api/vaults rejects a vault the factory does not know`.
2. **A loss in the yield source before the keeper reports it.** Until `report()` runs, the Splitter's shares are valued at the stale, higher total, so limits would open against yield that is gone. Expected: the keeper detects live assets below stored assets, freezes every key at its current usage, and skips settlement for that vault. Tests: Task 9 `freezes limits when a loss is pending`, `skips settlement when a loss is pending`.
3. **Spend racing the monthly settlement.** Requests keep landing between reading usage and calling `settle`. Expected: settlement first pins every key's limit to its current usage, re-reads usage, then settles, so nothing spent after the read goes unbilled. Test: Task 9 `settle freezes keys, re-reads usage, then settles`.
4. **A paid tool call on a key with no yield left, or one that times out.** Expected: the gateway refuses before any payment is signed, the payment cap passed to x402 never exceeds the key's remaining budget, and a failed or ambiguous paid call is never retried automatically (Orthogonal's guidance: check usage before retrying). Tests: Task 10 `refuses a run when the budget is exhausted`, `caps the x402 payment at the remaining budget`, `never retries a paid call`.
5. **Unauthenticated callers.** Expected: the MCP endpoint rejects unknown bearer tokens with 401, and every mutating API route requires the admin token. Tests: Task 12 `MCP rejects an unknown key`, `mutating routes require the admin token`.

---

## File Structure

```
contracts/                       Foundry project
  foundry.toml, remappings.txt
  src/interfaces/IVaultRegistry.sol   customerOf(vault): the only thing Splitter needs from the factory
  src/Splitter.sol                    holds reported yield as vault shares; settle() splits it
  src/VaultFactory.sol                deploys one Octant ERC4626Strategy per customer, allowlist, registry
  test/Base.t.sol                     shared setup: mock USDC, mock ERC-4626, Octant implementation, wiring
  test/Splitter.t.sol                 settle math and access control
  test/VaultFactory.t.sol             allowlist, wiring, management handoff
  test/Lifecycle.t.sol                deposit, accrue, report, settle, withdraw, loss, router cooldown
  test/Fork.t.sol                     same cycle against a real Morpho vault on an Arbitrum One fork
  script/Deploy.s.sol                 deploys implementation, Splitter, factory; writes deployments/<chainId>.json
config/arbitrum-one.json          chain id, USDC, yield source
engine/ledger.ts                  (modify) tool spend counts toward usage
app/
  config.ts        env + deployment file -> Config
  chain.ts         viem reads/writes: yieldOf, lossPending, report, settle, customerOf
  store.ts         node:sqlite: vaults, keys, tool calls, periods, settlements, meta
  openrouter.ts    Management API: createKey, getKey, setLimit
  limits.ts        pure: per-key budget, limit, tool budget, settlement usage
  keeper.ts        syncVault/syncAll, reportAll, settleVault, tick, toolBudgetFor
  tools.ts         Orthogonal search + x402 run, budget check, recording
  mcp.ts           MCP server: search_tools, run_tool
  server.ts        HTTP: /mcp, /api/*, static dashboard
  cli.ts           entry point: serve | sync | report | settle
  dashboard/index.html, dashboard/app.js
  test/*.test.ts
demo/
  lib.ts           RPC helpers (warp, fund), API client, viem clients, chat
  treasury.ts      ICP1 script
  agent.ts         ICP2 script
.env.example, tsconfig.json, package.json (modify)
```

---

### Task 1: Foundry project with Octant as a dependency

**Files:**
- Create: `contracts/foundry.toml`, `contracts/remappings.txt`, `contracts/test/Smoke.t.sol`
- Modify: `.gitignore`
- Delete: `contracts/.gitkeep`

**Interfaces:**
- Produces: import paths `octant/...` and `@openzeppelin/contracts/...` usable from `contracts/src`, `contracts/test`, `contracts/script`.

- [ ] **Step 1: Install Foundry**

Run: `curl -L https://foundry.paradigm.xyz | bash && ~/.foundry/bin/foundryup`
Then: `forge --version`
Expected: prints a `forge` version.

- [ ] **Step 2: Create the project config**

`contracts/foundry.toml`:
```toml
[profile.default]
src = "src"
test = "test"
script = "script"
out = "out"
libs = ["lib"]
solc = "0.8.33"
evm_version = "cancun"
optimizer = true
optimizer_runs = 200
fs_permissions = [{ access = "read-write", path = "./deployments" }]

[rpc_endpoints]
arbitrum = "${ARBITRUM_RPC_URL}"

[fuzz]
runs = 256
```

`contracts/remappings.txt`:
```
forge-std/=lib/forge-std/src/
@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/
octant/=lib/octant-v2-core/src/
lib/octant-v2-core/:src/=lib/octant-v2-core/src/
```
The last line is a context remapping: Octant's own files import `src/...`, which must resolve inside Octant, not to our `src/`.

- [ ] **Step 3: Install dependencies**

```bash
cd contracts
rm -f .gitkeep
forge install foundry-rs/forge-std@v1.14.0 OpenZeppelin/openzeppelin-contracts@v5.3.0
forge install golemfoundation/octant-v2-core@2c718d5323d92db94282453c913169f038a99149
```
Expected: `lib/forge-std`, `lib/openzeppelin-contracts`, `lib/octant-v2-core` exist and `.gitmodules` lists them.

- [ ] **Step 4: Ignore build output**

Append to `.gitignore`:
```
# foundry
contracts/out/
contracts/cache/
contracts/broadcast/
# app
inferest.db
!.env.example
```

- [ ] **Step 5: Write a smoke test that deploys an Octant strategy**

`contracts/test/Smoke.t.sol`:
```solidity
// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.25;

import { Test } from "forge-std/Test.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import { ERC4626Mock } from "@openzeppelin/contracts/mocks/token/ERC4626Mock.sol";
import { YieldDonatingTokenizedStrategy } from "octant/strategies/yieldDonating/YieldDonatingTokenizedStrategy.sol";
import { ERC4626Strategy } from "octant/strategies/yieldDonating/ERC4626Strategy.sol";

contract SmokeTest is Test {
    function test_octantStrategyDeploys() public {
        ERC20Mock usdc = new ERC20Mock();
        ERC4626Mock target = new ERC4626Mock(address(usdc));
        YieldDonatingTokenizedStrategy impl = new YieldDonatingTokenizedStrategy();
        ERC4626Strategy s = new ERC4626Strategy(
            address(target), address(usdc), "Smoke", "SMK",
            address(this), address(this), address(this), address(0xD0), true, address(impl)
        );
        assertEq(s.targetVault(), address(target));
    }
}
```

- [ ] **Step 6: Run it**

Run: `cd contracts && forge test --match-contract SmokeTest -vv`
Expected: `[PASS] test_octantStrategyDeploys()`. If compilation fails on an Octant `src/...` import, the context remapping in Step 2 is wrong; fix it before continuing.

- [ ] **Step 7: Commit**

```bash
git add .gitignore .gitmodules contracts
git commit -m "Set up the Foundry project with Octant v2 core pinned"
```

---

### Task 2: Splitter

**Files:**
- Create: `contracts/src/interfaces/IVaultRegistry.sol`, `contracts/src/Splitter.sol`, `contracts/test/Base.t.sol`, `contracts/test/Splitter.t.sol`
- Delete: `contracts/test/Smoke.t.sol`

**Interfaces:**
- Consumes: Octant `ITokenizedStrategy` (tests only).
- Produces:
  - `interface IVaultRegistry { function customerOf(address vault) external view returns (address); }`
  - `Splitter(address registry, address keeper, address floatAddress, address feeAddress, uint16 feeBps)`
  - `Splitter.yieldOf(address vault) view returns (uint256)`
  - `Splitter.settle(address vault, uint256 usage) returns (uint256 paid, uint256 fee, uint256 returnedShares)`
  - `event Settled(address indexed vault, address indexed customer, uint256 yieldAssets, uint256 paid, uint256 fee, uint256 returnedShares, uint256 shortfall)`
  - Errors: `ZeroAddress()`, `FeeTooHigh(uint16)`, `NotKeeper()`, `UnknownVault(address)`

`Base.t.sol` needs `VaultFactory` (Task 3). To keep this task testable on its own, it uses a two-line registry stub; Task 3 switches `Base.t.sol` to the real factory.

- [ ] **Step 1: Write the registry interface**

`contracts/src/interfaces/IVaultRegistry.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @notice The only thing the Splitter needs to know about a vault: whose it is.
interface IVaultRegistry {
    function customerOf(address vault) external view returns (address);
}
```

- [ ] **Step 2: Write the shared test base with a registry stub**

`contracts/test/Base.t.sol`:
```solidity
// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.25;

import { Test } from "forge-std/Test.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import { ERC4626Mock } from "@openzeppelin/contracts/mocks/token/ERC4626Mock.sol";
import { YieldDonatingTokenizedStrategy } from "octant/strategies/yieldDonating/YieldDonatingTokenizedStrategy.sol";
import { ERC4626Strategy } from "octant/strategies/yieldDonating/ERC4626Strategy.sol";
import { ITokenizedStrategy } from "octant/core/interfaces/ITokenizedStrategy.sol";
import { IVaultRegistry } from "../src/interfaces/IVaultRegistry.sol";
import { Splitter } from "../src/Splitter.sol";

contract RegistryStub is IVaultRegistry {
    mapping(address => address) public customerOf;
    function set(address vault, address customer) external { customerOf[vault] = customer; }
}

abstract contract BaseTest is Test {
    uint16 internal constant FEE_BPS = 1_000;
    uint256 internal constant MIN_LIQUIDITY = 1_000; // Octant seeds 1,000 shares to 0xdead on the first deposit

    ERC20Mock internal usdc;
    ERC4626Mock internal target;
    YieldDonatingTokenizedStrategy internal impl;
    RegistryStub internal registry;
    Splitter internal splitter;

    address internal keeper = makeAddr("keeper");
    address internal floatAddr = makeAddr("float");
    address internal feeAddr = makeAddr("fee");
    address internal emergency = makeAddr("emergency");
    address internal customer = makeAddr("customer");

    function setUp() public virtual {
        usdc = new ERC20Mock();
        target = new ERC4626Mock(address(usdc));
        impl = new YieldDonatingTokenizedStrategy();
        registry = new RegistryStub();
        splitter = new Splitter(address(registry), keeper, floatAddr, feeAddr, FEE_BPS);
    }

    /// Deploys a customer vault donating to the Splitter and deposits `amount` for `who`.
    function _openVault(address who, uint256 amount) internal virtual returns (ITokenizedStrategy vault) {
        ERC4626Strategy s = new ERC4626Strategy(
            address(target), address(usdc), "Inferest Test", "infTEST",
            who, keeper, emergency, address(splitter), true, address(impl)
        );
        vm.prank(who);
        s.setLossLimitRatio(9_999);
        registry.set(address(s), who);
        vault = ITokenizedStrategy(address(s));
        _deposit(vault, who, amount);
    }

    function _deposit(ITokenizedStrategy vault, address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(vault), amount);
        vault.deposit(amount, who);
        vm.stopPrank();
    }

    function _accrue(uint256 amount) internal { usdc.mint(address(target), amount); }
    function _lose(uint256 amount) internal { usdc.burn(address(target), amount); }

    function _report(ITokenizedStrategy vault) internal returns (uint256 profit, uint256 loss) {
        vm.prank(keeper);
        return vault.report();
    }

    function _valueOf(ITokenizedStrategy vault, address who) internal view returns (uint256) {
        return vault.convertToAssets(vault.balanceOf(who));
    }
}
```

- [ ] **Step 3: Write the failing Splitter tests**

`contracts/test/Splitter.t.sol`:
```solidity
// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.25;

import { Vm } from "forge-std/Vm.sol";
import { ITokenizedStrategy } from "octant/core/interfaces/ITokenizedStrategy.sol";
import { Splitter } from "../src/Splitter.sol";
import { BaseTest } from "./Base.t.sol";

contract SplitterTest is BaseTest {
    uint256 internal constant PRINCIPAL = 100_000e6;

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(Splitter.ZeroAddress.selector);
        new Splitter(address(0), keeper, floatAddr, feeAddr, FEE_BPS);
        vm.expectRevert(Splitter.ZeroAddress.selector);
        new Splitter(address(registry), keeper, address(0), feeAddr, FEE_BPS);
    }

    function test_constructor_rejectsFeeAboveCap() public {
        vm.expectRevert(abi.encodeWithSelector(Splitter.FeeTooHigh.selector, uint16(2_001)));
        new Splitter(address(registry), keeper, floatAddr, feeAddr, 2_001);
    }

    function test_settle_onlyKeeper() public {
        ITokenizedStrategy vault = _openVault(customer, PRINCIPAL);
        vm.expectRevert(Splitter.NotKeeper.selector);
        splitter.settle(address(vault), 0);
    }

    function test_settle_revertsForUnknownVault() public {
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Splitter.UnknownVault.selector, address(0xBAD)));
        splitter.settle(address(0xBAD), 0);
    }

    function test_settle_paysUsageTakesFeeOnLeftoverReturnsRest() public {
        ITokenizedStrategy vault = _openVault(customer, PRINCIPAL);
        uint256 customerSharesBefore = vault.balanceOf(customer);
        _accrue(2_225e6);
        _report(vault);
        uint256 y = splitter.yieldOf(address(vault));
        assertApproxEqAbs(y, 2_225e6, 10);

        vm.prank(keeper);
        (uint256 paid, uint256 fee, uint256 returnedShares) = splitter.settle(address(vault), 500e6);

        assertEq(paid, 500e6);
        assertEq(usdc.balanceOf(floatAddr), 500e6);
        assertApproxEqAbs(fee, (y - 500e6) / 10, 1);
        assertEq(usdc.balanceOf(feeAddr), fee);
        assertEq(vault.balanceOf(address(splitter)), 0);
        assertEq(vault.balanceOf(customer), customerSharesBefore + returnedShares);
        assertApproxEqAbs(vault.convertToAssets(returnedShares), y - 500e6 - fee, 10);
    }

    function test_settle_capsUsageAtYieldAndEmitsShortfall() public {
        ITokenizedStrategy vault = _openVault(customer, PRINCIPAL);
        _accrue(1_000e6);
        _report(vault);
        uint256 y = splitter.yieldOf(address(vault));

        vm.recordLogs();
        vm.prank(keeper);
        (uint256 paid, uint256 fee,) = splitter.settle(address(vault), 5_000e6);

        assertEq(paid, y);
        assertEq(fee, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory settled = logs[logs.length - 1];
        assertEq(settled.topics[0], Splitter.Settled.selector);
        (,,,, uint256 shortfall) = abi.decode(settled.data, (uint256, uint256, uint256, uint256, uint256));
        assertEq(shortfall, 5_000e6 - y);
    }

    function test_settle_withNoYieldMovesNothing() public {
        ITokenizedStrategy vault = _openVault(customer, PRINCIPAL);
        vm.prank(keeper);
        (uint256 paid, uint256 fee, uint256 returnedShares) = splitter.settle(address(vault), 0);
        assertEq(paid + fee + returnedShares, 0);
        assertEq(usdc.balanceOf(floatAddr) + usdc.balanceOf(feeAddr), 0);
    }

    function test_settle_secondCallIsANoop() public {
        ITokenizedStrategy vault = _openVault(customer, PRINCIPAL);
        _accrue(1_000e6);
        _report(vault);
        vm.startPrank(keeper);
        splitter.settle(address(vault), 100e6);
        (uint256 paid, uint256 fee, uint256 returnedShares) = splitter.settle(address(vault), 100e6);
        vm.stopPrank();
        assertEq(paid + fee + returnedShares, 0);
    }

    function testFuzz_settle_neverTakesPrincipal(uint64 accrued, uint64 usage) public {
        accrued = uint64(bound(accrued, 1e6, 50_000e6));
        ITokenizedStrategy vault = _openVault(customer, PRINCIPAL);
        uint256 principalValue = _valueOf(vault, customer);
        _accrue(accrued);
        _report(vault);
        uint256 y = splitter.yieldOf(address(vault));

        vm.prank(keeper);
        (uint256 paid, uint256 fee,) = splitter.settle(address(vault), usage);

        assertLe(paid + fee, y);
        assertGe(_valueOf(vault, customer) + 10, principalValue);
    }
}
```

- [ ] **Step 4: Run the tests to see them fail**

Run: `cd contracts && forge test --match-contract SplitterTest`
Expected: compilation error, `Splitter.sol` not found.

- [ ] **Step 5: Implement the Splitter**

`contracts/src/Splitter.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IVaultRegistry } from "./interfaces/IVaultRegistry.sol";

/// @title Splitter
/// @notice Donation address of every Inferest customer vault. A vault's report() mints the customer's
///         yield here as vault shares. Once a month the keeper settles: usage goes to the float, a fee on
///         the unused yield goes to Inferest, and the remaining shares go back to the customer.
/// @dev Holds no principal. It can only move shares it was minted as yield.
contract Splitter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_FEE_BPS = 2_000;
    uint16 internal constant BPS = 10_000;

    IVaultRegistry public immutable registry;
    address public immutable keeper;
    address public immutable floatAddress;
    address public immutable feeAddress;
    uint16 public immutable feeBps;

    event Settled(
        address indexed vault,
        address indexed customer,
        uint256 yieldAssets,
        uint256 paid,
        uint256 fee,
        uint256 returnedShares,
        uint256 shortfall
    );

    error ZeroAddress();
    error FeeTooHigh(uint16 feeBps);
    error NotKeeper();
    error UnknownVault(address vault);

    constructor(address registry_, address keeper_, address floatAddress_, address feeAddress_, uint16 feeBps_) {
        if (
            registry_ == address(0) || keeper_ == address(0) || floatAddress_ == address(0)
                || feeAddress_ == address(0)
        ) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_);
        registry = IVaultRegistry(registry_);
        keeper = keeper_;
        floatAddress = floatAddress_;
        feeAddress = feeAddress_;
        feeBps = feeBps_;
    }

    /// @notice Unsettled yield of `vault`, in the vault's asset.
    function yieldOf(address vault) public view returns (uint256) {
        return IERC4626(vault).convertToAssets(IERC20(vault).balanceOf(address(this)));
    }

    /// @param usage What the period's model and tool spend cost, in the vault's asset units.
    ///        Capped at the yield: anything above it is emitted as `shortfall` and never taken.
    function settle(address vault, uint256 usage)
        external
        nonReentrant
        returns (uint256 paid, uint256 fee, uint256 returnedShares)
    {
        if (msg.sender != keeper) revert NotKeeper();
        address customer = registry.customerOf(vault);
        if (customer == address(0)) revert UnknownVault(vault);

        uint256 y = yieldOf(vault);
        paid = usage < y ? usage : y;
        fee = ((y - paid) * feeBps) / BPS;

        if (paid > 0) IERC4626(vault).withdraw(paid, floatAddress, address(this));
        if (fee > 0) {
            uint256 available = IERC4626(vault).maxWithdraw(address(this));
            if (fee > available) fee = available;
            if (fee > 0) IERC4626(vault).withdraw(fee, feeAddress, address(this));
        }

        returnedShares = IERC20(vault).balanceOf(address(this));
        if (returnedShares > 0) IERC20(vault).safeTransfer(customer, returnedShares);

        emit Settled(vault, customer, y, paid, fee, returnedShares, usage - paid);
    }
}
```
`shortfall` is read from the log rather than matched with `expectEmit`, because withdrawing all of `y` can leave one share of rounding dust and change `returnedShares`.

Returning leftover as shares (not redeem then deposit) is the redeposit from `docs/06` decision 7: YDS shares track principal, so the customer's principal grows by exactly their value.

- [ ] **Step 6: Run the tests to see them pass**

Run: `cd contracts && rm -f test/Smoke.t.sol && forge test --match-contract SplitterTest -vv`
Expected: 8 tests PASS, including the fuzz test.

- [ ] **Step 7: Commit**

```bash
git add contracts
git commit -m "Add the Splitter: pay usage, fee on leftover, return the rest as shares"
```

---

### Task 3: VaultFactory

**Files:**
- Create: `contracts/src/VaultFactory.sol`, `contracts/test/VaultFactory.t.sol`
- Modify: `contracts/test/Base.t.sol` (use the real factory)

**Interfaces:**
- Consumes: `IVaultRegistry`, `Splitter` from Task 2; Octant `ERC4626Strategy`, `ITokenizedStrategy`.
- Produces:
  - `VaultFactory(address owner, address splitter, address tokenizedStrategy, address keeper, address emergencyAdmin)`
  - `setAllowedTarget(address target, bool allowed)` (owner only)
  - `createVault(address target, string name, string symbol) returns (address vault)`; caller becomes pending management and the vault's customer
  - `customerOf(address vault) view returns (address)`, `vaultsOf(address customer) view returns (address[])`, `allowedTarget(address) view returns (bool)`
  - `event VaultCreated(address indexed customer, address indexed vault, address indexed target)`
  - Errors: `ZeroAddress()`, `TargetNotAllowed(address)`
  - `LOSS_LIMIT_BPS = 9_999`

- [ ] **Step 1: Switch the test base to the real factory**

In `contracts/test/Base.t.sol`, replace the `RegistryStub` contract, the `registry` field and `setUp` / `_openVault` with:
```solidity
import { VaultFactory } from "../src/VaultFactory.sol";

    // fields (replace `RegistryStub internal registry;`)
    VaultFactory internal factory;
    address internal owner = makeAddr("owner");

    function setUp() public virtual {
        usdc = new ERC20Mock();
        target = new ERC4626Mock(address(usdc));
        impl = new YieldDonatingTokenizedStrategy();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        splitter = new Splitter(predicted, keeper, floatAddr, feeAddr, FEE_BPS);
        factory = new VaultFactory(owner, address(splitter), address(impl), keeper, emergency);
        assertEq(address(factory), predicted, "factory address prediction");
        vm.prank(owner);
        factory.setAllowedTarget(address(target), true);
    }

    function _openVault(address who, uint256 amount) internal virtual returns (ITokenizedStrategy vault) {
        vm.startPrank(who);
        vault = ITokenizedStrategy(factory.createVault(address(target), "Inferest Test", "infTEST"));
        vault.acceptManagement();
        vm.stopPrank();
        _deposit(vault, who, amount);
    }
```
Remove the now-unused `ERC4626Strategy` and `IVaultRegistry` imports. In `Splitter.t.sol`, `test_constructor_rejectsZeroAddresses` and `test_constructor_rejectsFeeAboveCap` reference `registry`; replace `address(registry)` with `address(factory)`.

- [ ] **Step 2: Write the failing factory tests**

`contracts/test/VaultFactory.t.sol`:
```solidity
// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.25;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ERC4626Mock } from "@openzeppelin/contracts/mocks/token/ERC4626Mock.sol";
import { ITokenizedStrategy } from "octant/core/interfaces/ITokenizedStrategy.sol";
import { ERC4626Strategy } from "octant/strategies/yieldDonating/ERC4626Strategy.sol";
import { VaultFactory } from "../src/VaultFactory.sol";
import { BaseTest } from "./Base.t.sol";

contract VaultFactoryTest is BaseTest {
    function test_createVault_revertsForTargetNotAllowed() public {
        ERC4626Mock rogue = new ERC4626Mock(address(usdc));
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.TargetNotAllowed.selector, address(rogue)));
        factory.createVault(address(rogue), "x", "x");
    }

    function test_setAllowedTarget_onlyOwner() public {
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, customer));
        factory.setAllowedTarget(address(0x1234), true);
    }

    function test_createVault_wiresVaultToSplitterKeeperAndCustomer() public {
        vm.prank(customer);
        address vault = factory.createVault(address(target), "Inferest Test", "infTEST");
        ITokenizedStrategy v = ITokenizedStrategy(vault);

        assertEq(factory.customerOf(vault), customer);
        assertEq(factory.vaultsOf(customer)[0], vault);
        assertEq(v.dragonRouter(), address(splitter));
        assertEq(v.keeper(), keeper);
        assertEq(v.management(), address(factory));
        assertEq(v.pendingManagement(), customer);
        assertEq(ERC4626Strategy(vault).lossLimitRatio(), factory.LOSS_LIMIT_BPS());
        assertEq(ERC4626Strategy(vault).targetVault(), address(target));
    }

    function test_createVault_customerBecomesManagementAfterAccepting() public {
        vm.startPrank(customer);
        ITokenizedStrategy v = ITokenizedStrategy(factory.createVault(address(target), "a", "a"));
        v.acceptManagement();
        vm.stopPrank();
        assertEq(v.management(), customer);
    }

    function test_createVault_emitsVaultCreated() public {
        vm.expectEmit(true, false, true, false, address(factory));
        emit VaultFactory.VaultCreated(customer, address(0), address(target));
        vm.prank(customer);
        factory.createVault(address(target), "a", "a");
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(VaultFactory.ZeroAddress.selector);
        new VaultFactory(owner, address(0), address(impl), keeper, emergency);
    }
}
```

- [ ] **Step 3: Run to see them fail**

Run: `cd contracts && forge test --match-contract VaultFactoryTest`
Expected: compilation error, `VaultFactory.sol` not found.

- [ ] **Step 4: Implement the factory**

`contracts/src/VaultFactory.sol`:
```solidity
// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.25;

import { Ownable, Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { ERC4626Strategy } from "octant/strategies/yieldDonating/ERC4626Strategy.sol";
import { ITokenizedStrategy } from "octant/core/interfaces/ITokenizedStrategy.sol";
import { IVaultRegistry } from "./interfaces/IVaultRegistry.sol";

/// @title VaultFactory
/// @notice Deploys one Octant yield-donating vault per customer over an allowlisted ERC-4626 yield source.
///         Every vault donates to the Splitter. The caller becomes the vault's customer and, after
///         acceptManagement(), its management.
contract VaultFactory is IVaultRegistry, Ownable2Step {
    /// @dev Octant's health check rejects any loss report by default (lossLimitRatio = 0). Loss reports
    ///      must go through so YDS burns the Splitter's shares first (docs/06-workflow.md, vault loss).
    uint256 public constant LOSS_LIMIT_BPS = 9_999;

    address public immutable splitter;
    address public immutable tokenizedStrategy;
    address public immutable keeper;
    address public immutable emergencyAdmin;

    mapping(address target => bool) public allowedTarget;
    mapping(address vault => address) public override customerOf;
    mapping(address customer => address[]) internal _vaults;

    event TargetAllowed(address indexed target, bool allowed);
    event VaultCreated(address indexed customer, address indexed vault, address indexed target);

    error ZeroAddress();
    error TargetNotAllowed(address target);

    constructor(
        address owner_,
        address splitter_,
        address tokenizedStrategy_,
        address keeper_,
        address emergencyAdmin_
    ) Ownable(owner_) {
        if (
            splitter_ == address(0) || tokenizedStrategy_ == address(0) || keeper_ == address(0)
                || emergencyAdmin_ == address(0)
        ) revert ZeroAddress();
        splitter = splitter_;
        tokenizedStrategy = tokenizedStrategy_;
        keeper = keeper_;
        emergencyAdmin = emergencyAdmin_;
    }

    function setAllowedTarget(address target, bool allowed) external onlyOwner {
        allowedTarget[target] = allowed;
        emit TargetAllowed(target, allowed);
    }

    function createVault(address target, string calldata name, string calldata symbol)
        external
        returns (address vault)
    {
        if (!allowedTarget[target]) revert TargetNotAllowed(target);
        ERC4626Strategy strategy = new ERC4626Strategy(
            target,
            IERC4626(target).asset(),
            name,
            symbol,
            address(this), // management until the customer accepts
            keeper,
            emergencyAdmin,
            splitter, // donation address
            true, // burn donation shares first on a loss
            tokenizedStrategy
        );
        vault = address(strategy);
        strategy.setLossLimitRatio(LOSS_LIMIT_BPS);
        ITokenizedStrategy(vault).setPendingManagement(msg.sender);

        customerOf[vault] = msg.sender;
        _vaults[msg.sender].push(vault);
        emit VaultCreated(msg.sender, vault, target);
    }

    function vaultsOf(address customer) external view returns (address[] memory) {
        return _vaults[customer];
    }
}
```

- [ ] **Step 5: Run all contract tests**

Run: `cd contracts && forge test -vv`
Expected: all `VaultFactoryTest` and `SplitterTest` tests PASS.

- [ ] **Step 6: Commit**

```bash
git add contracts
git commit -m "Add the VaultFactory: allowlisted yield sources, one vault per customer"
```

---

### Task 4: Lifecycle tests

**Files:**
- Create: `contracts/test/Lifecycle.t.sol`

**Interfaces:**
- Consumes: `BaseTest` helpers from Tasks 2 and 3.
- Produces: nothing new; pins the guarantees table in `docs/06-workflow.md`.

- [ ] **Step 1: Write the tests**

`contracts/test/Lifecycle.t.sol`:
```solidity
// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.25;

import { ITokenizedStrategy } from "octant/core/interfaces/ITokenizedStrategy.sol";
import { BaseTest } from "./Base.t.sol";

interface IDragonRouter {
    function setDragonRouter(address) external;
    function finalizeDragonRouterChange() external;
    function dragonRouter() external view returns (address);
}

contract LifecycleTest is BaseTest {
    uint256 internal constant PRINCIPAL = 100_000e6;

    function test_fullCycle_depositAccrueReportSettleWithdraw() public {
        ITokenizedStrategy vault = _openVault(customer, PRINCIPAL);
        assertEq(vault.balanceOf(customer), PRINCIPAL - MIN_LIQUIDITY);

        _accrue(2_225e6);
        (uint256 profit,) = _report(vault);
        assertApproxEqAbs(profit, 2_225e6, 10);
        assertApproxEqAbs(_valueOf(vault, customer), PRINCIPAL - MIN_LIQUIDITY, 10); // profit never raises PPS

        vm.prank(keeper);
        splitter.settle(address(vault), 500e6);

        vm.startPrank(customer);
        uint256 got = vault.redeem(vault.balanceOf(customer), customer, customer);
        vm.stopPrank();
        // principal + (2,225 - 500) * 90%
        assertApproxEqAbs(got, PRINCIPAL - MIN_LIQUIDITY + 1_552_500_000, 20);
        assertEq(usdc.balanceOf(floatAddr), 500e6);
        assertApproxEqAbs(usdc.balanceOf(feeAddr), 172_500_000, 10);
    }

    function test_customerWithdrawsAnytimeBeforeReport() public {
        ITokenizedStrategy vault = _openVault(customer, PRINCIPAL);
        _accrue(500e6);
        vm.startPrank(customer);
        uint256 got = vault.redeem(vault.balanceOf(customer), customer, customer);
        vm.stopPrank();
        assertApproxEqAbs(got, PRINCIPAL - MIN_LIQUIDITY, 10);
    }

    function test_lossBurnsSplitterSharesFirst() public {
        ITokenizedStrategy vault = _openVault(customer, PRINCIPAL);
        _accrue(1_000e6);
        _report(vault);
        _lose(400e6);
        (, uint256 loss) = _report(vault);

        assertApproxEqAbs(loss, 400e6, 10);
        assertApproxEqAbs(splitter.yieldOf(address(vault)), 600e6, 10);
        assertApproxEqAbs(_valueOf(vault, customer), PRINCIPAL - MIN_LIQUIDITY, 10);
    }

    function test_lossLargerThanBufferReachesPrincipal() public {
        ITokenizedStrategy vault = _openVault(customer, PRINCIPAL);
        _accrue(100e6);
        _report(vault);
        _lose(300e6);
        _report(vault);

        assertEq(vault.balanceOf(address(splitter)), 0);
        assertApproxEqRel(_valueOf(vault, customer), PRINCIPAL - 200e6, 1e12);
    }

    function test_reportRestrictedToKeeperOrManagement() public {
        ITokenizedStrategy vault = _openVault(customer, PRINCIPAL);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        vault.report();
    }

    function test_changingTheDonationAddressTakesFourteenDays() public {
        ITokenizedStrategy vault = _openVault(customer, PRINCIPAL);
        address elsewhere = makeAddr("elsewhere");
        vm.prank(customer);
        IDragonRouter(address(vault)).setDragonRouter(elsewhere);

        vm.expectRevert();
        IDragonRouter(address(vault)).finalizeDragonRouterChange();

        skip(14 days);
        IDragonRouter(address(vault)).finalizeDragonRouterChange();
        assertEq(IDragonRouter(address(vault)).dragonRouter(), elsewhere);
    }
}
```

- [ ] **Step 2: Run them**

Run: `cd contracts && forge test --match-contract LifecycleTest -vv`
Expected: 6 tests PASS. They exercise existing code, so a failure means a real mismatch with `docs/06`; read the revert, do not loosen the assertion.

- [ ] **Step 3: Commit**

```bash
git add contracts/test/Lifecycle.t.sol
git commit -m "Pin the vault lifecycle: settle, withdraw anytime, loss buffer, router cooldown"
```

---

### Task 5: Fork test and deploy script

**Files:**
- Create: `config/arbitrum-one.json`, `contracts/test/Fork.t.sol`, `contracts/script/Deploy.s.sol`, `contracts/deployments/.gitkeep`

**Interfaces:**
- Consumes: `Splitter`, `VaultFactory`.
- Produces: `contracts/deployments/<chainId>.json` with keys `chainId`, `implementation`, `splitter`, `factory`, `target` (read by `app/config.ts` and `demo/lib.ts`).

- [ ] **Step 1: Write the chain config**

`config/arbitrum-one.json`:
```json
{
  "chainId": 42161,
  "name": "Arbitrum One",
  "usdc": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  "target": "0x5c0C306Aaa9F877de636f4d5822cA9F2E81563BA",
  "targetName": "Morpho Steakhouse High Yield USDC"
}
```

- [ ] **Step 2: Write the fork test**

`contracts/test/Fork.t.sol`:
```solidity
// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.25;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { YieldDonatingTokenizedStrategy } from "octant/strategies/yieldDonating/YieldDonatingTokenizedStrategy.sol";
import { ITokenizedStrategy } from "octant/core/interfaces/ITokenizedStrategy.sol";
import { Splitter } from "../src/Splitter.sol";
import { VaultFactory } from "../src/VaultFactory.sol";

/// Runs only when ARBITRUM_RPC_URL is set.
contract ForkTest is Test {
    address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address constant TARGET = 0x5c0C306Aaa9F877de636f4d5822cA9F2E81563BA;

    function test_fork_cycleAgainstRealMorphoVault() public {
        string memory rpc = vm.envOr("ARBITRUM_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        assertEq(IERC4626(TARGET).asset(), USDC, "target must be a USDC vault");

        address keeper = makeAddr("keeper");
        address customer = makeAddr("customer");
        YieldDonatingTokenizedStrategy impl = new YieldDonatingTokenizedStrategy();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        Splitter splitter = new Splitter(predicted, keeper, makeAddr("float"), makeAddr("fee"), 1_000);
        VaultFactory factory = new VaultFactory(address(this), address(splitter), address(impl), keeper, keeper);
        factory.setAllowedTarget(TARGET, true);

        deal(USDC, customer, 100_000e6);
        vm.startPrank(customer);
        ITokenizedStrategy vault = ITokenizedStrategy(factory.createVault(TARGET, "Fork", "FRK"));
        vault.acceptManagement();
        IERC20(USDC).approve(address(vault), 100_000e6);
        vault.deposit(100_000e6, customer);
        vm.stopPrank();

        skip(182 days);
        vm.prank(keeper);
        (uint256 profit,) = vault.report();
        assertGt(profit, 0, "Morpho vault accrued nothing");
        assertGt(splitter.yieldOf(address(vault)), 0);

        vm.prank(keeper);
        splitter.settle(address(vault), 0);
        vm.startPrank(customer);
        uint256 got = vault.redeem(vault.balanceOf(customer), customer, customer);
        vm.stopPrank();
        assertGt(got, 100_000e6 - 1_000, "customer did not get principal plus returned yield");
    }
}
```

- [ ] **Step 3: Run it against a real RPC**

Run: `cd contracts && ARBITRUM_RPC_URL=<Quicknode or Tenderly Arbitrum One RPC> forge test --match-contract ForkTest -vv`
Expected: PASS. Without the variable it passes trivially; the real run is what counts. If `deal` fails on USDC, replace it with `vm.prank(<a USDC whale>); IERC20(USDC).transfer(customer, 100_000e6);`.

- [ ] **Step 4: Write the deploy script**

`contracts/script/Deploy.s.sol`:
```solidity
// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.25;

import { Script, console2 } from "forge-std/Script.sol";
import { YieldDonatingTokenizedStrategy } from "octant/strategies/yieldDonating/YieldDonatingTokenizedStrategy.sol";
import { Splitter } from "../src/Splitter.sol";
import { VaultFactory } from "../src/VaultFactory.sol";

/// forge script script/Deploy.s.sol --rpc-url $RPC_URL --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow
contract Deploy is Script {
    function run() external {
        address keeper = vm.envAddress("KEEPER");
        address floatAddress = vm.envAddress("FLOAT_ADDRESS");
        address feeAddress = vm.envAddress("FEE_ADDRESS");
        address emergencyAdmin = vm.envAddress("EMERGENCY_ADMIN");
        address target = vm.envAddress("TARGET_VAULT");
        uint16 feeBps = uint16(vm.envOr("FEE_BPS", uint256(1_000)));

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        YieldDonatingTokenizedStrategy impl = new YieldDonatingTokenizedStrategy();
        address predicted = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        Splitter splitter = new Splitter(predicted, keeper, floatAddress, feeAddress, feeBps);
        VaultFactory factory = new VaultFactory(deployer, address(splitter), address(impl), keeper, emergencyAdmin);
        require(address(factory) == predicted, "factory address mismatch");
        factory.setAllowedTarget(target, true);
        vm.stopBroadcast();

        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "implementation", address(impl));
        vm.serializeAddress(o, "splitter", address(splitter));
        vm.serializeAddress(o, "factory", address(factory));
        string memory json = vm.serializeAddress(o, "target", target);
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("wrote", path);
    }
}
```

- [ ] **Step 5: Dry-run the script on a local fork**

```bash
cd contracts && mkdir -p deployments && touch deployments/.gitkeep
anvil --fork-url $ARBITRUM_RPC_URL --port 8545 &
KEEPER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 FLOAT_ADDRESS=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC \
FEE_ADDRESS=0x90F79bf6EB2c4f870365E785982E1f101E93b906 EMERGENCY_ADMIN=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
TARGET_VAULT=0x5c0C306Aaa9F877de636f4d5822cA9F2E81563BA \
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --broadcast
kill %1
```
Expected: `wrote deployments/42161.json` and the file has all five keys. Delete the local file afterwards (`rm deployments/42161.json`); the real one is written when deploying to the Tenderly Virtual TestNet in Task 13.

- [ ] **Step 6: Commit**

```bash
git add config contracts/test/Fork.t.sol contracts/script contracts/deployments/.gitkeep
git commit -m "Add the Arbitrum One fork test and the deploy script"
```

---

### Task 6: Kernel counts tool spend as usage

**Files:**
- Modify: `engine/ledger.ts`, `engine/ledger.test.ts`

**Interfaces:**
- Produces: `Position.toolSpent: number` (USDC spent on tools this period); `usageCost(p, params) = p.spent / (1 - railFee) + p.toolSpent`; `spendOnTool(p, usd, pricePerShare, params): Position`; `remaining` now subtracts tool spend.

- [ ] **Step 1: Write the failing tests**

Append to `engine/ledger.test.ts` (and add `spendOnTool` to the import list):
```ts
test("tool spend counts toward usage and shrinks the remaining credit", () => {
  const H = HACKATHON_PARAMS;
  const p0 = open(100_000, 1);
  const p1 = spendOnTool(spend(p0, 300, 1.01, H), 200, 1.01, H);
  close(usageCost(p1, H), 500);
  close(remaining(p1, 1.01, H), 1_000 - 500);
  const s = settle(p1, 1.01, H);
  close(s.usage, 500);
  close(s.fee, 50);
});

test("tool spend cannot exceed what is left", () => {
  const p = open(100_000, 1);
  assert.throws(() => spendOnTool(p, 1, 1.0, HACKATHON_PARAMS), /over limit/);
});
```
Also add `usageCost` to the import list.

- [ ] **Step 2: Run to see them fail**

Run: `npm test`
Expected: FAIL, `spendOnTool` is not exported.

- [ ] **Step 3: Implement**

In `engine/ledger.ts`:

Replace the `Position` type and `open`:
```ts
export type Position = {
  principal: number; // USD basis that is never spent; grows when leftover yield is returned
  shares: number;    // ERC-4626 vault shares, held in the customer's own wallet
  spent: number;     // model credits consumed this period across all keys, USD of credits
  toolSpent: number; // paid tool calls this period, USDC (no rail fee: paid in USDC directly)
};

export function open(principal: number, pricePerShare: number): Position {
  if (principal <= 0) throw new Error("principal must be positive");
  return { principal, shares: principal / pricePerShare, spent: 0, toolSpent: 0 };
}
```

Replace `usageCost` and `remaining`:
```ts
export function usageCost(p: Position, params: Params = DEFAULT_PARAMS): number {
  return p.spent / (1 - params.railFee) + p.toolSpent;
}

export function remaining(p: Position, pricePerShare: number, params: Params = DEFAULT_PARAMS): number {
  return Math.max(0, (accruedYield(p, pricePerShare) - usageCost(p, params)) * (1 - params.railFee));
}
```

Add after `spend`:
```ts
export function spendOnTool(p: Position, usd: number, pricePerShare: number, params: Params = DEFAULT_PARAMS): Position {
  if (usd < 0) throw new Error("amount must be non-negative");
  if (usd * (1 - params.railFee) > remaining(p, pricePerShare, params) + 1e-9) throw new Error("over limit");
  return { ...p, toolSpent: p.toolSpent + usd };
}
```

In `settle`, the returned position resets both counters:
```ts
    position: { principal: p.principal + returned, shares: p.shares - pulledShares, spent: 0, toolSpent: 0 },
```

Update the header comment's `usage` line to:
```ts
//   usage     = credits spent / (1 - railFee) + tool spend   USDC it took to buy those credits and tools
```

`operatorNet` keeps treating all usage as model credit when estimating the absorbed rail fee, so it slightly overstates our cost once tools are used. That is conservative and fine for now.

- [ ] **Step 4: Run all engine tests**

Run: `npm test`
Expected: 16 tests PASS (14 existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add engine
git commit -m "Count paid tool calls toward usage in the ledger kernel"
```

---

### Task 7: App scaffold, config, store

**Files:**
- Create: `tsconfig.json`, `.env.example`, `app/config.ts`, `app/store.ts`, `app/test/store.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `HACKATHON_PARAMS`, `type Params` from `engine/ledger.ts`.
- Produces:
  - `type Config = { rpcUrl: string; chainId: number; usdc: `0x${string}`; target: `0x${string}`; factory: `0x${string}`; splitter: `0x${string}`; keeperKey: `0x${string}`; openRouterKey: string; orthogonalKey: string; toolWalletKey?: `0x${string}`; adminToken: string; dbPath: string; port: number; params: Params }`
  - `loadConfig(env?: Record<string, string | undefined>): Config`
  - `openStore(path: string): Store` with methods:
    - `addVault(vault: string, customer: string, label: string): void`
    - `vault(vault: string): VaultRow | undefined`, `listVaults(): VaultRow[]`
    - `setVaultState(vault: string, s: { frozen?: boolean; yieldUsd?: number }): void`
    - `addKey(k: { hash: string; vault: string; name: string; weight: number; secretSha256: string }): void`
    - `setWeight(hash: string, weight: number): void`, `setUsage(hash: string, usageTotal: number): void`
    - `keysForVault(vault: string): KeyRow[]`, `keyByHash(hash: string): KeyRow | undefined`, `keyBySecret(sha256: string): KeyRow | undefined`
    - `recordToolCall(keyHash: string, api: string, path: string, priceUsd: number): void`
    - `startNewPeriod(vault: string): void`
    - `recordSettlement(vault: string, usageMicro: bigint, tx: string): void`, `listSettlements(): SettlementRow[]`
    - `getMeta(k: string): string | undefined`, `setMeta(k: string, v: string): void`
  - `type VaultRow = { vault: string; customer: string; label: string; period: number; frozen: boolean; yieldUsd: number }`
  - `type KeyRow = { hash: string; vault: string; name: string; weight: number; baseline: number; usageTotal: number; toolSpent: number }` (`toolSpent` = this period)
  - `type SettlementRow = { vault: string; usageMicro: string; tx: string; at: number }`
  - All addresses stored lowercase.

- [ ] **Step 1: Install dependencies and set up TypeScript checking**

```bash
npm install @modelcontextprotocol/sdk@1.30.1 viem@2.56.9 x402-fetch@1.2.0 x402@^1.2.0 zod@^3.25.0
npm install -D typescript@^5.9.0 @types/node
```

Replace `package.json` scripts with:
```json
  "scripts": {
    "test": "node --test engine/*.test.ts app/test/*.test.ts",
    "typecheck": "tsc --noEmit",
    "serve": "node app/cli.ts serve"
  },
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["engine", "app", "demo"],
  "exclude": ["app/dashboard"]
}
```

`.env.example`:
```
# Arbitrum One fork (Tenderly Virtual TestNet admin RPC)
RPC_URL=
CHAIN_CONFIG=config/arbitrum-one.json
DEPLOYMENTS=contracts/deployments/42161.json
# keeper signer (must equal KEEPER used at deploy)
KEEPER_PRIVATE_KEY=
OPENROUTER_MANAGEMENT_KEY=
ORTHOGONAL_API_KEY=
# Base mainnet wallet holding a few USDC for x402 tool calls
TOOL_WALLET_PRIVATE_KEY=
ADMIN_TOKEN=
DB_PATH=inferest.db
PORT=8787
RAIL_FEE=0
# demo only
DEMO_TREASURY_KEY=
DEMO_AGENT_KEY=
DEMO_MODEL=moonshotai/kimi-k2.6
API_URL=http://localhost:8787
```

- [ ] **Step 2: Write the failing store tests**

`app/test/store.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../store.ts";

const V = "0xAbC0000000000000000000000000000000000001";

function fresh() {
  const s = openStore(":memory:");
  s.addVault(V, "0xC0FFEE000000000000000000000000000000000A", "Treasury");
  s.addKey({ hash: "h1", vault: V, name: "dev-1", weight: 1, secretSha256: "s1" });
  s.addKey({ hash: "h2", vault: V, name: "dev-2", weight: 2, secretSha256: "s2" });
  return s;
}

test("stores addresses lowercase and starts at period 0, unfrozen", () => {
  const s = fresh();
  const v = s.vault(V)!;
  assert.equal(v.vault, V.toLowerCase());
  assert.equal(v.period, 0);
  assert.equal(v.frozen, false);
  assert.equal(s.listVaults().length, 1);
});

test("keys carry weight, usage and this period's tool spend", () => {
  const s = fresh();
  s.setUsage("h1", 3.5);
  s.recordToolCall("h1", "olostep", "/v1/scrapes", 0.005);
  s.recordToolCall("h1", "olostep", "/v1/scrapes", 0.005);
  const k = s.keysForVault(V).find((k) => k.hash === "h1")!;
  assert.equal(k.usageTotal, 3.5);
  assert.equal(k.toolSpent, 0.01);
  assert.equal(s.keyBySecret("s2")!.hash, "h2");
});

test("a new period moves the baseline to current usage and clears tool spend", () => {
  const s = fresh();
  s.setUsage("h1", 3.5);
  s.recordToolCall("h1", "a", "/b", 1);
  s.startNewPeriod(V);
  const k = s.keyByHash("h1")!;
  assert.equal(k.baseline, 3.5);
  assert.equal(k.toolSpent, 0);
  assert.equal(s.vault(V)!.period, 1);
});

test("vault state, settlements and meta round-trip", () => {
  const s = fresh();
  s.setVaultState(V, { frozen: true, yieldUsd: 12.5 });
  assert.deepEqual([s.vault(V)!.frozen, s.vault(V)!.yieldUsd], [true, 12.5]);
  s.recordSettlement(V, 526_315_789n, "0xtx");
  assert.equal(s.listSettlements()[0].usageMicro, "526315789");
  s.setMeta("lastReport", "123");
  assert.equal(s.getMeta("lastReport"), "123");
  assert.equal(s.getMeta("missing"), undefined);
});
```

- [ ] **Step 3: Run to see them fail**

Run: `npm test`
Expected: FAIL, cannot find `app/store.ts`.

- [ ] **Step 4: Implement the store**

`app/store.ts`:
```ts
import { DatabaseSync } from "node:sqlite";

export type VaultRow = { vault: string; customer: string; label: string; period: number; frozen: boolean; yieldUsd: number };
export type KeyRow = { hash: string; vault: string; name: string; weight: number; baseline: number; usageTotal: number; toolSpent: number };
export type SettlementRow = { vault: string; usageMicro: string; tx: string; at: number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vaults (
  vault TEXT PRIMARY KEY, customer TEXT NOT NULL, label TEXT NOT NULL,
  period INTEGER NOT NULL DEFAULT 0, frozen INTEGER NOT NULL DEFAULT 0, yield_usd REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS keys (
  hash TEXT PRIMARY KEY, vault TEXT NOT NULL REFERENCES vaults(vault), name TEXT NOT NULL,
  weight REAL NOT NULL, secret_sha256 TEXT NOT NULL UNIQUE,
  baseline REAL NOT NULL DEFAULT 0, usage_total REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY, key_hash TEXT NOT NULL, api TEXT NOT NULL, path TEXT NOT NULL,
  price REAL NOT NULL, period INTEGER NOT NULL, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY, vault TEXT NOT NULL, usage_micro TEXT NOT NULL, tx TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

const KEY_SELECT = `
SELECT k.hash, k.vault, k.name, k.weight, k.baseline, k.usage_total AS usageTotal,
  COALESCE((SELECT SUM(t.price) FROM tool_calls t WHERE t.key_hash = k.hash AND t.period = v.period), 0) AS toolSpent
FROM keys k JOIN vaults v ON v.vault = k.vault`;

const lc = (a: string) => a.toLowerCase();

export function openStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  const toVault = (r: any): VaultRow => ({
    vault: r.vault, customer: r.customer, label: r.label, period: Number(r.period),
    frozen: Number(r.frozen) === 1, yieldUsd: Number(r.yield_usd),
  });
  const toKey = (r: any): KeyRow => ({
    hash: r.hash, vault: r.vault, name: r.name, weight: Number(r.weight), baseline: Number(r.baseline),
    usageTotal: Number(r.usageTotal), toolSpent: Math.round(Number(r.toolSpent) * 1e6) / 1e6,
  });

  return {
    addVault(vault: string, customer: string, label: string): void {
      db.prepare("INSERT OR IGNORE INTO vaults (vault, customer, label) VALUES (?, ?, ?)").run(lc(vault), lc(customer), label);
    },
    vault(vault: string): VaultRow | undefined {
      const r = db.prepare("SELECT * FROM vaults WHERE vault = ?").get(lc(vault));
      return r ? toVault(r) : undefined;
    },
    listVaults(): VaultRow[] {
      return db.prepare("SELECT * FROM vaults ORDER BY vault").all().map(toVault);
    },
    setVaultState(vault: string, s: { frozen?: boolean; yieldUsd?: number }): void {
      if (s.frozen !== undefined) db.prepare("UPDATE vaults SET frozen = ? WHERE vault = ?").run(s.frozen ? 1 : 0, lc(vault));
      if (s.yieldUsd !== undefined) db.prepare("UPDATE vaults SET yield_usd = ? WHERE vault = ?").run(s.yieldUsd, lc(vault));
    },
    addKey(k: { hash: string; vault: string; name: string; weight: number; secretSha256: string }): void {
      db.prepare("INSERT INTO keys (hash, vault, name, weight, secret_sha256) VALUES (?, ?, ?, ?, ?)")
        .run(k.hash, lc(k.vault), k.name, k.weight, k.secretSha256);
    },
    setWeight(hash: string, weight: number): void {
      db.prepare("UPDATE keys SET weight = ? WHERE hash = ?").run(weight, hash);
    },
    setUsage(hash: string, usageTotal: number): void {
      db.prepare("UPDATE keys SET usage_total = ? WHERE hash = ?").run(usageTotal, hash);
    },
    keysForVault(vault: string): KeyRow[] {
      return db.prepare(`${KEY_SELECT} WHERE k.vault = ? ORDER BY k.hash`).all(lc(vault)).map(toKey);
    },
    keyByHash(hash: string): KeyRow | undefined {
      const r = db.prepare(`${KEY_SELECT} WHERE k.hash = ?`).get(hash);
      return r ? toKey(r) : undefined;
    },
    keyBySecret(sha256: string): KeyRow | undefined {
      const r = db.prepare(`${KEY_SELECT} WHERE k.secret_sha256 = ?`).get(sha256);
      return r ? toKey(r) : undefined;
    },
    recordToolCall(keyHash: string, api: string, path: string, priceUsd: number): void {
      db.prepare(`INSERT INTO tool_calls (key_hash, api, path, price, period, at)
        SELECT ?, ?, ?, ?, v.period, ? FROM keys k JOIN vaults v ON v.vault = k.vault WHERE k.hash = ?`)
        .run(keyHash, api, path, priceUsd, Date.now(), keyHash);
    },
    startNewPeriod(vault: string): void {
      db.prepare("UPDATE keys SET baseline = usage_total WHERE vault = ?").run(lc(vault));
      db.prepare("UPDATE vaults SET period = period + 1 WHERE vault = ?").run(lc(vault));
    },
    recordSettlement(vault: string, usageMicro: bigint, tx: string): void {
      db.prepare("INSERT INTO settlements (vault, usage_micro, tx, at) VALUES (?, ?, ?, ?)").run(lc(vault), usageMicro.toString(), tx, Date.now());
    },
    listSettlements(): SettlementRow[] {
      return db.prepare("SELECT vault, usage_micro AS usageMicro, tx, at FROM settlements ORDER BY id DESC").all()
        .map((r: any) => ({ vault: r.vault, usageMicro: String(r.usageMicro), tx: r.tx, at: Number(r.at) }));
    },
    getMeta(k: string): string | undefined {
      const r: any = db.prepare("SELECT v FROM meta WHERE k = ?").get(k);
      return r ? String(r.v) : undefined;
    },
    setMeta(k: string, v: string): void {
      db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
    },
  };
}

export type Store = ReturnType<typeof openStore>;
```

- [ ] **Step 5: Implement config**

`app/config.ts`:
```ts
import { readFileSync } from "node:fs";
import { HACKATHON_PARAMS, type Params } from "../engine/ledger.ts";

type Hex = `0x${string}`;

export type Config = {
  rpcUrl: string; chainId: number; usdc: Hex; target: Hex; factory: Hex; splitter: Hex;
  keeperKey: Hex; openRouterKey: string; orthogonalKey: string; toolWalletKey?: Hex;
  adminToken: string; dbPath: string; port: number; params: Params;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`missing env ${k}`);
    return v;
  };
  const chain = JSON.parse(readFileSync(env.CHAIN_CONFIG ?? "config/arbitrum-one.json", "utf8"));
  const dep = JSON.parse(readFileSync(need("DEPLOYMENTS"), "utf8"));
  const railFee = Number(env.RAIL_FEE ?? "0");
  if (!(railFee >= 0 && railFee < 1)) throw new Error("RAIL_FEE must be in [0, 1)");
  return {
    rpcUrl: need("RPC_URL"),
    chainId: Number(dep.chainId),
    usdc: chain.usdc,
    target: dep.target,
    factory: dep.factory,
    splitter: dep.splitter,
    keeperKey: need("KEEPER_PRIVATE_KEY") as Hex,
    openRouterKey: need("OPENROUTER_MANAGEMENT_KEY"),
    orthogonalKey: env.ORTHOGONAL_API_KEY ?? "",
    toolWalletKey: env.TOOL_WALLET_PRIVATE_KEY ? (env.TOOL_WALLET_PRIVATE_KEY as Hex) : undefined,
    adminToken: need("ADMIN_TOKEN"),
    dbPath: env.DB_PATH ?? "inferest.db",
    port: Number(env.PORT ?? 8787),
    params: { ...HACKATHON_PARAMS, railFee },
  };
}
```

- [ ] **Step 6: Run tests and the type check**

Run: `npm test && npm run typecheck`
Expected: all tests PASS (store tests included); `tsc` prints nothing.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json .env.example app
git commit -m "Add the app scaffold: config and the sqlite store"
```

---

### Task 8: OpenRouter client and the limits math

**Files:**
- Create: `app/openrouter.ts`, `app/limits.ts`, `app/test/openrouter.test.ts`, `app/test/limits.test.ts`

**Interfaces:**
- Consumes: `type Params` from `engine/ledger.ts`; `type KeyRow` shape (fields `hash, weight, usageTotal, baseline, toolSpent`).
- Produces:
  - `type OrKey = { hash: string; usage: number; limit: number | null; disabled: boolean }`
  - `type OpenRouter = { createKey(name: string, limit: number): Promise<{ key: string; hash: string }>; getKey(hash: string): Promise<OrKey>; setLimit(hash: string, limit: number): Promise<void> }`
  - `openRouter(managementKey: string, fetchFn?: typeof fetch, base?: string): OpenRouter`
  - `type KeyInput = { hash: string; weight: number; usageTotal: number; baseline: number; toolSpent: number }`
  - `type KeyLimit = { hash: string; budget: number; spent: number; remaining: number; limit: number }`
  - `computeLimits(yieldUsd: number, keys: KeyInput[], params: Params, frozen: boolean): KeyLimit[]`
  - `toolBudgetUsd(l: KeyLimit, params: Params): number`
  - `usageMicro(keys: KeyInput[], params: Params): bigint`

- [ ] **Step 1: Write the failing limits tests**

`app/test/limits.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLimits, toolBudgetUsd, usageMicro, type KeyInput } from "../limits.ts";
import { HACKATHON_PARAMS, DEFAULT_PARAMS } from "../../engine/ledger.ts";

const H = HACKATHON_PARAMS;
const key = (hash: string, weight: number, usageTotal = 0, baseline = 0, toolSpent = 0): KeyInput =>
  ({ hash, weight, usageTotal, baseline, toolSpent });

test("equal weights split the credit evenly and limits are cumulative", () => {
  const out = computeLimits(2_225.25, [key("a", 1, 10, 10), key("b", 1), key("c", 1)], H, false);
  for (const l of out) assert.equal(Math.round(l.budget * 100), 74_175);
  assert.equal(out[0].limit, 10 + 741.75); // usage before this period stays in the cumulative limit
});

test("a key's unused share does not flow to the others", () => {
  const out = computeLimits(300, [key("a", 1, 100), key("b", 1, 0)], H, false);
  assert.equal(out[0].remaining, 50);
  assert.equal(out[1].remaining, 150);
});

test("tool spend comes out of the same key budget", () => {
  const [l] = computeLimits(100, [key("a", 1, 20, 0, 30)], H, false);
  assert.equal(l.spent, 50);
  assert.equal(l.remaining, 50);
  assert.equal(toolBudgetUsd(l, H), 50);
});

test("frozen vaults pin every key at its current usage", () => {
  const out = computeLimits(1_000, [key("a", 1, 7), key("b", 1, 3)], H, true);
  assert.deepEqual(out.map((l) => l.limit), [7, 3]);
});

test("zero weights and negative yield open nothing", () => {
  assert.equal(computeLimits(100, [key("a", 0, 5)], H, false)[0].limit, 5);
  assert.equal(computeLimits(-5, [key("a", 1, 5)], H, false)[0].limit, 5);
});

test("the rail fee scales credit and settlement usage", () => {
  const [l] = computeLimits(100, [key("a", 1, 19, 0, 0)], DEFAULT_PARAMS, false);
  assert.ok(Math.abs(l.budget - 95) < 1e-9);
  assert.equal(usageMicro([key("a", 1, 19, 0, 1)], DEFAULT_PARAMS), 21_000_000n); // 19/0.95 + 1
});

test("settlement usage in USDC base units", () => {
  assert.equal(usageMicro([key("a", 1, 510, 10, 0.25), key("b", 1, 0)], H), 500_250_000n);
});
```

- [ ] **Step 2: Write the failing OpenRouter tests**

`app/test/openrouter.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openRouter } from "../openrouter.ts";

function fakeFetch(responses: unknown[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("createKey posts name and limit and returns the key once", async () => {
  const f = fakeFetch([{ data: { hash: "h1", usage: 0, limit: 0 }, key: "sk-or-v1-abc" }]);
  const or = openRouter("mgmt", f.fn);
  assert.deepEqual(await or.createKey("inferest:dev-1", 0), { key: "sk-or-v1-abc", hash: "h1" });
  assert.equal(f.calls[0].url, "https://openrouter.ai/api/v1/keys");
  assert.equal(f.calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { name: "inferest:dev-1", limit: 0, include_byok_in_limit: true });
  assert.equal((f.calls[0].init.headers as Record<string, string>).Authorization, "Bearer mgmt");
});

test("getKey maps usage and limit", async () => {
  const f = fakeFetch([{ data: { hash: "h1", usage: 25.5, limit: 100, disabled: false } }]);
  assert.deepEqual(await openRouter("m", f.fn).getKey("h1"), { hash: "h1", usage: 25.5, limit: 100, disabled: false });
});

test("setLimit patches the key", async () => {
  const f = fakeFetch([{ data: {} }]);
  await openRouter("m", f.fn).setLimit("h1", 12.34);
  assert.equal(f.calls[0].url, "https://openrouter.ai/api/v1/keys/h1");
  assert.equal(f.calls[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { limit: 12.34 });
});

test("errors carry the status", async () => {
  const fn = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(openRouter("m", fn).getKey("h1"), /401/);
});
```

- [ ] **Step 3: Run to see them fail**

Run: `npm test`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement limits**

`app/limits.ts`:
```ts
import type { Params } from "../engine/ledger.ts";

export type KeyInput = { hash: string; weight: number; usageTotal: number; baseline: number; toolSpent: number };
export type KeyLimit = { hash: string; budget: number; spent: number; remaining: number; limit: number };

const floor4 = (x: number) => Math.floor(x * 1e4) / 1e4;

/**
 * Per-key budgets for this period. Credit = yield in the Splitter × (1 − railFee), split by weight.
 * A key's budget is fixed by its weight: what one key leaves unused does not flow to the others.
 * `limit` is what OpenRouter needs: its limits are cumulative, so it is usageTotal + remaining.
 */
export function computeLimits(yieldUsd: number, keys: KeyInput[], params: Params, frozen: boolean): KeyLimit[] {
  const credit = frozen ? 0 : Math.max(0, yieldUsd) * (1 - params.railFee);
  const weightSum = keys.reduce((s, k) => s + Math.max(0, k.weight), 0);
  return keys.map((k) => {
    const budget = weightSum > 0 ? (credit * Math.max(0, k.weight)) / weightSum : 0;
    const spent = Math.max(0, k.usageTotal - k.baseline) + k.toolSpent * (1 - params.railFee);
    const remaining = Math.max(0, budget - spent);
    return { hash: k.hash, budget, spent, remaining, limit: floor4(k.usageTotal + remaining) };
  });
}

/** USDC a key may still spend on tools (tools are paid in USDC, so no rail fee). */
export function toolBudgetUsd(l: KeyLimit, params: Params): number {
  return l.remaining / (1 - params.railFee);
}

/** What the period cost, in USDC base units, for Splitter.settle. */
export function usageMicro(keys: KeyInput[], params: Params): bigint {
  const usd = keys.reduce(
    (s, k) => s + Math.max(0, k.usageTotal - k.baseline) / (1 - params.railFee) + k.toolSpent,
    0,
  );
  return BigInt(Math.round(usd * 1e6));
}
```

- [ ] **Step 5: Implement the OpenRouter client**

`app/openrouter.ts`:
```ts
export type OrKey = { hash: string; usage: number; limit: number | null; disabled: boolean };
export type OpenRouter = {
  createKey(name: string, limit: number): Promise<{ key: string; hash: string }>;
  getKey(hash: string): Promise<OrKey>;
  setLimit(hash: string, limit: number): Promise<void>;
};

export function openRouter(managementKey: string, fetchFn: typeof fetch = fetch, base = "https://openrouter.ai/api/v1"): OpenRouter {
  async function call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetchFn(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${managementKey}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`OpenRouter ${method} ${path} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
  const toKey = (d: any): OrKey => ({
    hash: String(d.hash), usage: Number(d.usage ?? 0), limit: d.limit ?? null, disabled: Boolean(d.disabled),
  });
  return {
    async createKey(name, limit) {
      const r = await call("POST", "/keys", { name, limit, include_byok_in_limit: true });
      return { key: String(r.key), hash: String(r.data.hash) };
    },
    async getKey(hash) {
      return toKey((await call("GET", `/keys/${hash}`)).data);
    },
    async setLimit(hash, limit) {
      await call("PATCH", `/keys/${hash}`, { limit });
    },
  };
}
```

- [ ] **Step 6: Run tests and type check**

Run: `npm test && npm run typecheck`
Expected: all PASS.

- [ ] **Step 7: Check the real API accepts a zero limit**

Run (needs a real management key):
```bash
node -e 'import("./app/openrouter.ts").then(async m=>{const o=m.openRouter(process.env.OPENROUTER_MANAGEMENT_KEY);const k=await o.createKey("inferest:probe",0);console.log(await o.getKey(k.hash));})'
```
Expected: prints a key with `limit: 0`. If the API rejects `0`, change `computeLimits`'s floor and `createKey` callers to use `0.0001` and add a test for it. Delete the probe key in the OpenRouter dashboard afterwards.

- [ ] **Step 8: Commit**

```bash
git add app
git commit -m "Add the OpenRouter key client and per-key limit math"
```

---

### Task 9: Chain client and keeper jobs

**Files:**
- Create: `app/chain.ts`, `app/keeper.ts`, `app/test/keeper.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 7), `Store` (Task 7), `OpenRouter`, `computeLimits`, `usageMicro`, `toolBudgetUsd` (Task 8), `type Params`.
- Produces:
  - `interface Chain { yieldOf(vault: string): Promise<bigint>; lossPending(vault: string): Promise<boolean>; report(vault: string): Promise<string>; settle(vault: string, usageMicro: bigint): Promise<string>; customerOf(vault: string): Promise<string> }`
  - `makeChain(cfg: Config): Chain`
  - `type KeeperDeps = { chain: Chain; store: Store; or: OpenRouter; params: Params; log: (msg: string) => void }`
  - `syncVault(d: KeeperDeps, vault: string): Promise<KeyLimit[]>`, `syncAll(d): Promise<void>`
  - `reportAll(d, now?: number): Promise<void>`
  - `settleVault(d, vault: string): Promise<{ usage: bigint; tx: string } | null>`
  - `tick(d, now?: number): Promise<void>`
  - `toolBudgetFor(store: Store, params: Params, keyHash: string): number`

- [ ] **Step 1: Write the failing keeper tests**

`app/test/keeper.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../store.ts";
import { syncVault, settleVault, reportAll, tick, toolBudgetFor, type KeeperDeps } from "../keeper.ts";
import type { Chain } from "../chain.ts";
import type { OpenRouter } from "../openrouter.ts";
import { HACKATHON_PARAMS } from "../../engine/ledger.ts";

const V = "0x00000000000000000000000000000000000000aa";

function setup(opts: { yieldMicro?: bigint; lossPending?: boolean; usage?: Record<string, number[]> } = {}) {
  const events: string[] = [];
  const store = openStore(":memory:");
  store.addVault(V, "0x00000000000000000000000000000000000000cc", "T");
  store.addKey({ hash: "h1", vault: V, name: "a", weight: 1, secretSha256: "s1" });
  store.addKey({ hash: "h2", vault: V, name: "b", weight: 1, secretSha256: "s2" });
  const usage = opts.usage ?? { h1: [0], h2: [0] };
  const chain: Chain = {
    yieldOf: async () => opts.yieldMicro ?? 2_000_000_000n,
    lossPending: async () => opts.lossPending ?? false,
    report: async (v) => { events.push(`report:${v}`); return "0xr"; },
    settle: async (v, u) => { events.push(`settle:${u}`); return "0xs"; },
    customerOf: async () => "0x00000000000000000000000000000000000000cc",
  };
  const or: OpenRouter = {
    createKey: async () => ({ key: "k", hash: "h" }),
    getKey: async (h) => {
      const seq = usage[h];
      const u = seq.length > 1 ? seq.shift()! : seq[0];
      events.push(`get:${h}:${u}`);
      return { hash: h, usage: u, limit: null, disabled: false };
    },
    setLimit: async (h, l) => { events.push(`limit:${h}:${l}`); },
  };
  const d: KeeperDeps = { chain, store, or, params: HACKATHON_PARAMS, log: () => {} };
  return { d, store, events };
}

test("sync writes each key's weighted limit and stores yield", async () => {
  const { d, store, events } = setup({ usage: { h1: [100], h2: [0] } });
  await syncVault(d, V);
  assert.ok(events.includes("limit:h1:1000")); // 100 used of a 1,000 budget -> cumulative limit 1,000
  assert.ok(events.includes("limit:h2:1000"));
  assert.equal(store.vault(V)!.yieldUsd, 2_000);
});

test("freezes limits when a loss is pending", async () => {
  const { d, store, events } = setup({ lossPending: true, usage: { h1: [40], h2: [7] } });
  await syncVault(d, V);
  assert.ok(events.includes("limit:h1:40"));
  assert.ok(events.includes("limit:h2:7"));
  assert.equal(store.vault(V)!.frozen, true);
});

test("skips settlement when a loss is pending", async () => {
  const { d, events } = setup({ lossPending: true });
  assert.equal(await settleVault(d, V), null);
  assert.ok(!events.some((e) => e.startsWith("settle:")));
});

test("settle freezes keys, re-reads usage, then settles", async () => {
  // h1 reads 100 on the freeze pass, then 101 after a request that was already in flight
  const { d, store, events } = setup({ usage: { h1: [100, 101], h2: [0] } });
  const r = await settleVault(d, V);
  const iFreeze = events.indexOf("limit:h1:100");
  const iReread = events.indexOf("get:h1:101");
  const iSettle = events.findIndex((e) => e.startsWith("settle:"));
  assert.ok(iFreeze >= 0 && iFreeze < iReread && iReread < iSettle);
  assert.equal(r!.usage, 101_000_000n);
  assert.equal(store.keyByHash("h1")!.baseline, 101);
  assert.equal(store.vault(V)!.period, 1);
  assert.equal(store.listSettlements().length, 1);
});

test("reportAll reports every vault and survives a failing one", async () => {
  const { d, store, events } = setup();
  store.addVault("0x00000000000000000000000000000000000000bb", "0x1", "U");
  const orig = d.chain.report;
  d.chain.report = async (v) => { if (v.endsWith("aa")) throw new Error("boom"); return orig(v); };
  await reportAll(d, 5);
  assert.ok(events.includes("report:0x00000000000000000000000000000000000000bb"));
  assert.equal(store.getMeta("lastReport"), "5");
});

test("tick reports once a day and settles on a new month, not on first run", async () => {
  const { d, store, events } = setup();
  const day1 = Date.UTC(2026, 9, 1, 0, 0);
  await tick(d, day1);
  assert.equal(events.filter((e) => e.startsWith("report:")).length, 1);
  assert.equal(events.filter((e) => e.startsWith("settle:")).length, 0);
  await tick(d, day1 + 60_000);
  assert.equal(events.filter((e) => e.startsWith("report:")).length, 1);
  await tick(d, Date.UTC(2026, 10, 1, 0, 0));
  assert.equal(events.filter((e) => e.startsWith("settle:")).length, 1);
  assert.equal(store.getMeta("lastSettleMonth"), "2026-11");
});

test("toolBudgetFor uses the last synced state", async () => {
  const { d, store } = setup({ usage: { h1: [100], h2: [0] } });
  await syncVault(d, V);
  store.recordToolCall("h1", "a", "/b", 50);
  assert.equal(toolBudgetFor(store, HACKATHON_PARAMS, "h1"), 850);
  assert.equal(toolBudgetFor(store, HACKATHON_PARAMS, "nope"), 0);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npm test`
Expected: FAIL, `app/keeper.ts` not found.

- [ ] **Step 3: Implement the chain client**

`app/chain.ts`:
```ts
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "./config.ts";

export interface Chain {
  yieldOf(vault: string): Promise<bigint>;
  /** True when the yield source is worth less than the vault last reported: limits must freeze. */
  lossPending(vault: string): Promise<boolean>;
  report(vault: string): Promise<string>;
  settle(vault: string, usageMicro: bigint): Promise<string>;
  customerOf(vault: string): Promise<string>;
}

const splitterAbi = parseAbi([
  "function yieldOf(address vault) view returns (uint256)",
  "function settle(address vault, uint256 usage) returns (uint256 paid, uint256 fee, uint256 returnedShares)",
]);
const strategyAbi = parseAbi([
  "function report() returns (uint256 profit, uint256 loss)",
  "function totalAssets() view returns (uint256)",
  "function targetVault() view returns (address)",
]);
const erc4626Abi = parseAbi([
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);
const factoryAbi = parseAbi(["function customerOf(address vault) view returns (address)"]);

type Hex = `0x${string}`;

export function makeChain(cfg: Config): Chain {
  const chain = defineChain({
    id: cfg.chainId, name: "inferest", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  const account = privateKeyToAccount(cfg.keeperKey);
  const wallet = createWalletClient({ chain, account, transport: http(cfg.rpcUrl) });

  async function write(address: Hex, abi: any, functionName: string, args: unknown[]): Promise<string> {
    const { request } = await pub.simulateContract({ account, address, abi, functionName, args } as any);
    const hash = await wallet.writeContract(request as any);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
    return hash;
  }

  return {
    yieldOf: (vault) =>
      pub.readContract({ address: cfg.splitter, abi: splitterAbi, functionName: "yieldOf", args: [vault as Hex] }),
    async lossPending(vault) {
      const v = vault as Hex;
      const [stored, target] = await Promise.all([
        pub.readContract({ address: v, abi: strategyAbi, functionName: "totalAssets" }),
        pub.readContract({ address: v, abi: strategyAbi, functionName: "targetVault" }),
      ]);
      const shares = await pub.readContract({ address: target, abi: erc4626Abi, functionName: "balanceOf", args: [v] });
      const [live, idle] = await Promise.all([
        pub.readContract({ address: target, abi: erc4626Abi, functionName: "previewRedeem", args: [shares] }),
        pub.readContract({ address: cfg.usdc, abi: erc4626Abi, functionName: "balanceOf", args: [v] }),
      ]);
      return live + idle < stored;
    },
    report: (vault) => write(vault as Hex, strategyAbi, "report", []),
    settle: (vault, usageMicro) => write(cfg.splitter, splitterAbi, "settle", [vault, usageMicro]),
    customerOf: (vault) =>
      pub.readContract({ address: cfg.factory, abi: factoryAbi, functionName: "customerOf", args: [vault as Hex] }),
  };
}
```

- [ ] **Step 4: Implement the keeper**

`app/keeper.ts`:
```ts
import type { Params } from "../engine/ledger.ts";
import type { Chain } from "./chain.ts";
import type { OpenRouter } from "./openrouter.ts";
import type { Store, KeyRow } from "./store.ts";
import { computeLimits, toolBudgetUsd, usageMicro, type KeyLimit } from "./limits.ts";

export type KeeperDeps = { chain: Chain; store: Store; or: OpenRouter; params: Params; log: (msg: string) => void };

const DAY_MS = 86_400_000;

async function refreshUsage(d: KeeperDeps, keys: KeyRow[]): Promise<void> {
  for (const k of keys) {
    const live = await d.or.getKey(k.hash);
    d.store.setUsage(k.hash, live.usage);
    k.usageTotal = live.usage;
  }
}

export async function syncVault(d: KeeperDeps, vault: string): Promise<KeyLimit[]> {
  const frozen = await d.chain.lossPending(vault);
  const yieldUsd = Number(await d.chain.yieldOf(vault)) / 1e6;
  d.store.setVaultState(vault, { frozen, yieldUsd });
  if (frozen) d.log(`loss pending on ${vault}: keys frozen at current usage`);
  const keys = d.store.keysForVault(vault);
  await refreshUsage(d, keys);
  const limits = computeLimits(yieldUsd, keys, d.params, frozen);
  for (const l of limits) await d.or.setLimit(l.hash, l.limit);
  return limits;
}

export async function syncAll(d: KeeperDeps): Promise<void> {
  for (const v of d.store.listVaults()) {
    try {
      await syncVault(d, v.vault);
    } catch (e) {
      d.log(`sync ${v.vault} failed: ${(e as Error).message}`);
    }
  }
}

export async function reportAll(d: KeeperDeps, now: number = Date.now()): Promise<void> {
  for (const v of d.store.listVaults()) {
    try {
      await d.chain.report(v.vault);
    } catch (e) {
      d.log(`report ${v.vault} failed: ${(e as Error).message}`);
    }
  }
  d.store.setMeta("lastReport", String(now));
}

/** Freeze, re-read, settle, open a new period, re-sync. */
export async function settleVault(d: KeeperDeps, vault: string): Promise<{ usage: bigint; tx: string } | null> {
  if (await d.chain.lossPending(vault)) {
    d.log(`settle ${vault} skipped: loss pending`);
    return null;
  }
  const keys = d.store.keysForVault(vault);
  await refreshUsage(d, keys);
  for (const k of keys) await d.or.setLimit(k.hash, k.usageTotal);
  await refreshUsage(d, keys); // catch requests that were in flight during the freeze
  const usage = usageMicro(keys, d.params);
  const tx = await d.chain.settle(vault, usage);
  d.store.recordSettlement(vault, usage, tx);
  d.store.startNewPeriod(vault);
  await syncVault(d, vault);
  return { usage, tx };
}

export async function tick(d: KeeperDeps, now: number = Date.now()): Promise<void> {
  await syncAll(d);
  const lastReport = Number(d.store.getMeta("lastReport") ?? 0);
  if (now - lastReport >= DAY_MS) await reportAll(d, now);
  const month = new Date(now).toISOString().slice(0, 7);
  const lastMonth = d.store.getMeta("lastSettleMonth");
  if (lastMonth !== month) {
    if (lastMonth !== undefined) {
      for (const v of d.store.listVaults()) {
        try {
          await settleVault(d, v.vault);
        } catch (e) {
          d.log(`settle ${v.vault} failed: ${(e as Error).message}`);
        }
      }
    }
    d.store.setMeta("lastSettleMonth", month);
  }
}

export function toolBudgetFor(store: Store, params: Params, keyHash: string): number {
  const key = store.keyByHash(keyHash);
  if (!key) return 0;
  const v = store.vault(key.vault);
  if (!v) return 0;
  const l = computeLimits(v.yieldUsd, store.keysForVault(key.vault), params, v.frozen).find((x) => x.hash === keyHash);
  return l ? toolBudgetUsd(l, params) : 0;
}
```

- [ ] **Step 5: Run tests and type check**

Run: `npm test && npm run typecheck`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add app
git commit -m "Add the keeper: minute sync, daily report, monthly settle with a freeze"
```

---

### Task 10: Tool gateway (Orthogonal)

**Files:**
- Create: `app/tools.ts`, `app/test/tools.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks directly (budget and recording are injected).
- Produces:
  - `type PayingFetchFactory = (maxMicro: bigint, onAmount: (micro: bigint) => void) => typeof fetch`
  - `type ToolHit = { api: string; path: string; method: string; description: string; priceUsd: number }`
  - `type ToolCall = { api: string; path: string; method?: string; body?: unknown; query?: Record<string, string> }`
  - `class BudgetExhausted extends Error`
  - `toolGateway(d: { orthogonalKey: string; fetchFn: typeof fetch; makePayingFetch: PayingFetchFactory; budgetUsd: (keyHash: string) => number; record: (keyHash: string, api: string, path: string, priceUsd: number) => void })` returning `{ search(prompt: string, limit?: number): Promise<ToolHit[]>; details(api: string, path: string): Promise<unknown>; run(keyHash: string, call: ToolCall): Promise<unknown> }`
  - `details` calls `POST https://api.orthogonal.com/v1/details` (free) and returns the endpoint's full parameter schema and price, so agents never guess parameter names before paying.
  - `type ToolGateway = ReturnType<typeof toolGateway>`
  - `x402PayingFetch(privateKey: `0x${string}`): PayingFetchFactory`

- [ ] **Step 1: Write the failing tests**

`app/test/tools.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolGateway, BudgetExhausted, type PayingFetchFactory } from "../tools.ts";

const searchBody = {
  success: true,
  results: [{ slug: "olostep", endpoints: [
    { path: "/v1/scrapes", method: "POST", description: "Scrape a URL", price: "0.005", isPayable: true },
    { path: "/v1/private", method: "GET", description: "Not payable", price: "0.01", isPayable: false },
  ] }],
};

function gateway(budget: number, charge = 5_000n) {
  const recorded: unknown[][] = [];
  const paid: { url: string; max: bigint; init: RequestInit }[] = [];
  const makePayingFetch: PayingFetchFactory = (max, onAmount) =>
    (async (url: string, init: RequestInit) => {
      paid.push({ url, max, init });
      onAmount(charge);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
  const fetchFn = (async () => new Response(JSON.stringify(searchBody), { status: 200 })) as unknown as typeof fetch;
  const g = toolGateway({
    orthogonalKey: "orth", fetchFn, makePayingFetch,
    budgetUsd: () => budget,
    record: (...a) => recorded.push(a),
  });
  return { g, recorded, paid };
}

test("search flattens payable endpoints with USD prices", async () => {
  const { g } = gateway(1);
  assert.deepEqual(await g.search("scrape"), [
    { api: "olostep", path: "/v1/scrapes", method: "POST", description: "Scrape a URL", priceUsd: 0.005 },
  ]);
});

test("run pays through x402 and records the charged amount", async () => {
  const { g, recorded, paid } = gateway(2);
  await g.run("h1", { api: "olostep", path: "/v1/scrapes", method: "POST", body: { url_to_scrape: "https://example.com" } });
  assert.equal(paid[0].url, "https://x402.orthogonal.com/olostep/v1/scrapes");
  assert.equal(paid[0].init.method, "POST");
  assert.deepEqual(recorded, [["h1", "olostep", "/v1/scrapes", 0.005]]);
});

test("caps the x402 payment at the remaining budget", async () => {
  const { g, paid } = gateway(0.25);
  await g.run("h1", { api: "olostep", path: "/v1/scrapes" });
  assert.equal(paid[0].max, 250_000n);
});

test("refuses a run when the budget is exhausted", async () => {
  const { g, paid } = gateway(0);
  await assert.rejects(g.run("h1", { api: "olostep", path: "/v1/scrapes" }), BudgetExhausted);
  assert.equal(paid.length, 0);
});

test("details posts api and path to the free details endpoint", async () => {
  const calls: { url: string; body: string }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body) });
    return new Response(JSON.stringify({ success: true, endpoint: { path: "/v1/scrapes", price: "0.005" } }), { status: 200 });
  }) as unknown as typeof fetch;
  const g = toolGateway({ orthogonalKey: "orth", fetchFn, makePayingFetch: () => { throw new Error("must not pay"); }, budgetUsd: () => 1, record: () => {} });
  const out: any = await g.details("olostep", "/v1/scrapes");
  assert.equal(calls[0].url, "https://api.orthogonal.com/v1/details");
  assert.deepEqual(JSON.parse(calls[0].body), { api: "olostep", path: "/v1/scrapes" });
  assert.equal(out.endpoint.price, "0.005");
});

test("never retries a paid call", async () => {
  let attempts = 0;
  const g = toolGateway({
    orthogonalKey: "orth",
    fetchFn: (async () => new Response("{}")) as unknown as typeof fetch,
    makePayingFetch: () => (async () => { attempts++; throw new Error("socket hang up"); }) as unknown as typeof fetch,
    budgetUsd: () => 1,
    record: () => { throw new Error("must not record"); },
  });
  await assert.rejects(g.run("h1", { api: "olostep", path: "/v1/scrapes" }), /socket hang up/);
  assert.equal(attempts, 1);
});

test("rejects paths that could escape the API", async () => {
  const { g } = gateway(1);
  await assert.rejects(g.run("h1", { api: "olostep", path: "/../admin" }), /invalid/);
  await assert.rejects(g.run("h1", { api: "olo/step", path: "/x" }), /invalid/);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npm test`
Expected: FAIL, `app/tools.ts` not found.

- [ ] **Step 3: Implement the gateway**

`app/tools.ts`:
```ts
import { wrapFetchWithPayment } from "x402-fetch";
import { selectPaymentRequirements } from "x402/client";
import { createWalletClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

export type PayingFetchFactory = (maxMicro: bigint, onAmount: (micro: bigint) => void) => typeof fetch;
export type ToolHit = { api: string; path: string; method: string; description: string; priceUsd: number };
export type ToolCall = { api: string; path: string; method?: string; body?: unknown; query?: Record<string, string> };

export class BudgetExhausted extends Error {}

const SEARCH_URL = "https://api.orthogonal.com/v1/search";
const DETAILS_URL = "https://api.orthogonal.com/v1/details";
const X402_BASE = "https://x402.orthogonal.com";
const API_SLUG = /^[a-z0-9-]+$/i;
const PATH = /^\/[A-Za-z0-9\-._~/]*$/;

export function toolGateway(d: {
  orthogonalKey: string;
  fetchFn: typeof fetch;
  makePayingFetch: PayingFetchFactory;
  budgetUsd: (keyHash: string) => number;
  record: (keyHash: string, api: string, path: string, priceUsd: number) => void;
}) {
  return {
    async search(prompt: string, limit = 10): Promise<ToolHit[]> {
      const res = await d.fetchFn(SEARCH_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${d.orthogonalKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, limit }),
      });
      if (!res.ok) throw new Error(`Orthogonal search failed: ${res.status}`);
      const j: any = await res.json();
      return (j.results ?? []).flatMap((api: any) =>
        (api.endpoints ?? [])
          .filter((e: any) => e.isPayable !== false)
          .map((e: any) => ({
            api: String(api.slug), path: String(e.path), method: String(e.method ?? "POST"),
            description: String(e.description ?? ""), priceUsd: Number(e.price ?? 0),
          })),
      );
    },

    async details(api: string, path: string): Promise<unknown> {
      if (!API_SLUG.test(api) || !PATH.test(path) || path.includes("..")) throw new Error(`invalid tool ${api}${path}`);
      const res = await d.fetchFn(DETAILS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${d.orthogonalKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ api, path }),
      });
      if (!res.ok) throw new Error(`Orthogonal details failed: ${res.status}`);
      return res.json();
    },

    /** One attempt only. A failed or ambiguous paid call is never retried here: the caller checks usage first. */
    async run(keyHash: string, call: ToolCall): Promise<unknown> {
      if (!API_SLUG.test(call.api) || !PATH.test(call.path) || call.path.includes("..")) {
        throw new Error(`invalid tool ${call.api}${call.path}`);
      }
      const budget = d.budgetUsd(keyHash);
      if (!(budget > 0)) throw new BudgetExhausted("no yield left for tools on this key");
      let charged = 0n;
      const pay = d.makePayingFetch(BigInt(Math.floor(budget * 1e6)), (m) => { charged = m; });
      const method = (call.method ?? (call.body === undefined ? "GET" : "POST")).toUpperCase();
      const qs = call.query ? `?${new URLSearchParams(call.query)}` : "";
      const res = await pay(`${X402_BASE}/${call.api}${call.path}${qs}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: call.body === undefined || method === "GET" ? undefined : JSON.stringify(call.body),
      });
      if (!res.ok) throw new Error(`tool ${call.api}${call.path} failed: ${res.status} ${await res.text()}`);
      if (charged > 0n) d.record(keyHash, call.api, call.path, Number(charged) / 1e6);
      return res.json();
    },
  };
}

export type ToolGateway = ReturnType<typeof toolGateway>;

/** Real x402 payments in USDC on Base from our tool wallet, capped per call. */
export function x402PayingFetch(privateKey: `0x${string}`): PayingFetchFactory {
  const wallet = createWalletClient({ account: privateKeyToAccount(privateKey), chain: base, transport: http() });
  return (maxMicro, onAmount) =>
    wrapFetchWithPayment(fetch, wallet as any, maxMicro, (reqs: any, network: any, scheme: any) => {
      const chosen = selectPaymentRequirements(reqs, network, scheme);
      onAmount(BigInt(chosen.maxAmountRequired));
      return chosen;
    }) as unknown as typeof fetch;
}
```

- [ ] **Step 4: Run tests and type check**

Run: `npm test && npm run typecheck`
Expected: all PASS. If `tsc` reports that `selectPaymentRequirements` is not exported from `x402/client`, open `node_modules/x402/dist/cjs/client/index.d.ts`, find the exported selector (it is the function x402-fetch passes as its default), import that name instead, and keep the wrapper identical.

- [ ] **Step 5: Commit**

```bash
git add app
git commit -m "Add the Orthogonal tool gateway with a per-key x402 payment cap"
```

---

### Task 11: MCP server

**Files:**
- Create: `app/mcp.ts`, `app/test/mcp.test.ts`

**Interfaces:**
- Consumes: `ToolGateway`, `BudgetExhausted` (Task 10).
- Produces: `buildMcpServer(gateway: ToolGateway, keyHash: string): McpServer` exposing tools `search_tools({ prompt, limit? })`, `tool_details({ api, path })` and `run_tool({ api, path, method?, body?, query? })`.

- [ ] **Step 1: Write the failing test**

`app/test/mcp.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../mcp.ts";
import { BudgetExhausted, type ToolGateway } from "../tools.ts";

async function connect(gateway: ToolGateway) {
  const server = buildMcpServer(gateway, "h1");
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(c);
  return client;
}

const gateway = {
  search: async (prompt: string) => [{ api: "olostep", path: "/v1/scrapes", method: "POST", description: prompt, priceUsd: 0.005 }],
  details: async (api: string, path: string) => ({ api, path, parameters: [{ name: "url_to_scrape", in: "body", required: true }] }),
  run: async (keyHash: string, call: { api: string }) => {
    if (call.api === "broke") throw new BudgetExhausted("no yield left for tools on this key");
    return { keyHash, api: call.api };
  },
} as unknown as ToolGateway;

test("lists the three tools", async () => {
  const client = await connect(gateway);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["run_tool", "search_tools", "tool_details"]);
});

test("tool_details returns the parameter schema", async () => {
  const client = await connect(gateway);
  const r: any = await client.callTool({ name: "tool_details", arguments: { api: "olostep", path: "/v1/scrapes" } });
  assert.equal(JSON.parse(r.content[0].text).parameters[0].name, "url_to_scrape");
});

test("run_tool passes the authenticated key hash", async () => {
  const client = await connect(gateway);
  const r: any = await client.callTool({ name: "run_tool", arguments: { api: "olostep", path: "/v1/scrapes" } });
  assert.deepEqual(JSON.parse(r.content[0].text), { keyHash: "h1", api: "olostep" });
});

test("budget errors come back as tool errors, not crashes", async () => {
  const client = await connect(gateway);
  const r: any = await client.callTool({ name: "run_tool", arguments: { api: "broke", path: "/x" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no yield left/);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npm test`
Expected: FAIL, `app/mcp.ts` not found.

- [ ] **Step 3: Implement**

`app/mcp.ts`:
```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolGateway } from "./tools.ts";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

export function buildMcpServer(gateway: ToolGateway, keyHash: string): McpServer {
  const server = new McpServer({ name: "inferest-tools", version: "0.1.0" });

  server.registerTool(
    "search_tools",
    {
      description:
        "Find paid tools: web search, scraping, enrichment, research. Returns api, path, method and price in USD. " +
        "Calls are paid from this key's yield.",
      inputSchema: { prompt: z.string().min(1), limit: z.number().int().min(1).max(50).optional() },
    },
    async ({ prompt, limit }) => text(await gateway.search(prompt, limit)),
  );

  server.registerTool(
    "tool_details",
    {
      description:
        "Exact parameters (name, location: path, query or body) and price for one tool. " +
        "Call this before run_tool; never guess parameter names. Free.",
      inputSchema: { api: z.string(), path: z.string() },
    },
    async ({ api, path }) => text(await gateway.details(api, path)),
  );

  server.registerTool(
    "run_tool",
    {
      description:
        "Run a tool found with search_tools, using the parameters from tool_details. Paid per call from this key's yield. " +
        "If a call fails or times out, do not repeat it blindly.",
      inputSchema: {
        api: z.string(),
        path: z.string(),
        method: z.string().optional(),
        body: z.unknown().optional(),
        query: z.record(z.string(), z.string()).optional(),
      },
    },
    async (args) => {
      try {
        return text(await gateway.run(keyHash, args));
      } catch (e) {
        return { isError: true, content: [{ type: "text" as const, text: (e as Error).message }] };
      }
    },
  );

  return server;
}
```

- [ ] **Step 4: Run tests and type check**

Run: `npm test && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add app
git commit -m "Add the MCP server exposing search_tools and run_tool"
```

---

### Task 12: HTTP server, CLI, dashboard

**Files:**
- Create: `app/server.ts`, `app/cli.ts`, `app/dashboard/index.html`, `app/dashboard/app.js`, `app/test/server.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 7 to 11.
- Produces:
  - `type AppDeps = { store: Store; or: OpenRouter; chain: Chain; gateway: ToolGateway; params: Params; adminToken: string; publicConfig: Record<string, unknown>; keeper: KeeperDeps }`
  - `createApp(d: AppDeps): http.Server`
  - `sha256(s: string): string`
  - Routes:
    - `POST|GET|DELETE /mcp` (Bearer = the key's secret)
    - `GET /api/state` (public, read-only)
    - Admin (`x-admin-token`): `POST /api/vaults {vault, label}`, `POST /api/keys {vault, name, weight}` -> `{key, hash}`, `POST /api/keys/:hash/weight {weight}`, `POST /api/admin/sync`, `POST /api/admin/report`, `POST /api/admin/settle {vault}`
    - `GET /` and `/app.js`: dashboard
  - CLI: `node app/cli.ts serve|sync|report|settle <vault>`

- [ ] **Step 1: Write the failing server tests**

`app/test/server.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp, sha256, type AppDeps } from "../server.ts";
import { openStore } from "../store.ts";
import { HACKATHON_PARAMS } from "../../engine/ledger.ts";
import type { ToolGateway } from "../tools.ts";

const V = "0x00000000000000000000000000000000000000aa";
const ZERO = "0x0000000000000000000000000000000000000000";

async function start(customer = "0x00000000000000000000000000000000000000cc") {
  const store = openStore(":memory:");
  const created: string[] = [];
  const d: AppDeps = {
    store,
    or: {
      createKey: async (name) => { created.push(name); return { key: "sk-or-v1-secret", hash: "h1" }; },
      getKey: async (h) => ({ hash: h, usage: 0, limit: 0, disabled: false }),
      setLimit: async () => {},
    },
    chain: {
      yieldOf: async () => 0n, lossPending: async () => false,
      report: async () => "0x", settle: async () => "0x",
      customerOf: async (v) => (v === V ? customer : ZERO),
    },
    gateway: { search: async () => [], details: async () => ({}), run: async () => ({}) } as unknown as ToolGateway,
    params: HACKATHON_PARAMS,
    adminToken: "admin",
    publicConfig: { chainId: 42161 },
    keeper: undefined as unknown as AppDeps["keeper"],
  };
  d.keeper = { chain: d.chain, store, or: d.or, params: d.params, log: () => {} };
  const server = createApp(d);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, server, store, created };
}

const post = (base: string, path: string, body: unknown, token = "admin") =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", "x-admin-token": token }, body: JSON.stringify(body) });

test("mutating routes require the admin token", async () => {
  const { base, server } = await start();
  assert.equal((await post(base, "/api/vaults", { vault: V }, "wrong")).status, 401);
  assert.equal((await post(base, "/api/admin/sync", {}, "")).status, 401);
  server.close();
});

test("POST /api/vaults rejects a vault the factory does not know", async () => {
  const { base, server } = await start();
  const r = await post(base, "/api/vaults", { vault: "0x00000000000000000000000000000000000000bb" });
  assert.equal(r.status, 400);
  server.close();
});

test("registering a vault and a key returns the secret once and stores only its hash", async () => {
  const { base, server, store, created } = await start();
  assert.equal((await post(base, "/api/vaults", { vault: V, label: "Treasury" })).status, 201);
  const r = await post(base, "/api/keys", { vault: V, name: "dev-1", weight: 1 });
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { key: "sk-or-v1-secret", hash: "h1" });
  assert.equal(created[0], "inferest:dev-1");
  assert.equal(store.keyBySecret(sha256("sk-or-v1-secret"))!.hash, "h1");
  const state: any = await (await fetch(base + "/api/state")).json();
  assert.equal(state.vaults[0].keys[0].name, "dev-1");
  assert.ok(!JSON.stringify(state).includes("sk-or-v1-secret"));
  server.close();
});

test("negative weights are rejected", async () => {
  const { base, server } = await start();
  await post(base, "/api/vaults", { vault: V });
  assert.equal((await post(base, "/api/keys", { vault: V, name: "x", weight: -1 })).status, 400);
  server.close();
});

test("MCP rejects an unknown key", async () => {
  const { base, server } = await start();
  const r = await fetch(base + "/mcp", {
    method: "POST",
    headers: { Authorization: "Bearer nope", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(r.status, 401);
  server.close();
});

test("serves the dashboard", async () => {
  const { base, server } = await start();
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Inferest/);
  server.close();
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npm test`
Expected: FAIL, `app/server.ts` not found.

- [ ] **Step 3: Implement the server**

`app/server.ts`:
```ts
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Params } from "../engine/ledger.ts";
import type { Chain } from "./chain.ts";
import type { OpenRouter } from "./openrouter.ts";
import type { Store } from "./store.ts";
import type { ToolGateway } from "./tools.ts";
import { buildMcpServer } from "./mcp.ts";
import { computeLimits } from "./limits.ts";
import { syncAll, reportAll, settleVault, type KeeperDeps } from "./keeper.ts";

export type AppDeps = {
  store: Store; or: OpenRouter; chain: Chain; gateway: ToolGateway; params: Params;
  adminToken: string; publicConfig: Record<string, unknown>; keeper: KeeperDeps;
};

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const DASHBOARD = fileURLToPath(new URL("./dashboard/", import.meta.url));
const ZERO = /^0x0{40}$/i;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function bearer(req: IncomingMessage): string {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

function state(d: AppDeps) {
  return {
    config: d.publicConfig,
    vaults: d.store.listVaults().map((v) => {
      const keys = d.store.keysForVault(v.vault);
      const limits = computeLimits(v.yieldUsd, keys, d.params, v.frozen);
      return {
        ...v,
        keys: keys.map((k, i) => ({
          hash: k.hash, name: k.name, weight: k.weight, toolSpent: k.toolSpent,
          budget: limits[i].budget, spent: limits[i].spent, remaining: limits[i].remaining, limit: limits[i].limit,
        })),
      };
    }),
    settlements: d.store.listSettlements(),
  };
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!/^[a-z0-9.-]+$/i.test(file)) return send(res, 404, { error: "not found" });
  try {
    const body = await readFile(DASHBOARD + file);
    res.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : "text/html" });
    res.end(body);
  } catch {
    send(res, 404, { error: "not found" });
  }
}

async function route(d: AppDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/mcp") {
    const key = d.store.keyBySecret(sha256(bearer(req)));
    if (!key) return send(res, 401, { error: "unknown key" });
    const body = req.method === "POST" ? await readJson(req) : undefined;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildMcpServer(d.gateway, key.hash);
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  if (url.pathname === "/api/state" && req.method === "GET") return send(res, 200, state(d));

  if (url.pathname.startsWith("/api/")) {
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    if (req.headers["x-admin-token"] !== d.adminToken) return send(res, 401, { error: "admin token required" });
    const body = await readJson(req);

    if (url.pathname === "/api/vaults") {
      const vault = String(body.vault ?? "").toLowerCase();
      const customer = await d.chain.customerOf(vault).catch(() => "");
      if (!customer || ZERO.test(customer)) return send(res, 400, { error: "not a vault from our factory" });
      d.store.addVault(vault, customer, String(body.label ?? "customer"));
      return send(res, 201, { vault, customer: customer.toLowerCase() });
    }
    if (url.pathname === "/api/keys") {
      const vault = String(body.vault ?? "").toLowerCase();
      if (!d.store.vault(vault)) return send(res, 404, { error: "unknown vault" });
      const weight = Number(body.weight ?? 1);
      if (!(weight >= 0)) return send(res, 400, { error: "weight must be >= 0" });
      const name = String(body.name ?? "key");
      const { key, hash } = await d.or.createKey(`inferest:${name}`, 0);
      d.store.addKey({ hash, vault, name, weight, secretSha256: sha256(key) });
      return send(res, 201, { key, hash });
    }
    const w = url.pathname.match(/^\/api\/keys\/([0-9a-f]+)\/weight$/);
    if (w) {
      const weight = Number(body.weight);
      if (!(weight >= 0)) return send(res, 400, { error: "weight must be >= 0" });
      d.store.setWeight(w[1], weight);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/admin/sync") { await syncAll(d.keeper); return send(res, 200, { ok: true }); }
    if (url.pathname === "/api/admin/report") { await reportAll(d.keeper); return send(res, 200, { ok: true }); }
    if (url.pathname === "/api/admin/settle") {
      const r = await settleVault(d.keeper, String(body.vault ?? "").toLowerCase());
      return send(res, 200, { usageMicro: r ? r.usage.toString() : null, tx: r ? r.tx : null });
    }
    return send(res, 404, { error: "not found" });
  }

  return serveStatic(res, url.pathname);
}

export function createApp(d: AppDeps): Server {
  return createServer((req, res) => {
    route(d, req, res).catch((e) => send(res, 500, { error: (e as Error).message }));
  });
}
```

- [ ] **Step 4: Write the dashboard**

`app/dashboard/index.html`:
```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Inferest</title>
  <style>
    body { font: 15px/1.5 system-ui, sans-serif; max-width: 880px; margin: 0 auto; padding: 16px; color: #111; background: #fff; }
    h1 { margin: 0 0 4px; } .muted { color: #666; } .card { border: 1px solid #ddd; border-radius: 8px; padding: 12px 16px; margin: 12px 0; }
    table { width: 100%; border-collapse: collapse; } td, th { text-align: left; padding: 4px 6px; border-bottom: 1px solid #eee; }
    button { padding: 6px 12px; margin: 4px 4px 4px 0; cursor: pointer; } input { padding: 5px; }
    pre { background: #f6f6f6; padding: 8px; overflow-x: auto; }
  </style>
</head>
<body>
  <h1>Inferest</h1>
  <p class="muted">Your interest, now inference.</p>

  <div class="card">
    <h3>Wallet</h3>
    <button id="connect">Connect wallet</button> <span id="account" class="muted"></span>
    <div>
      <input id="amount" type="number" value="100000" /> USDC
      <button id="open">Create vault and deposit</button>
      <button id="withdraw">Withdraw everything</button>
    </div>
    <pre id="log"></pre>
  </div>

  <div class="card">
    <h3>Admin</h3>
    <input id="token" type="password" placeholder="admin token" />
    <button id="sync">Sync limits</button><button id="report">Report yield</button>
    <div><input id="keyname" placeholder="key name" value="dev-1" /> weight <input id="weight" type="number" value="1" style="width:60px" />
      <button id="addkey">Create key</button></div>
  </div>

  <div id="vaults"></div>
  <script type="module" src="/app.js"></script>
</body>
</html>
```

`app/dashboard/app.js`:
```js
import { createWalletClient, createPublicClient, custom, parseAbi, parseEventLogs, parseUnits } from "https://esm.sh/viem@2.56.9";

const factoryAbi = parseAbi([
  "function createVault(address target, string name, string symbol) returns (address)",
  "event VaultCreated(address indexed customer, address indexed vault, address indexed target)",
]);
const vaultAbi = parseAbi([
  "function acceptManagement()",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const erc20Abi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

const $ = (id) => document.getElementById(id);
const log = (m) => { $("log").textContent += m + "\n"; };
let wallet, pub, account, cfg, myVault;

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json", "x-admin-token": $("token").value }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.status);
  return j;
}

async function tx(address, abi, functionName, args) {
  const hash = await wallet.writeContract({ address, abi, functionName, args, account, chain: null });
  await pub.waitForTransactionReceipt({ hash });
  log(`${functionName}: ${hash}`);
  return hash;
}

$("connect").onclick = async () => {
  [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
  wallet = createWalletClient({ transport: custom(window.ethereum) });
  pub = createPublicClient({ transport: custom(window.ethereum) });
  $("account").textContent = account;
};

$("open").onclick = async () => {
  const amount = parseUnits($("amount").value, 6);
  const hash = await wallet.writeContract({ address: cfg.factory, abi: factoryAbi, functionName: "createVault",
    args: [cfg.target, "Inferest Vault", "infVAULT"], account, chain: null });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  myVault = parseEventLogs({ abi: factoryAbi, logs: receipt.logs })[0].args.vault;
  log(`vault: ${myVault}`);
  await tx(myVault, vaultAbi, "acceptManagement", []);
  await tx(cfg.usdc, erc20Abi, "approve", [myVault, amount]);
  await tx(myVault, vaultAbi, "deposit", [amount, account]);
  await api("/api/vaults", { vault: myVault, label: "Treasury" });
  await render();
};

$("withdraw").onclick = async () => {
  const shares = await pub.readContract({ address: myVault, abi: vaultAbi, functionName: "balanceOf", args: [account] });
  await tx(myVault, vaultAbi, "redeem", [shares, account, account]);
};

$("sync").onclick = async () => { await api("/api/admin/sync", {}); await render(); };
$("report").onclick = async () => { await api("/api/admin/report", {}); await api("/api/admin/sync", {}); await render(); };
$("addkey").onclick = async () => {
  const vault = myVault ?? (await api("/api/state")).vaults[0]?.vault;
  const r = await api("/api/keys", { vault, name: $("keyname").value, weight: Number($("weight").value) });
  alert(`Copy this key now, it is shown once:\n\n${r.key}`);
  await render();
};

async function render() {
  const s = await api("/api/state");
  cfg = s.config;
  $("vaults").innerHTML = s.vaults.map((v) => `
    <div class="card">
      <h3>${v.label} <span class="muted">${v.vault}</span></h3>
      <p>Yield in Splitter: <b>$${v.yieldUsd.toFixed(2)}</b> ${v.frozen ? "<b>(frozen: loss pending)</b>" : ""} &middot; period ${v.period}</p>
      <table><tr><th>Key</th><th>Weight</th><th>Budget</th><th>Spent</th><th>Tools</th><th>Left</th></tr>
      ${v.keys.map((k) => `<tr><td>${k.name}</td><td>${k.weight}</td><td>$${k.budget.toFixed(2)}</td>
        <td>$${k.spent.toFixed(4)}</td><td>$${k.toolSpent.toFixed(4)}</td><td>$${k.remaining.toFixed(2)}</td></tr>`).join("")}
      </table>
      <button onclick="window.settle('${v.vault}')">Settle now</button>
    </div>`).join("");
}
window.settle = async (vault) => { const r = await api("/api/admin/settle", { vault }); log(`settle: ${JSON.stringify(r)}`); await render(); };

render().catch((e) => log(String(e)));
```

- [ ] **Step 5: Write the CLI**

`app/cli.ts`:
```ts
import { loadConfig } from "./config.ts";
import { openStore } from "./store.ts";
import { makeChain } from "./chain.ts";
import { openRouter } from "./openrouter.ts";
import { toolGateway, x402PayingFetch, type PayingFetchFactory } from "./tools.ts";
import { syncAll, reportAll, settleVault, tick, toolBudgetFor, type KeeperDeps } from "./keeper.ts";
import { createApp } from "./server.ts";

const cfg = loadConfig();
const store = openStore(cfg.dbPath);
const chain = makeChain(cfg);
const or = openRouter(cfg.openRouterKey);
const keeper: KeeperDeps = { chain, store, or, params: cfg.params, log: (m) => console.log(new Date().toISOString(), m) };
const noWallet: PayingFetchFactory = () => { throw new Error("TOOL_WALLET_PRIVATE_KEY is not set"); };
const gateway = toolGateway({
  orthogonalKey: cfg.orthogonalKey,
  fetchFn: fetch,
  makePayingFetch: cfg.toolWalletKey ? x402PayingFetch(cfg.toolWalletKey) : noWallet,
  budgetUsd: (h) => toolBudgetFor(store, cfg.params, h),
  record: (h, api, path, usd) => store.recordToolCall(h, api, path, usd),
});

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case "serve": {
    const app = createApp({
      store, or, chain, gateway, params: cfg.params, adminToken: cfg.adminToken, keeper,
      publicConfig: { chainId: cfg.chainId, factory: cfg.factory, splitter: cfg.splitter, usdc: cfg.usdc, target: cfg.target },
    });
    app.listen(cfg.port, () => console.log(`Inferest on http://localhost:${cfg.port} (MCP at /mcp)`));
    setInterval(() => void tick(keeper).catch((e) => keeper.log(`tick failed: ${e.message}`)), 60_000);
    break;
  }
  case "sync": await syncAll(keeper); break;
  case "report": await reportAll(keeper); break;
  case "settle": console.log(await settleVault(keeper, String(arg))); break;
  default:
    console.log("usage: node app/cli.ts serve | sync | report | settle <vault>");
    process.exitCode = 1;
}
```

- [ ] **Step 6: Run tests and type check**

Run: `npm test && npm run typecheck`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add app
git commit -m "Add the HTTP server, CLI and dashboard"
```

---

### Task 13: Demos on a Tenderly Virtual TestNet

**Files:**
- Create: `demo/lib.ts`, `demo/treasury.ts`, `demo/agent.ts`

**Interfaces:**
- Consumes: deployed contracts (Task 5 script), running server (Task 12), env from `.env.example`.
- Produces: two runnable scripts: `node --env-file=.env demo/treasury.ts`, `node --env-file=.env demo/agent.ts`.

- [ ] **Step 1: Stand up the environment (manual)**

1. Claim the Tenderly Pro perk; create a Virtual TestNet forking **Arbitrum One**, chain id `42161`, and copy its Admin RPC into `.env` as `RPC_URL`.
2. Generate keeper, deployer, treasury and agent keys (`cast wallet new` four times); fund each with ETH via the Tenderly dashboard or `tenderly_setBalance`.
3. Deploy:
```bash
cd contracts
KEEPER=<keeper address> FLOAT_ADDRESS=<our float wallet> FEE_ADDRESS=<our fee wallet> \
EMERGENCY_ADMIN=<keeper address> TARGET_VAULT=0x5c0C306Aaa9F877de636f4d5822cA9F2E81563BA \
forge script script/Deploy.s.sol --rpc-url $RPC_URL --private-key <deployer key> --broadcast --slow
```
Expected: `contracts/deployments/42161.json` is written. Commit it (addresses on a test network are not secrets).
4. Fill the rest of `.env`; fund the tool wallet with about 2 USDC on Base mainnet; top up the OpenRouter account with a small float (for example $20).
5. Start the server: `node --env-file=.env app/cli.ts serve`

- [ ] **Step 2: Write the shared demo helpers**

`demo/lib.ts`:
```ts
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEventLogs, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
export const RPC = env("RPC_URL");
export const API = process.env.API_URL ?? "http://localhost:8787";
export const dep = JSON.parse(readFileSync(env("DEPLOYMENTS"), "utf8"));
export const chainCfg = JSON.parse(readFileSync(process.env.CHAIN_CONFIG ?? "config/arbitrum-one.json", "utf8"));
export const usd = (micro: bigint) => `$${(Number(micro) / 1e6).toFixed(2)}`;
export const step = (n: number, msg: string) => console.log(`\n${n}. ${msg}`);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j: any = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
export const warp = async (seconds: number) => { await rpc("evm_increaseTime", [toHex(seconds)]); await rpc("evm_mine", []); };
export const fundEth = (to: string, wei: bigint) => rpc("tenderly_setBalance", [[to], toHex(wei)]);
export const fundUsdc = (to: string, micro: bigint) => rpc("tenderly_setErc20Balance", [chainCfg.usdc, to, toHex(micro)]);

export async function api(path: string, body?: unknown): Promise<any> {
  const r = await fetch(API + path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json", "x-admin-token": env("ADMIN_TOKEN") }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${j.error ?? r.status}`);
  return j;
}

const chain = defineChain({ id: Number(dep.chainId), name: "fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
export const pub = createPublicClient({ chain, transport: http(RPC) });

const factoryAbi = parseAbi([
  "function createVault(address target, string name, string symbol) returns (address)",
  "event VaultCreated(address indexed customer, address indexed vault, address indexed target)",
]);
export const vaultAbi = parseAbi([
  "function acceptManagement()",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
]);
export const erc20Abi = parseAbi(["function approve(address, uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

/** A funded customer that creates its vault, accepts management and deposits. */
export async function customerWithVault(privateKey: Hex, depositMicro: bigint, label: string) {
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain, transport: http(RPC) });
  const send = async (address: Hex, abi: any, functionName: string, args: unknown[]) => {
    const hash = await wallet.writeContract({ address, abi, functionName, args } as any);
    return pub.waitForTransactionReceipt({ hash });
  };
  await fundEth(account.address, 10n ** 18n);
  await fundUsdc(account.address, depositMicro);
  const receipt = await send(dep.factory, factoryAbi, "createVault", [dep.target, `Inferest ${label}`, "infVAULT"]);
  const vault = (parseEventLogs({ abi: factoryAbi, logs: receipt.logs })[0] as any).args.vault as Hex;
  await send(vault, vaultAbi, "acceptManagement", []);
  await send(chainCfg.usdc, erc20Abi, "approve", [vault, depositMicro]);
  await send(vault, vaultAbi, "deposit", [depositMicro, account.address]);
  await api("/api/vaults", { vault, label });
  const value = async () => pub.readContract({ address: vault, abi: vaultAbi, functionName: "convertToAssets",
    args: [await pub.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [account.address] })] });
  const withdrawAll = async () => {
    const shares = await pub.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [account.address] });
    await send(vault, vaultAbi, "redeem", [shares, account.address, account.address]);
    return pub.readContract({ address: chainCfg.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  };
  return { account, vault, value, withdrawAll };
}

export async function chat(key: string, messages: unknown[], tools?: unknown[]): Promise<any> {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: process.env.DEMO_MODEL ?? "moonshotai/kimi-k2.6", messages, tools, usage: { include: true } }),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`chat: ${r.status} ${JSON.stringify(j)}`);
  return j;
}

export async function printState(vault: string) {
  const s = await api("/api/state");
  const v = s.vaults.find((x: any) => x.vault === vault.toLowerCase());
  console.log(`   yield in Splitter $${v.yieldUsd.toFixed(2)}${v.frozen ? " (frozen)" : ""}`);
  for (const k of v.keys) console.log(`   ${k.name.padEnd(8)} budget $${k.budget.toFixed(2)}  spent $${k.spent.toFixed(4)}  tools $${k.toolSpent.toFixed(4)}  left $${k.remaining.toFixed(2)}`);
}
```

- [ ] **Step 3: Write the treasury demo**

`demo/treasury.ts`:
```ts
import { api, customerWithVault, chat, env, printState, sleep, step, usd, warp } from "./lib.ts";

const HALF_YEAR = Math.round(182.5 * 86_400);

step(1, "Finance lead deposits 100,000 USDC. The vault shares stay in their wallet.");
const c = await customerWithVault(env("DEMO_TREASURY_KEY") as `0x${string}`, 100_000_000_000n, "Treasury");
console.log(`   vault ${c.vault}, principal ${usd(await c.value())}`);

step(2, "Admin creates three developer keys at equal weight.");
const keys: { name: string; key: string }[] = [];
for (const name of ["dev-1", "dev-2", "dev-3"]) keys.push({ name, ...(await api("/api/keys", { vault: c.vault, name, weight: 1 })) });

step(3, "Six months pass. The keeper reports; limits open from the yield.");
await warp(HALF_YEAR);
await api("/api/admin/report", {});
await api("/api/admin/sync", {});
await printState(c.vault);

step(4, "Developers call real models on their own keys.");
for (const k of keys) {
  const r = await chat(k.key, [{ role: "user", content: "In one sentence, why do treasuries hold stablecoins?" }]);
  console.log(`   ${k.name}: ${r.choices[0].message.content.trim().slice(0, 90)}  (cost $${r.usage?.cost ?? "?"})`);
}
await sleep(5_000); // OpenRouter usage lands within a few seconds
await api("/api/admin/sync", {});
await printState(c.vault);

step(5, "Month end: settle. Usage to the float, 10% of the leftover to us, the rest back to the customer.");
console.log(`   ${JSON.stringify(await api("/api/admin/settle", { vault: c.vault }))}`);
console.log(`   principal now ${usd(await c.value())}, still in the customer's wallet`);

step(6, "Withdraw everything, straight from the wallet. No request, no wait.");
console.log(`   USDC balance ${usd(await c.withdrawAll())}`);
```

- [ ] **Step 4: Write the agent demo**

`demo/agent.ts`:
```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { API, api, customerWithVault, chat, env, printState, sleep, step, usd, warp } from "./lib.ts";

const TASK = "Find what Octant's Yield Donating Strategy is and summarize it in three sentences. Use a paid web search or scraping tool.";

step(1, "An agent's own wallet deposits 20,000 USDC into its own vault.");
const a = await customerWithVault(env("DEMO_AGENT_KEY") as `0x${string}`, 20_000_000_000n, "Agent");
const { key } = await api("/api/keys", { vault: a.vault, name: "agent", weight: 1 });

step(2, "Time passes; the agent's limit rises from its own yield.");
await warp(Math.round(182.5 * 86_400));
await api("/api/admin/report", {});
await api("/api/admin/sync", {});
await printState(a.vault);

step(3, "The agent works: a model for thinking, paid tools through the Inferest MCP server.");
const mcp = new Client({ name: "inferest-demo-agent", version: "0.1.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(`${API}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
const { tools } = await mcp.listTools();
const fnTools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema } }));
const messages: any[] = [
  { role: "system", content: "You are a research agent. Use search_tools to find a web search or scraping tool, read its parameters with tool_details, call it once with run_tool, then answer." },
  { role: "user", content: TASK },
];
for (let turn = 0; turn < 6; turn++) {
  const msg = (await chat(key, messages, fnTools)).choices[0].message;
  messages.push(msg);
  if (!msg.tool_calls?.length) { console.log(`\n   ${String(msg.content).trim()}\n`); break; }
  for (const call of msg.tool_calls) {
    console.log(`   tool: ${call.function.name} ${call.function.arguments.slice(0, 80)}`);
    const out: any = await mcp.callTool({ name: call.function.name, arguments: JSON.parse(call.function.arguments || "{}") });
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out.content).slice(0, 6_000) });
  }
}
await mcp.close();
await sleep(5_000);
await api("/api/admin/sync", {});
await printState(a.vault);

step(4, "Settle: leftover goes back into the agent's vault. No human topped anything up.");
console.log(`   ${JSON.stringify(await api("/api/admin/settle", { vault: a.vault }))}`);
console.log(`   agent principal now ${usd(await a.value())}`);
```

- [ ] **Step 5: Type check**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Run both demos end to end**

```bash
node --env-file=.env demo/treasury.ts
node --env-file=.env demo/agent.ts
```
Expected, treasury: step 3 shows yield near $2,200 (the vault's live APY decides the exact figure) and three equal budgets; step 4 prints three model answers with small costs; step 5 prints a settlement with `usageMicro` equal to the summed costs and a tx hash; step 6 prints a USDC balance above 100,000.
Expected, agent: step 3 prints at least one `tool: run_tool` line and a final summary; the state after it shows non-zero `tools` spend on the agent key; step 4 prints a settlement.
If step 3 of either shows zero yield, the fork's Morpho vault did not accrue: call `report` twice with a block mined between, or switch `TARGET_VAULT` to another allowlisted USDC ERC-4626 vault on the same chain.

- [ ] **Step 7: Commit**

```bash
git add demo contracts/deployments/42161.json
git commit -m "Add the treasury and agent demo scripts"
```

---

### Task 14: Docs catch up with the build

**Files:**
- Modify: `docs/06-workflow.md` (section "3. Report and sync"), `README.md` ("Start here", "Layout"), `hackathon/PLAN.md` ("Tasks")

**Interfaces:** none.

- [ ] **Step 1: Correct the limit formula in `docs/06-workflow.md`**

Replace the code block under "### 3. Report and sync" with:
```
credit_i  = yieldInSplitter × (1 − railFee) × weight_i / Σ weights
spent_i   = (usage_i − usageAtPeriodStart_i) + toolSpend_i × (1 − railFee)
limit_i   = usage_i + max(credit_i − spent_i, 0)        (OpenRouter limits are cumulative)
```
and replace the sentence after it with: "A key's credit is fixed by its weight, so what one key leaves unused does not flow to the others (decision 3). Limits rise in a step after each report. Between syncs a key can overshoot by at most one minute of spend; we absorb that. If the yield source is worth less than the vault last reported, every key is frozen at its current usage until the next report."

- [ ] **Step 2: Update the README**

In "Start here", replace the `npm test` block with:
```bash
npm install
npm test                                  # ledger kernel + app, no network
cd contracts && forge test                # Splitter, factory, lifecycle
cp .env.example .env                      # then fill it in
node --env-file=.env app/cli.ts serve     # dashboard, API, MCP at /mcp
node --env-file=.env demo/treasury.ts     # or demo/agent.ts
```
In "Layout", replace the tree with:
```
engine/       ledger kernel + tests (source of truth for the math)
contracts/    Splitter, VaultFactory (Octant YDS per customer), tests, deploy script
app/          keeper, OpenRouter keys, Orthogonal tools over MCP, HTTP API, dashboard
demo/         treasury and agent scripts for a forked chain
config/       per-chain addresses
docs/         problem, landscape, architecture, economics, risks, workflow, plans
sources/      original Korean notes, unedited
```

- [ ] **Step 3: Point the build plan at this plan**

In `hackathon/PLAN.md`, replace the whole "## Tasks" section with:
```
## Tasks

The build is tracked task by task in [`../docs/superpowers/plans/2026-09-25-general-build.md`](../docs/superpowers/plans/2026-09-25-general-build.md).
```

- [ ] **Step 4: Check prose rules and commit**

Run: `grep -rn "—" README.md docs hackathon deck || echo ok`
Expected: `ok`.
```bash
git add README.md docs hackathon
git commit -m "Bring the docs in line with the build"
```
