import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { keccak256, parseTransaction, toHex, type Hex } from "viem";
import { makeChain } from "../chain.ts";
import type { Config } from "../config.ts";
import { HACKATHON_PARAMS } from "../../engine/ledger.ts";

const V = "0x00000000000000000000000000000000000000aa";
const SPLITTER = "0x00000000000000000000000000000000000000bb";
const GAS = 100_000n;
const FEE = 3_000_000_000n;
const COST = GAS * FEE;
const RESERVE = 1_000_000_000_000_000n;

function rpc(t: TestContext, options: { balance?: bigint; legacy?: boolean } = {}) {
  const calls: string[] = [];
  const sent: Hex[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    const { id, method, params } = JSON.parse(String(init.body));
    calls.push(method);
    let result: unknown;
    switch (method) {
      case "eth_call": result = "0x" + "0".repeat(192); break;
      case "eth_fillTransaction": return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "unsupported" } });
      case "eth_getTransactionCount": result = "0x0"; break;
      case "eth_chainId": result = "0xa4b1"; break;
      case "eth_getBlockByNumber": result = { number: "0x1", hash: "0x" + "01".repeat(32), transactions: [], ...(options.legacy ? {} : { baseFeePerGas: toHex(2_000_000_000n) }) }; break;
      case "eth_maxPriorityFeePerGas": result = toHex(600_000_000n); break;
      case "eth_gasPrice": result = toHex(2_500_000_000n); break;
      case "eth_estimateGas": result = toHex(GAS); break;
      case "eth_getBalance": result = toHex(options.balance ?? COST + RESERVE); break;
      case "eth_sendRawTransaction": sent.push(params[0]); result = keccak256(params[0]); break;
      case "eth_getTransactionReceipt": result = {
        transactionHash: params[0], status: "0x1", blockHash: "0x" + "01".repeat(32), blockNumber: "0x1",
        transactionIndex: "0x0", cumulativeGasUsed: toHex(GAS), gasUsed: toHex(GAS), logs: [], logsBloom: "0x" + "00".repeat(256),
        effectiveGasPrice: toHex(FEE), type: options.legacy ? "0x0" : "0x2",
      }; break;
      default: throw new Error(`unexpected RPC method ${method}`);
    }
    return Response.json({ jsonrpc: "2.0", id, result });
  });
  // public synthetic test key, never a funded signer.
  const cfg: Config = {
    chainId: 42161, rpcUrl: "http://keeper-rpc.invalid", keeperKey: `0x${"01".repeat(32)}`, splitter: SPLITTER,
    keeperMinBalanceWei: RESERVE, keeperMaxTxCostWei: COST,
    usdc: V, target: V, factory: V, targets: [{ address: V, name: "test" }],
    openRouterKey: "", orthogonalKey: "", adminToken: "", keyEncryptionKey: "", publicUrl: "", dbPath: ":memory:",
    port: 0, params: HACKATHON_PARAMS, demoFaucet: false, chainName: "test", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  };
  return { cfg, calls, sent };
}

for (const action of ["report", "prepareSettle", "settle"] as const) {
  test(`${action} rejects a prepared fee ceiling above the transaction cap without broadcasting`, async (t) => {
    const { cfg, calls, sent } = rpc(t);
    cfg.keeperMaxTxCostWei = COST - 1n;
    const chain = makeChain(cfg);
    await assert.rejects(action === "report" ? chain.report(V) : chain[action](V, 1n), /KEEPER_MAX_TX_COST_ETH/);
    assert.ok(calls.includes("eth_estimateGas"));
    assert.equal(sent.length, 0);
  });
  test(`${action} preserves the ETH reserve using the full prepared fee ceiling`, async (t) => {
    const { cfg, calls, sent } = rpc(t, { balance: COST + RESERVE - 1n });
    const chain = makeChain(cfg);
    await assert.rejects(action === "report" ? chain.report(V) : chain[action](V, 1n), /KEEPER_MIN_BALANCE_ETH/);
    assert.ok(calls.includes("eth_getBalance"));
    assert.equal(sent.length, 0);
  });
}

for (const legacy of [false, true]) {
  test(`permitted ${legacy ? "legacy" : "EIP-1559"} writes sign exactly the checked gas and fee ceiling`, async (t) => {
    const { cfg, sent } = rpc(t, { legacy });
    const chain = makeChain(cfg);
    const prepared = await chain.prepareSettle(V, 1n);
    assert.equal(sent.length, 0);
    await prepared.send();
    assert.equal(keccak256(sent[0]), prepared.hash);
    await chain.report(V);
    assert.equal(sent.length, 2);
    for (const raw of sent) {
      const tx = parseTransaction(raw);
      assert.equal(tx.gas, GAS);
      assert.equal(tx.maxFeePerGas ?? tx.gasPrice, FEE);
      assert.equal(tx.chainId, 42161);
    }
  });
}

test("unset ETH controls preserve writes without a balance preflight", async (t) => {
  const { cfg, calls, sent } = rpc(t, { balance: 0n });
  delete cfg.keeperMinBalanceWei;
  delete cfg.keeperMaxTxCostWei;
  await makeChain(cfg).report(V);
  assert.equal(sent.length, 1);
  assert.ok(!calls.includes("eth_getBalance"));
});
