// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.25;

import { Test } from "forge-std/Test.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import { ERC4626Mock } from "@openzeppelin/contracts/mocks/token/ERC4626Mock.sol";
import { YieldDonatingTokenizedStrategy } from "octant/strategies/yieldDonating/YieldDonatingTokenizedStrategy.sol";
import { ITokenizedStrategy } from "octant/core/interfaces/ITokenizedStrategy.sol";
import { Splitter } from "../src/Splitter.sol";
import { VaultFactory } from "../src/VaultFactory.sol";

abstract contract BaseTest is Test {
    uint16 internal constant FEE_BPS = 1_000;
    uint256 internal constant MIN_LIQUIDITY = 1_000; // Octant seeds 1,000 shares to 0xdead on the first deposit

    ERC20Mock internal usdc;
    ERC4626Mock internal target;
    YieldDonatingTokenizedStrategy internal impl;
    VaultFactory internal factory;
    Splitter internal splitter;

    address internal keeper = makeAddr("keeper");
    address internal floatAddr = makeAddr("float");
    address internal feeAddr = makeAddr("fee");
    address internal emergency = makeAddr("emergency");
    address internal customer = makeAddr("customer");
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

    /// Deploys a customer vault donating to the Splitter and deposits `amount` for `who`.
    function _openVault(address who, uint256 amount) internal virtual returns (ITokenizedStrategy vault) {
        vm.startPrank(who);
        vault = ITokenizedStrategy(factory.createVault(address(target), "Inferest Test", "infTEST"));
        vault.acceptManagement();
        vm.stopPrank();
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
