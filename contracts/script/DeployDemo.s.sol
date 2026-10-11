// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.25;

import { Script, console2 } from "forge-std/Script.sol";
import { TestUSDC } from "../src/demo/TestUSDC.sol";
import { DemoYieldVault } from "../src/demo/DemoYieldVault.sol";

/// forge script script/DeployDemo.s.sol --rpc-url $RPC_URL --private-key $DEPLOYER_PRIVATE_KEY --broadcast --slow
/// Deploys the test asset and the demo yield source for a testnet that has no USDC yield source. DEMO_OWNER (the
/// faucet signer, never the keeper) is the only address that can warp the vault's clock. DEMO_RATE_BPS defaults to
/// 450, which is 4.5% a year. Writes deployments/<chainId>-demo.json; Deploy.s.sol then takes its `target` as
/// TARGET_VAULT. Never for a chain where real money is.
contract DeployDemo is Script {
    function run() external {
        address owner = vm.envAddress("DEMO_OWNER");
        uint256 rateBps = vm.envOr("DEMO_RATE_BPS", uint256(450));

        vm.startBroadcast();
        TestUSDC usdc = new TestUSDC();
        DemoYieldVault vault = new DemoYieldVault(usdc, rateBps, owner);
        vm.stopBroadcast();

        string memory o = "demo";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "usdc", address(usdc));
        vm.serializeAddress(o, "target", address(vault));
        string memory json = vm.serializeUint(o, "rateBps", rateBps);
        string memory path = string.concat("deployments/", vm.toString(block.chainid), "-demo.json");
        vm.writeJson(json, path);
        console2.log("wrote", path);
    }
}
