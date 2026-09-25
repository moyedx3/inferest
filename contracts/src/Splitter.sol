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
    /// @dev Reverts while the target vault cannot cover `paid` (Octant's withdraw is called with zero max loss); the keeper retries later.
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
