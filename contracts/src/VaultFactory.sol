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
