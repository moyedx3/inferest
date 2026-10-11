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
