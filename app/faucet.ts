import { encodeAbiParameters, keccak256, pad, toHex, type Hex } from "viem";

/** What a demo wallet gets: one unit of the native currency and 100,000 USDC. */
export const FAUCET_NATIVE = 10n ** 18n;
export const FAUCET_USDC = 100_000_000_000n;

export type Faucet = { fund(address: string): Promise<{ native: bigint; usdc: bigint }> };

/**
 * Funds a wallet on a forked chain through the node's cheat methods, trying Tenderly's names first and anvil's
 * after. Native USDC (FiatToken v2.2) defeats anvil's slot search, so the last resort writes the balance mapping
 * at slot 9 directly. Useless on a real chain by construction: every method is refused there.
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
  };
}
