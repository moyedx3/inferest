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

        // TARGET_VAULTS is an optional comma-separated allowlist of extra yield sources beyond TARGET_VAULT
        // (spaces around each address are trimmed); TARGET_VAULT is always targets[0] and always allowlisted,
        // whether or not it is repeated in TARGET_VAULTS.
        string memory targetVaultsRaw = vm.envOr("TARGET_VAULTS", string(""));
        address[] memory targets;
        if (bytes(targetVaultsRaw).length == 0) {
            targets = new address[](1);
            targets[0] = target;
        } else {
            string[] memory parts = vm.split(targetVaultsRaw, ",");
            address[] memory extra = new address[](parts.length);
            uint256 extraCount = 0;
            for (uint256 i = 0; i < parts.length; i++) {
                address parsed = vm.parseAddress(vm.trim(parts[i]));
                if (parsed == target) continue;
                bool duplicate = false;
                for (uint256 j = 0; j < extraCount; j++) {
                    if (extra[j] == parsed) { duplicate = true; break; }
                }
                if (!duplicate) { extra[extraCount] = parsed; extraCount++; }
            }
            targets = new address[](extraCount + 1);
            targets[0] = target;
            for (uint256 i = 0; i < extraCount; i++) targets[i + 1] = extra[i];
        }

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        YieldDonatingTokenizedStrategy impl = new YieldDonatingTokenizedStrategy();
        address predicted = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        Splitter splitter = new Splitter(predicted, keeper, floatAddress, feeAddress, feeBps);
        VaultFactory factory = new VaultFactory(deployer, address(splitter), address(impl), keeper, emergencyAdmin);
        require(address(factory) == predicted, "factory address mismatch");
        for (uint256 i = 0; i < targets.length; i++) {
            factory.setAllowedTarget(targets[i], true);
        }
        vm.stopBroadcast();

        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "implementation", address(impl));
        vm.serializeAddress(o, "splitter", address(splitter));
        vm.serializeAddress(o, "factory", address(factory));
        vm.serializeAddress(o, "target", target);
        string memory json = vm.serializeAddress(o, "targets", targets);
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("wrote", path);
    }
}
