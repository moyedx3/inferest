import { createPublicClient, defineChain, http, parseAbi, type Hex } from "viem";
import type { AgentLog } from "./log.ts";

export type Book = {
  walletUsdc: bigint; vault: Hex | null; vaultShares: bigint; vaultValue: bigint; target: string | null;
  samples: { target: string; sharePrice: bigint; at: number }[]; clockAt: number;
};
export const erc4626Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function targetVault() view returns (address)",
]);
export const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export function publicClient(rpcUrl: string, chainId: number) {
  const chain = defineChain({ id: chainId, name: "inferest", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  return createPublicClient({ chain, transport: http(rpcUrl) });
}

/** What the agent reads before it thinks: its wallet, its vault, and a share-price sample of every allowlisted source. */
export async function readBook(d: { pub: ReturnType<typeof publicClient>; address: Hex; usdc: Hex; vault: Hex | null; targets: Hex[]; log: AgentLog }): Promise<Book> {
  const block = await d.pub.getBlock();
  const clockAt = Number(block.timestamp);
  const walletUsdc = await d.pub.readContract({ address: d.usdc, abi: erc20Abi, functionName: "balanceOf", args: [d.address] });
  let vaultShares = 0n, vaultValue = 0n, target: string | null = null;
  if (d.vault) {
    vaultShares = await d.pub.readContract({ address: d.vault, abi: erc4626Abi, functionName: "balanceOf", args: [d.address] });
    vaultValue = await d.pub.readContract({ address: d.vault, abi: erc4626Abi, functionName: "convertToAssets", args: [vaultShares] });
    target = (await d.pub.readContract({ address: d.vault, abi: erc4626Abi, functionName: "targetVault" })).toLowerCase();
  }
  const samples = [];
  for (const t of d.targets) {
    const sharePrice = await d.pub.readContract({ address: t, abi: erc4626Abi, functionName: "convertToAssets", args: [1_000_000n] });
    d.log.addSample(t, sharePrice, clockAt);
    samples.push({ target: t.toLowerCase(), sharePrice, at: clockAt });
  }
  return { walletUsdc, vault: d.vault, vaultShares, vaultValue, target, samples, clockAt };
}
export const usd = (micro: bigint): number => Number(micro) / 1e6;
