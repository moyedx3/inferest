import { test } from "node:test";
import assert from "node:assert/strict";
import { createFaucet, FAUCET_NATIVE, FAUCET_USDC } from "../faucet.ts";

const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const TO = "0x00000000000000000000000000000000000000cc";

/** A JSON-RPC fake: `unknown` methods answer -32601 the way anvil does for Tenderly's names, the rest answer null. */
function rpcFake(unknown: string[]) {
  const calls: { method: string; params: unknown[] }[] = [];
  const fn = (async (_url: string, init: RequestInit) => {
    const { method, params, id } = JSON.parse(String(init.body));
    calls.push({ method, params });
    const body = unknown.includes(method)
      ? { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } }
      : { jsonrpc: "2.0", id, result: null };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("funds through Tenderly's methods when the node knows them", async () => {
  const { fn, calls } = rpcFake([]);
  const r = await createFaucet({ rpcUrl: "http://rpc", usdc: USDC, fetchFn: fn }).fund(TO);
  assert.deepEqual(r, { native: FAUCET_NATIVE, usdc: FAUCET_USDC });
  assert.deepEqual(calls.map((c) => c.method), ["tenderly_setBalance", "tenderly_setErc20Balance"]);
  assert.deepEqual(calls[0].params, [[TO], "0xde0b6b3a7640000"]);
  assert.deepEqual(calls[1].params, [USDC, TO, "0x174876e800"]);
});

test("falls through anvil's methods down to the storage slot for native USDC", async () => {
  const { fn, calls } = rpcFake(["tenderly_setBalance", "tenderly_setErc20Balance", "anvil_dealERC20", "anvil_setERC20Balance"]);
  await createFaucet({ rpcUrl: "http://rpc", usdc: USDC, fetchFn: fn }).fund(TO);
  assert.deepEqual(calls.map((c) => c.method), [
    "tenderly_setBalance", "anvil_setBalance",
    "tenderly_setErc20Balance", "anvil_dealERC20", "anvil_setERC20Balance", "anvil_setStorageAt",
  ]);
  const slot = calls[5].params;
  assert.equal(slot[0], USDC);
  assert.match(String(slot[1]), /^0x[0-9a-f]{64}$/); // keccak(address, 9)
  assert.equal(slot[2], "0x000000000000000000000000000000000000000000000000000000174876e800");
});

test("a node that refuses every method reports the last error", async () => {
  const { fn } = rpcFake(["tenderly_setBalance", "anvil_setBalance"]);
  await assert.rejects(createFaucet({ rpcUrl: "http://rpc", usdc: USDC, fetchFn: fn }).fund(TO), /anvil_setBalance/);
});

test("a real error (not an unknown method) is not skipped", async () => {
  const fn = (async (_u: string, init: RequestInit) => {
    const { id } = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "insufficient permissions" } }), { status: 200 });
  }) as unknown as typeof fetch;
  await assert.rejects(createFaucet({ rpcUrl: "http://rpc", usdc: USDC, fetchFn: fn }).fund(TO), /tenderly_setBalance: insufficient permissions/);
});
