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
