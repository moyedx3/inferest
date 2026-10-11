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
        uint256 overCap = usdc.MAX_MINT() + 1; // read before expectRevert, which would otherwise catch this view call
        vm.expectRevert(abi.encodeWithSelector(TestUSDC.MintTooLarge.selector, overCap));
        usdc.mint(alice, overCap);
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
        uint256 shares = vault.balanceOf(alice); // read before prank, which would otherwise apply to this view call
        vm.prank(alice);
        uint256 got = vault.redeem(shares, alice, alice);
        assertApproxEqAbs(got, PRINCIPAL + 2_250e6, 1);
        assertEq(usdc.balanceOf(alice), got);
        assertApproxEqAbs(usdc.totalSupply() - supplyBefore, 2_250e6, 1); // only the yield was minted
        assertLe(vault.totalAssets(), 1); // ERC-4626 rounds the last redeem down by at most one unit
    }

    function test_shortfallAboveTheMintCapIsPaidInChunks() public {
        // twenty deposits of the cap make 20,000,000; ten years at 4.5% owes 9,000,000, nine times MAX_MINT
        for (uint256 i = 0; i < 20; i++) _deposit(alice, usdc.MAX_MINT());
        uint256 maxWarp = vault.MAX_WARP();
        uint256 shares = vault.balanceOf(alice);
        vm.prank(faucet);
        vault.warp(maxWarp);
        vm.prank(alice);
        uint256 got = vault.redeem(shares, alice, alice);
        assertApproxEqAbs(got, 29_000_000e6, 1);
        assertEq(usdc.balanceOf(alice), got);
    }

    function test_onlyTheOwnerWarpsAndNotPastTheCap() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        vault.warp(1);
        uint256 overWarp = vault.MAX_WARP() + 1; // read before expectRevert, which would otherwise catch this view call
        vm.expectRevert(abi.encodeWithSelector(DemoYieldVault.WarpTooLong.selector, overWarp));
        vm.prank(faucet);
        vault.warp(overWarp);
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
