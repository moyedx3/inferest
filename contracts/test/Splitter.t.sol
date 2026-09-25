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
        new Splitter(address(factory), keeper, address(0), feeAddr, FEE_BPS);
    }

    function test_constructor_rejectsFeeAboveCap() public {
        vm.expectRevert(abi.encodeWithSelector(Splitter.FeeTooHigh.selector, uint16(2_001)));
        new Splitter(address(factory), keeper, floatAddr, feeAddr, 2_001);
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
