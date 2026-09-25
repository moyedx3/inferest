// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @notice The only thing the Splitter needs to know about a vault: whose it is.
interface IVaultRegistry {
    function customerOf(address vault) external view returns (address);
}
