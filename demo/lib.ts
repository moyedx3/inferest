import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, http, keccak256, pad, parseAbi, parseEventLogs, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
export const RPC = env("RPC_URL");
export const API = process.env.API_URL ?? "http://localhost:8787";
export const dep = JSON.parse(readFileSync(env("DEPLOYMENTS"), "utf8"));
export const chainCfg = JSON.parse(readFileSync(process.env.CHAIN_CONFIG ?? "config/arbitrum-one.json", "utf8"));
export const usd = (micro: bigint) => `$${(Number(micro) / 1e6).toFixed(2)}`;
export const step = (n: number, msg: string) => console.log(`\n${n}. ${msg}`);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j: any = await r.json();
  if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { code: j.error.code });
  return j.result;
}
export const warp = async (seconds: number) => { await rpc("evm_increaseTime", [toHex(seconds)]); await rpc("evm_mine", []); };

/** Try each cheat method in turn (Tenderly first, then anvil), moving on when the RPC does not know the method
 * or takes it under another parameter shape (anvil aliases tenderly_setBalance and answers -32602). */
async function cheat(calls: [string, unknown[]][]): Promise<unknown> {
  for (const [i, [method, params]] of calls.entries()) {
    try {
      return await rpc(method, params);
    } catch (e: any) {
      const unknown = e.code === -32601 || e.code === -32602 || /not found|not supported|does not exist|no slot found/i.test(e.message);
      if (!unknown || i === calls.length - 1) throw e;
    }
  }
}
export const fundEth = (to: string, wei: bigint) => cheat([["tenderly_setBalance", [[to], toHex(wei)]], ["anvil_setBalance", [to, toHex(wei)]]]);
export const fundUsdc = (to: string, micro: bigint) => cheat([
  ["tenderly_setErc20Balance", [chainCfg.usdc, to, toHex(micro)]],
  ["anvil_dealERC20", [chainCfg.usdc, to, toHex(micro)]],
  ["anvil_setERC20Balance", [chainCfg.usdc, to, toHex(micro)]],
  // Native USDC (FiatToken v2.2) defeats anvil's slot search: balances live in the mapping at slot 9.
  ["anvil_setStorageAt", [chainCfg.usdc, keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [to as Hex, 9n])), pad(toHex(micro))]],
]);

export async function api(path: string, body?: unknown): Promise<any> {
  const r = await fetch(API + path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json", "x-admin-token": env("ADMIN_TOKEN") }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${j.error ?? r.status}`);
  return j;
}

const chain = defineChain({ id: Number(dep.chainId), name: "fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
export const pub = createPublicClient({ chain, transport: http(RPC) });

const factoryAbi = parseAbi([
  "function createVault(address target, string name, string symbol) returns (address)",
  "event VaultCreated(address indexed customer, address indexed vault, address indexed target)",
]);
export const vaultAbi = parseAbi([
  "function acceptManagement()",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
]);
export const erc20Abi = parseAbi(["function approve(address, uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

/** A funded customer that creates its vault, accepts management and deposits. */
export async function customerWithVault(privateKey: Hex, depositMicro: bigint, label: string) {
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain, transport: http(RPC) });
  const send = async (address: Hex, abi: any, functionName: string, args: unknown[]) => {
    const hash = await wallet.writeContract({ address, abi, functionName, args } as any);
    return pub.waitForTransactionReceipt({ hash });
  };
  await fundEth(account.address, 10n ** 18n);
  await fundUsdc(account.address, depositMicro);
  const receipt = await send(dep.factory, factoryAbi, "createVault", [dep.target, `Inferest ${label}`, "infVAULT"]);
  const vault = (parseEventLogs({ abi: factoryAbi, logs: receipt.logs })[0] as any).args.vault as Hex;
  await send(vault, vaultAbi, "acceptManagement", []);
  await send(chainCfg.usdc, erc20Abi, "approve", [vault, depositMicro]);
  await send(vault, vaultAbi, "deposit", [depositMicro, account.address]);
  await api("/api/vaults", { vault, label });
  const value = async () => pub.readContract({ address: vault, abi: vaultAbi, functionName: "convertToAssets",
    args: [await pub.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [account.address] })] });
  const withdrawAll = async () => {
    const shares = await pub.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [account.address] });
    await send(vault, vaultAbi, "redeem", [shares, account.address, account.address]);
    return pub.readContract({ address: chainCfg.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  };
  return { account, vault, value, withdrawAll };
}

/** A chat completion on an Inferest key, through the Inferest proxy (OpenAI wire format). */
export async function chat(key: string, messages: unknown[], tools?: unknown[]): Promise<any> {
  const r = await fetch(`${API}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: process.env.DEMO_MODEL ?? "moonshotai/kimi-k2.6", messages, tools }),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`chat: ${r.status} ${JSON.stringify(j)}`);
  return j;
}

export async function printState(vault: string) {
  const s = await api("/api/state");
  const v = s.vaults.find((x: any) => x.vault === vault.toLowerCase());
  console.log(`   yield in Splitter $${v.yieldUsd.toFixed(2)}${v.frozen ? " (frozen)" : ""}`);
  for (const k of v.keys) console.log(`   ${k.name.padEnd(8)} budget $${k.budget.toFixed(2)}  spent $${k.spent.toFixed(4)}  tools $${k.toolSpent.toFixed(4)}  left $${k.remaining.toFixed(2)}`);
}
