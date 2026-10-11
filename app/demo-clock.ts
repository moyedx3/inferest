import { toHex } from "viem";

/** A node that does not implement a method: anvil's and Tenderly's wording, Monad's, and the JSON-RPC code. */
function unknownMethod(e: unknown): boolean {
  const err = e as { code?: number; message?: string };
  return err.code === -32601 || /method not found|not supported|does not exist|not available/i.test(err.message ?? "");
}

/**
 * Moves the demo clock forward by `seconds`: the chain's own clock on a fork (evm_increaseTime, then a block), or
 * the demo yield sources' clocks through the server's operator warp route on a live testnet that has no such
 * method. Returns which one moved. Any node error other than an unknown method is rethrown.
 */
export async function moveClock(d: {
  rpc: (method: string, params: unknown[]) => Promise<unknown>;
  api: (path: string, body?: unknown) => Promise<unknown>;
  seconds: number;
}): Promise<"chain" | "sources"> {
  try {
    await d.rpc("evm_increaseTime", [toHex(d.seconds)]);
    await d.rpc("evm_mine", []);
    return "chain";
  } catch (e) {
    if (!unknownMethod(e)) throw e;
  }
  await d.api("/api/demo/warp", { seconds: d.seconds });
  return "sources";
}
