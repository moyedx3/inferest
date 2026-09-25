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
        uint256 y = splitter.yieldOf(address(vault));
        assertGt(y, 0);

        vm.prank(keeper);
        splitter.settle(address(vault), 0);
        vm.startPrank(customer);
        uint256 got = vault.redeem(vault.balanceOf(customer), customer, customer);
        vm.stopPrank();
        assertGt(got, 100_000e6 - 1_000 + y / 2, "customer did not get principal plus returned yield");
    }
}
