import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "./config.ts";

export interface Chain {
  yieldOf(vault: string): Promise<bigint>;
  /** True when the yield source is worth less than the vault last reported: limits must freeze. */
  lossPending(vault: string): Promise<boolean>;
  report(vault: string): Promise<string>;
  settle(vault: string, usageMicro: bigint): Promise<string>;
  customerOf(vault: string): Promise<string>;
}

const splitterAbi = parseAbi([
  "function yieldOf(address vault) view returns (uint256)",
  "function settle(address vault, uint256 usage) returns (uint256 paid, uint256 fee, uint256 returnedShares)",
]);
const strategyAbi = parseAbi([
  "function report() returns (uint256 profit, uint256 loss)",
  "function totalAssets() view returns (uint256)",
  "function targetVault() view returns (address)",
]);
const erc4626Abi = parseAbi([
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);
const factoryAbi = parseAbi(["function customerOf(address vault) view returns (address)"]);

type Hex = `0x${string}`;

export function makeChain(cfg: Config): Chain {
  const chain = defineChain({
    id: cfg.chainId, name: "inferest", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  const account = privateKeyToAccount(cfg.keeperKey);
  const wallet = createWalletClient({ chain, account, transport: http(cfg.rpcUrl) });

  async function write(address: Hex, abi: any, functionName: string, args: unknown[]): Promise<string> {
    const { request } = await pub.simulateContract({ account, address, abi, functionName, args } as any);
    const hash = await wallet.writeContract(request as any);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
    return hash;
  }

  return {
    yieldOf: (vault) =>
      pub.readContract({ address: cfg.splitter, abi: splitterAbi, functionName: "yieldOf", args: [vault as Hex] }),
    async lossPending(vault) {
      const v = vault as Hex;
      const [stored, target] = await Promise.all([
        pub.readContract({ address: v, abi: strategyAbi, functionName: "totalAssets" }),
        pub.readContract({ address: v, abi: strategyAbi, functionName: "targetVault" }),
      ]);
      const shares = await pub.readContract({ address: target, abi: erc4626Abi, functionName: "balanceOf", args: [v] });
      const [live, idle] = await Promise.all([
        pub.readContract({ address: target, abi: erc4626Abi, functionName: "previewRedeem", args: [shares] }),
        pub.readContract({ address: cfg.usdc, abi: erc4626Abi, functionName: "balanceOf", args: [v] }),
      ]);
      return live + idle < stored;
    },
    report: (vault) => write(vault as Hex, strategyAbi, "report", []),
    settle: (vault, usageMicro) => write(cfg.splitter, splitterAbi, "settle", [vault, usageMicro]),
    customerOf: (vault) =>
      pub.readContract({ address: cfg.factory, abi: factoryAbi, functionName: "customerOf", args: [vault as Hex] }),
  };
}
