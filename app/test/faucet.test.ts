import { test, type TestContext } from "node:test";
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

test("a hung node is cut off", async () => {
  let aborted = false;
  const fn = ((_u: string, init: RequestInit) =>
    new Promise((_, reject) => init.signal!.addEventListener("abort", () => { aborted = true; reject(init.signal!.reason); }))) as unknown as typeof fetch;
  const started = Date.now();
  await assert.rejects(createFaucet({ rpcUrl: "http://rpc", usdc: USDC, fetchFn: fn, rpcTimeoutMs: 50 }).fund(TO));
  assert.ok(aborted, "the fetch was cut off by its signal");
  assert.ok(Date.now() - started < 1000);
});

import { decodeFunctionData, keccak256, pad, parseAbi, parseTransaction, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createMintFaucet, FaucetDry, MAX_WARP_SECONDS } from "../faucet.ts";

const FAUCET_KEY = `0x${"07".repeat(32)}` as Hex; // synthetic, never funded
const SIGNER = privateKeyToAccount(FAUCET_KEY).address.toLowerCase();
const TUSDC = "0x00000000000000000000000000000000000000dd";
const VAULT_A = "0x00000000000000000000000000000000000000ee";
const VAULT_B = "0x00000000000000000000000000000000000000ef";
const NATIVE = 500_000_000_000_000_000n; // 0.5 MON
const mintAbi = parseAbi(["function mint(address to, uint256 amount)"]);
const warpAbi = parseAbi(["function warp(uint256 by)"]);

/** A node fake for viem's send path: every raw transaction is accepted and reported mined (or reverted). */
function node(t: TestContext, options: { balance?: bigint; revert?: boolean; heldUsdc?: bigint; heldNative?: bigint } = {}) {
  const sent: Hex[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    const { id, method, params } = JSON.parse(String(init.body));
    let result: unknown;
    switch (method) {
      case "eth_fillTransaction": return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "unsupported" } });
      case "eth_chainId": result = toHex(10143); break;
      case "eth_getTransactionCount": result = toHex(sent.length); break;
      case "eth_getBlockByNumber": result = { number: "0x1", hash: "0x" + "01".repeat(32), transactions: [], baseFeePerGas: toHex(100_000_000_000n) }; break;
      case "eth_maxPriorityFeePerGas": result = toHex(2_000_000_000n); break;
      case "eth_gasPrice": result = toHex(102_000_000_000n); break;
      case "eth_estimateGas": result = toHex(60_000n); break;
      case "eth_call": result = pad(toHex(options.heldUsdc ?? 0n)); break;
      case "eth_getBalance": result = toHex(String(params[0]).toLowerCase() === SIGNER ? (options.balance ?? NATIVE * 10n) : (options.heldNative ?? 0n)); break;
      case "eth_sendRawTransaction": sent.push(params[0]); result = keccak256(params[0]); break;
      case "eth_getTransactionReceipt": result = {
        transactionHash: params[0], status: options.revert ? "0x0" : "0x1", blockHash: "0x" + "01".repeat(32), blockNumber: "0x1",
        transactionIndex: "0x0", cumulativeGasUsed: "0xea60", gasUsed: "0xea60", logs: [], logsBloom: "0x" + "00".repeat(256),
        effectiveGasPrice: toHex(102_000_000_000n), type: "0x2",
      }; break;
      default: throw new Error(`unexpected RPC method ${method}`);
    }
    return Response.json({ jsonrpc: "2.0", id, result });
  });
  return { sent, decoded: () => sent.map((raw) => parseTransaction(raw)) };
}

const mintFaucet = (over: Partial<Parameters<typeof createMintFaucet>[0]> = {}) => createMintFaucet({
  rpcUrl: "http://faucet-rpc.invalid", chainId: 10143, chainName: "Monad Testnet",
  nativeCurrency: { name: "Testnet MON Token", symbol: "MON", decimals: 18 },
  usdc: TUSDC, signerKey: FAUCET_KEY, nativeWei: NATIVE, warpTargets: [VAULT_A, VAULT_B], ...over,
});

test("the mint faucet mints test USDC to the wallet and then sends it gas", async (t) => {
  const { decoded } = node(t);
  const r = await mintFaucet().fund(TO);
  assert.deepEqual(r, { native: NATIVE, usdc: FAUCET_USDC });
  const [mint, gas] = decoded();
  assert.equal(mint.to?.toLowerCase(), TUSDC);
  assert.equal(mint.chainId, 10143);
  const call = decodeFunctionData({ abi: mintAbi, data: mint.data! });
  assert.equal(call.functionName, "mint");
  assert.equal(String(call.args![0]).toLowerCase(), TO);
  assert.equal(call.args![1], FAUCET_USDC);
  assert.equal(gas.to?.toLowerCase(), TO);
  assert.equal(gas.value, NATIVE);
  assert.equal(gas.data, undefined);
});

test("the mint faucet sends no gas when fundNative is zero", async (t) => {
  const { sent } = node(t);
  const r = await mintFaucet({ nativeWei: 0n }).fund(TO);
  assert.equal(r.native, 0n);
  assert.equal(sent.length, 1);
});

test("a nearly dry faucet signer refuses before minting anything", async (t) => {
  const { sent } = node(t, { balance: NATIVE * 2n - 1n });
  await assert.rejects(mintFaucet().fund(TO), (e: unknown) => e instanceof FaucetDry && /holds too little MON to fund a wallet/.test((e as Error).message));
  assert.equal(sent.length, 0);
});

test("a reverted faucet transaction is reported with its hash", async (t) => {
  const { sent } = node(t, { revert: true });
  await assert.rejects(mintFaucet().fund(TO), /faucet transaction reverted: 0x[0-9a-f]{64}/);
  assert.equal(sent.length, 1);
});

test("warp moves every demo yield source's clock and returns one hash per source", async (t) => {
  const { sent, decoded } = node(t);
  const txs = await mintFaucet().warp!(15_768_000n);
  assert.deepEqual(txs, sent.map((raw) => keccak256(raw)));
  const [a, b] = decoded();
  assert.equal(a.to?.toLowerCase(), VAULT_A);
  assert.equal(b.to?.toLowerCase(), VAULT_B);
  for (const tx of [a, b]) assert.deepEqual(decodeFunctionData({ abi: warpAbi, data: tx.data! }), { functionName: "warp", args: [15_768_000n] });
});

test("warp refuses zero, negative and more than ten years without a transaction", async (t) => {
  const { sent } = node(t);
  for (const by of [0n, -1n, MAX_WARP_SECONDS + 1n]) await assert.rejects(mintFaucet().warp!(by), /between one second and ten years/);
  assert.equal(sent.length, 0);
});

test("the cheat faucet has no warp: a fork moves its own clock", () => {
  assert.equal(createFaucet({ rpcUrl: "http://rpc", usdc: USDC }).warp, undefined);
});

test("overlapping faucet calls are serialized so one signer never races for a nonce", async (t) => {
  const { decoded } = node(t);
  const faucet = mintFaucet();
  await Promise.all([faucet.fund(TO), faucet.warp!(60n)]);
  assert.deepEqual(decoded().map((tx) => tx.nonce), [0, 1, 2, 3]);
});

test("the mint faucet tops up: a wallet already holding the gift gets no transaction", async (t) => {
  const { sent } = node(t, { heldUsdc: FAUCET_USDC, heldNative: NATIVE });
  const r = await mintFaucet().fund(TO);
  assert.deepEqual(r, { native: 0n, usdc: 0n });
  assert.equal(sent.length, 0);
});

test("the mint faucet tops up only what is missing", async (t) => {
  const { decoded } = node(t, { heldUsdc: 40_000_000_000n, heldNative: NATIVE / 2n });
  const r = await mintFaucet().fund(TO);
  assert.deepEqual(r, { native: NATIVE / 2n, usdc: 60_000_000_000n });
  const [mint, gas] = decoded();
  assert.equal(decodeFunctionData({ abi: mintAbi, data: mint.data! }).args![1], 60_000_000_000n);
  assert.equal(gas.value, NATIVE / 2n);
});
