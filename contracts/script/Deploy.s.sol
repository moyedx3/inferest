// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.25;

import { Script, console2 } from "forge-std/Script.sol";
import { YieldDonatingTokenizedStrategy } from "octant/strategies/yieldDonating/YieldDonatingTokenizedStrategy.sol";
import { Splitter } from "../src/Splitter.sol";
import { VaultFactory } from "../src/VaultFactory.sol";

/// forge script script/Deploy.s.sol --rpc-url $RPC_URL --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow
contract Deploy is Script {
    function run() external {
        address keeper = vm.envAddress("KEEPER");
        address floatAddress = vm.envAddress("FLOAT_ADDRESS");
        address feeAddress = vm.envAddress("FEE_ADDRESS");
        address emergencyAdmin = vm.envAddress("EMERGENCY_ADMIN");
        address target = vm.envAddress("TARGET_VAULT");
        uint16 feeBps = uint16(vm.envOr("FEE_BPS", uint256(1_000)));

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        YieldDonatingTokenizedStrategy impl = new YieldDonatingTokenizedStrategy();
        address predicted = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        Splitter splitter = new Splitter(predicted, keeper, floatAddress, feeAddress, feeBps);
        VaultFactory factory = new VaultFactory(deployer, address(splitter), address(impl), keeper, emergencyAdmin);
        require(address(factory) == predicted, "factory address mismatch");
        factory.setAllowedTarget(target, true);
        vm.stopBroadcast();

        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "implementation", address(impl));
        vm.serializeAddress(o, "splitter", address(splitter));
        vm.serializeAddress(o, "factory", address(factory));
        string memory json = vm.serializeAddress(o, "target", target);
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("wrote", path);
    }
}
