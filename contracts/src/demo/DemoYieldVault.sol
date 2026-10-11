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
