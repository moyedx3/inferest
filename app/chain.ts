import {
  createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, keccak256, parseAbi,
  TransactionNotFoundError, TransactionReceiptNotFoundError,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "./config.ts";

export type TxStatus = "success" | "reverted" | "pending";

/** A settle transaction signed locally: its hash is known before anything is broadcast. */
export type PreparedSettle = { hash: string; send: () => Promise<void> };

export interface Chain {
  yieldOf(vault: string): Promise<bigint>;
  /** True when the yield source is worth less than the vault last reported: limits must freeze. */
  lossPending(vault: string): Promise<boolean>;
  report(vault: string): Promise<string>;
  /** The strategy's totalAssets(), in base units of the underlying asset. */
  totalAssets(vault: string): Promise<bigint>;
  /** Sends settle and waits for the receipt: sendSettle followed by a wait. Throws if it reverts. */
  settle(vault: string, usageMicro: bigint): Promise<string>;
  /** Simulates, prepares and signs settle without broadcasting; send() broadcasts the signed transaction. */
  prepareSettle(vault: string, usageMicro: bigint): Promise<PreparedSettle>;
  /** prepareSettle then send, returning the hash without waiting for the receipt. */
  sendSettle(vault: string, usageMicro: bigint): Promise<string>;
  /** The receipt status of a sent transaction; "pending" while no receipt exists. */
  settleStatus(tx: string): Promise<TxStatus>;
  /** Whether the node knows the transaction at all (mined or in its mempool). */
  transactionKnown(tx: string): Promise<boolean>;
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

  async function send(address: Hex, abi: any, functionName: string, args: unknown[]): Promise<Hex> {
    const { request } = await pub.simulateContract({ account, address, abi, functionName, args } as any);
    return wallet.writeContract(request as any);
  }

  async function write(address: Hex, abi: any, functionName: string, args: unknown[]): Promise<string> {
    const hash = await send(address, abi, functionName, args);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
    return hash;
  }

  async function prepareSettle(vault: string, usageMicro: bigint): Promise<PreparedSettle> {
    const args = [vault as Hex, usageMicro] as const;
    await pub.simulateContract({ account, address: cfg.splitter, abi: splitterAbi, functionName: "settle", args });
    const data = encodeFunctionData({ abi: splitterAbi, functionName: "settle", args });
    const request = await wallet.prepareTransactionRequest({ account, chain, to: cfg.splitter, data });
    const serializedTransaction = await wallet.signTransaction(request as any);
    return {
      hash: keccak256(serializedTransaction),
      async send() {
        await wallet.sendRawTransaction({ serializedTransaction });
      },
    };
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
    totalAssets: (vault) =>
      pub.readContract({ address: vault as Hex, abi: strategyAbi, functionName: "totalAssets" }),
    settle: (vault, usageMicro) => write(cfg.splitter, splitterAbi, "settle", [vault, usageMicro]),
    prepareSettle,
    async sendSettle(vault, usageMicro) {
      const prepared = await prepareSettle(vault, usageMicro);
      await prepared.send();
      return prepared.hash;
    },
    async settleStatus(tx) {
      try {
        const receipt = await pub.getTransactionReceipt({ hash: tx as Hex });
        return receipt.status === "success" ? "success" : "reverted";
      } catch (e) {
        if (e instanceof TransactionReceiptNotFoundError) return "pending";
        throw e;
      }
    },
    async transactionKnown(tx) {
      try {
        await pub.getTransaction({ hash: tx as Hex });
        return true;
      } catch (e) {
        if (e instanceof TransactionNotFoundError) return false;
        throw e;
      }
    },
    customerOf: (vault) =>
      pub.readContract({ address: cfg.factory, abi: factoryAbi, functionName: "customerOf", args: [vault as Hex] }),
  };
}
