// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.25;

import { Test } from "forge-std/Test.sol";
import { ERC20Mock } from "@openzeppelin/contracts/mocks/token/ERC20Mock.sol";
import { ERC4626Mock } from "@openzeppelin/contracts/mocks/token/ERC4626Mock.sol";
import { YieldDonatingTokenizedStrategy } from "octant/strategies/yieldDonating/YieldDonatingTokenizedStrategy.sol";
import { ERC4626Strategy } from "octant/strategies/yieldDonating/ERC4626Strategy.sol";

contract SmokeTest is Test {
    function test_octantStrategyDeploys() public {
        ERC20Mock usdc = new ERC20Mock();
        ERC4626Mock target = new ERC4626Mock(address(usdc));
        YieldDonatingTokenizedStrategy impl = new YieldDonatingTokenizedStrategy();
        ERC4626Strategy s = new ERC4626Strategy(
            address(target), address(usdc), "Smoke", "SMK",
            address(this), address(this), address(this), address(0xD0), true, address(impl)
        );
        assertEq(s.targetVault(), address(target));
    }
}
