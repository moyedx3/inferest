import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, http, keccak256, pad, parseAbi, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** What a demo wallet gets: one unit of the native currency and 100,000 USDC. */
export const FAUCET_NATIVE = 10n ** 18n;
export const FAUCET_USDC = 100_000_000_000n;

export type Faucet = {
  fund(address: string): Promise<{ native: bigint; usdc: bigint }>;
  /** Moves the demo clock forward by `seconds`: the chain's own clock on a fork, the demo yield sources' clocks on a
   *  live testnet. Returns the transaction hashes the node reported. */
  warp?(seconds: bigint): Promise<string[]>;
  /** True when warp moves a fork's own clock at no cost; the server then lets any signed-in visitor call it. A live
   *  testnet's warp spends the faucet signer's gas, so it stays with the operator. */
  forkClock?: boolean;
};

/** The faucet signer cannot cover a fund. The route answers 503 with this message instead of a stack trace. */
export class FaucetDry extends Error {}

/** The most one warp may move a demo clock: DemoYieldVault.MAX_WARP, ten years. */
export const MAX_WARP_SECONDS = 10n * 365n * 86_400n;

/**
 * Funds a wallet on a forked chain through the node's cheat methods, trying Tenderly's names first and anvil's
 * after. Native USDC (FiatToken v2.2) defeats anvil's slot search, so the last resort writes the balance mapping
 * at slot 9 directly, and moves the fork's clock with evm_increaseTime. Useless on a real chain by construction:
 * every method is refused there.
 */
export function createFaucet(d: { rpcUrl: string; usdc: string; fetchFn?: typeof fetch; rpcTimeoutMs?: number }): Faucet {
  const fetchFn = d.fetchFn ?? fetch;
  const timeout = d.rpcTimeoutMs ?? 30_000;

  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    const r = await fetchFn(d.rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeout) });
    const j: any = await r.json();
    if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { code: j.error.code });
    return j.result;
  }

  /** Tries each call in turn, moving on when the node does not know the method or takes it under another shape. */
  async function cheat(calls: [string, unknown[]][]): Promise<void> {
    for (const [i, [method, params]] of calls.entries()) {
      try {
        await rpc(method, params);
        return;
      } catch (e: any) {
        const unknown = e.code === -32601 || e.code === -32602 || /not found|not supported|does not exist|no slot found/i.test(e.message);
        if (!unknown || i === calls.length - 1) throw e;
      }
    }
  }

  return {
    forkClock: true,
    async fund(address) {
      const to = address as Hex;
      await cheat([["tenderly_setBalance", [[to], toHex(FAUCET_NATIVE)]], ["anvil_setBalance", [to, toHex(FAUCET_NATIVE)]]]);
      await cheat([
        ["tenderly_setErc20Balance", [d.usdc, to, toHex(FAUCET_USDC)]],
        ["anvil_dealERC20", [d.usdc, to, toHex(FAUCET_USDC)]],
        ["anvil_setERC20Balance", [d.usdc, to, toHex(FAUCET_USDC)]],
        ["anvil_setStorageAt", [d.usdc, keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [to, 9n])), pad(toHex(FAUCET_USDC))]],
      ]);
      return { native: FAUCET_NATIVE, usdc: FAUCET_USDC };
    },
    async warp(seconds) {
      const results = [await rpc("evm_increaseTime", [toHex(seconds)]), await rpc("evm_mine", [])];
      return results.filter((r): r is string => typeof r === "string" && /^0x[0-9a-f]{64}$/i.test(r));
    },
  };
}

const testUsdcAbi = parseAbi(["function mint(address to, uint256 amount)", "function balanceOf(address) view returns (uint256)"]);
const demoVaultAbi = parseAbi(["function warp(uint256 by)"]);

/**
 * Funds a wallet on a live testnet that carries the demo contracts: tops it up to FAUCET_USDC of test USDC and to
 * `nativeWei` of gas from the faucet signer, minting and sending only what is missing. The same signer owns every demo yield source and moves
 * their clocks on warp(). It is never the keeper, so a faucet transaction from a public route cannot take a
 * nonce the keeper is about to use.
 */
export function createMintFaucet(d: {
  rpcUrl: string; chainId: number; chainName: string; nativeCurrency: { name: string; symbol: string; decimals: number };
  usdc: Hex; signerKey: Hex; nativeWei: bigint; warpTargets: Hex[];
}): Faucet {
  const chain = defineChain({
    id: d.chainId, name: d.chainName, nativeCurrency: d.nativeCurrency, rpcUrls: { default: { http: [d.rpcUrl] } },
  });
  const account = privateKeyToAccount(d.signerKey);
  const pub = createPublicClient({ chain, transport: http(d.rpcUrl), pollingInterval: 1_000 });
  const wallet = createWalletClient({ chain, account, transport: http(d.rpcUrl) });
  const mined = async (hash: Hex): Promise<string> => {
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`faucet transaction reverted: ${hash}`);
    return hash;
  };
  // one signer, one nonce sequence: overlapping route calls queue behind each other instead of racing for a nonce
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };
  return {
    fund: (address) => serial(async () => {
      const to = address as Hex;
      // a top-up, like the fork's cheat faucet: a wallet already at the gift gets nothing, so a second click costs nothing
      const [heldUsdc, heldNative] = await Promise.all([
        pub.readContract({ address: d.usdc, abi: testUsdcAbi, functionName: "balanceOf", args: [to] }),
        pub.getBalance({ address: to }),
      ]);
      const usdc = heldUsdc < FAUCET_USDC ? FAUCET_USDC - heldUsdc : 0n;
      const native = heldNative < d.nativeWei ? d.nativeWei - heldNative : 0n;
      if (usdc === 0n && native === 0n) return { native, usdc };
      const balance = await pub.getBalance({ address: account.address });
      if (balance < d.nativeWei * 2n) {
        throw new FaucetDry(`the faucet signer ${account.address} holds too little ${d.nativeCurrency.symbol} to fund a wallet`);
      }
      if (usdc > 0n) await mined(await wallet.writeContract({ address: d.usdc, abi: testUsdcAbi, functionName: "mint", args: [to, usdc] }));
      if (native > 0n) await mined(await wallet.sendTransaction({ to, value: native }));
      return { native, usdc };
    }),
    warp: (seconds) => serial(async () => {
      if (!(seconds > 0n && seconds <= MAX_WARP_SECONDS)) throw new Error("warp must be between one second and ten years");
      const txs: string[] = [];
      for (const target of d.warpTargets) {
        txs.push(await mined(await wallet.writeContract({ address: target, abi: demoVaultAbi, functionName: "warp", args: [seconds] })));
      }
      return txs;
    }),
  };
}
