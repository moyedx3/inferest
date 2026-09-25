// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.25;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ERC4626Mock } from "@openzeppelin/contracts/mocks/token/ERC4626Mock.sol";
import { ITokenizedStrategy } from "octant/core/interfaces/ITokenizedStrategy.sol";
import { ERC4626Strategy } from "octant/strategies/yieldDonating/ERC4626Strategy.sol";
import { VaultFactory } from "../src/VaultFactory.sol";
import { BaseTest } from "./Base.t.sol";

contract VaultFactoryTest is BaseTest {
    function test_createVault_revertsForTargetNotAllowed() public {
        ERC4626Mock rogue = new ERC4626Mock(address(usdc));
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(VaultFactory.TargetNotAllowed.selector, address(rogue)));
        factory.createVault(address(rogue), "x", "x");
    }

    function test_setAllowedTarget_onlyOwner() public {
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, customer));
        factory.setAllowedTarget(address(0x1234), true);
    }

    function test_createVault_wiresVaultToSplitterKeeperAndCustomer() public {
        vm.prank(customer);
        address vault = factory.createVault(address(target), "Inferest Test", "infTEST");
        ITokenizedStrategy v = ITokenizedStrategy(vault);

        assertEq(factory.customerOf(vault), customer);
        assertEq(factory.vaultsOf(customer)[0], vault);
        assertEq(v.dragonRouter(), address(splitter));
        assertEq(v.keeper(), keeper);
        assertEq(v.management(), address(factory));
        assertEq(v.pendingManagement(), customer);
        assertEq(ERC4626Strategy(vault).lossLimitRatio(), factory.LOSS_LIMIT_BPS());
        assertEq(ERC4626Strategy(vault).targetVault(), address(target));
    }

    function test_createVault_customerBecomesManagementAfterAccepting() public {
        vm.startPrank(customer);
        ITokenizedStrategy v = ITokenizedStrategy(factory.createVault(address(target), "a", "a"));
        v.acceptManagement();
        vm.stopPrank();
        assertEq(v.management(), customer);
    }

    function test_createVault_emitsVaultCreated() public {
        vm.expectEmit(true, false, true, false, address(factory));
        emit VaultFactory.VaultCreated(customer, address(0), address(target));
        vm.prank(customer);
        factory.createVault(address(target), "a", "a");
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(VaultFactory.ZeroAddress.selector);
        new VaultFactory(owner, address(0), address(impl), keeper, emergency);
    }
}
