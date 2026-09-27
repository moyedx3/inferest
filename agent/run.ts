import { createWalletClient, http, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "node:fs";
import { openAgentLog } from "./log.ts";
import { readBook, publicClient, usd } from "./book.ts";
import { rateFrom } from "./rate.ts";
import { applyFence } from "./fence.ts";
import { think, type Mcp, type PromptBook } from "./think.ts";
import { planActions, act, errorText, sendTx, usdcAbi, vaultAbi, type ActDeps, type LoggedAction, type Step } from "./act.ts";
import { createFaucet } from "../app/faucet.ts";

// an empty value in an env file counts as unset, so `AGENT_MODEL=` falls back like a missing line
const env = (k: string, fallback?: string): string => { const v = process.env[k] || fallback; if (v === undefined) throw new Error(`missing env ${k}`); return v; };
const once = process.argv.includes("--once");
const cfg = {
  rpcUrl: env("RPC_URL"), api: env("API_URL", "http://localhost:8787"), adminToken: env("ADMIN_TOKEN"), dbPath: env("DB_PATH", "inferest.db"),
  key: env("AGENT_PRIVATE_KEY") as Hex, bookUsdc: Number(env("AGENT_BOOK_USDC", "1000")), floorUsdc: Number(env("AGENT_FLOOR_USDC", "200")),
  intervalMs: Number(env("AGENT_INTERVAL_MS", "600000")), demoDays: Number(env("AGENT_DEMO_DAYS", "0")), model: env("AGENT_MODEL", process.env.DEMO_MODEL || "moonshotai/kimi-k2.6"),
  maxTurns: Number(env("AGENT_MAX_TURNS", "10")), maxToolCalls: Number(env("AGENT_MAX_TOOL_CALLS", "4")), tradeCapBps: Number(env("AGENT_TRADE_CAP_BPS", "2000")),
};
const numeric: [string, number][] = [["AGENT_BOOK_USDC", cfg.bookUsdc], ["AGENT_FLOOR_USDC", cfg.floorUsdc], ["AGENT_INTERVAL_MS", cfg.intervalMs], ["AGENT_DEMO_DAYS", cfg.demoDays],
  ["AGENT_MAX_TURNS", cfg.maxTurns], ["AGENT_MAX_TOOL_CALLS", cfg.maxToolCalls], ["AGENT_TRADE_CAP_BPS", cfg.tradeCapBps]];
for (const [k, v] of numeric) if (!(Number.isFinite(v) && v >= 0)) { console.log(`${k} must be a finite number of zero or more`); process.exit(1); }
if (!once && cfg.intervalMs <= 0) { console.log("AGENT_INTERVAL_MS must be above zero"); process.exit(1); }
if (cfg.maxTurns < 1) { console.log("AGENT_MAX_TURNS must be at least 1"); process.exit(1); }
const chainCfg = JSON.parse(readFileSync(process.env.CHAIN_CONFIG ?? "config/arbitrum-one.json", "utf8"));
const dep = JSON.parse(readFileSync(env("DEPLOYMENTS"), "utf8"));
const targets: { address: Hex; name: string }[] = chainCfg.targets ?? [{ address: chainCfg.target, name: chainCfg.targetName ?? "yield source" }];

const DEAD = "0x000000000000000000000000000000000000dEaD" as Hex;
const OUT_OF_BUDGET = "out of thinking budget until yield accrues";
const lower = (s: string) => s.toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errorOf = (e: unknown) => errorText(e).replaceAll(cfg.rpcUrl, "<rpc>");

const account = privateKeyToAccount(cfg.key);
const address = lower(account.address) as Hex;
const usdc = chainCfg.usdc as Hex;
const pub = publicClient(cfg.rpcUrl, Number(dep.chainId));
const wallet = createWalletClient({ account, chain: pub.chain, transport: http(cfg.rpcUrl) });
const log = openAgentLog(cfg.dbPath);

/** Operator calls, as demo/lib.ts makes them: a GET without a body, a POST with one. */
async function api(path: string, body?: unknown): Promise<any> {
  const headers = { "Content-Type": "application/json", "x-admin-token": cfg.adminToken };
  const r = await fetch(cfg.api + path, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${j.error ?? r.status}`);
  return j;
}
async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const r = await fetch(cfg.rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j: any = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

// The key's secret lives here and nowhere else: never in the log, the store rows or a log line.
let key: string | null = null;
const setupActions: LoggedAction[] = [];
const deps = (runId: number | null): ActDeps => ({
  wallet, pub, log, runId, deferred: setupActions, api, redact: errorOf, factory: dep.factory as Hex, usdc, address, targets, setKey: (secret) => { key = secret; },
});
const vaultsByTarget = (): Record<string, string> => JSON.parse(log.getMeta("vaultsByTarget") ?? "{}");
const usdcBalance = () => pub.readContract({ address: usdc, abi: usdcAbi, functionName: "balanceOf", args: [address] });
const valueIn = async (vault: Hex) => pub.readContract({ address: vault, abi: vaultAbi, functionName: "convertToAssets",
  args: [await pub.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [address] })] });
/** The book in dollars without taking a share-price sample, so a run's two reads never sample twice at one clock. */
async function holdings(): Promise<{ walletUsdc: number; vaultValue: number }> {
  const vault = log.getMeta("vault") as Hex | undefined;
  return { walletUsdc: usd(await usdcBalance()), vaultValue: vault ? usd(await valueIn(vault)) : 0 };
}

/** First start: fund on a fork, park half the book over the first source, register, mint the key. Later: rotate the key. */
async function ensureRegistered(): Promise<void> {
  log.setMeta("address", address);
  log.setMeta("floor", String(cfg.floorUsdc));
  const vault = log.getMeta("vault");
  const keyId = log.getMeta("keyId");
  const keyVault = log.getMeta("keyVault");
  // a source move whose re-key failed leaves the key on the old vault: mint on the current one, revoking the old key
  if (vault && keyId && keyVault && keyVault !== lower(vault)) { await act([{ kind: "rekey" }], deps(null)); return; }
  if (vault && keyId) {
    key = (await api(`/api/keys/${keyId}/rotate`, {})).key;
    log.setMeta("keyVault", lower(vault));
    return;
  }
  if (vault) { await act([{ kind: "rekey" }], deps(null)); return; }
  const book = BigInt(Math.round(cfg.bookUsdc * 1e6));
  // only a wallet the faucet funded in this start is trimmed: a pre-funded wallet, or any real chain, is never touched
  if (cfg.demoDays > 0 && (await usdcBalance()) === 0n) {
    await createFaucet({ rpcUrl: cfg.rpcUrl, usdc }).fund(address);
    // the faucet gives far more than the book; burn the surplus so the wallet holds exactly what the prompt describes
    const surplus = (await usdcBalance()) - book;
    if (surplus > 0n) {
      const receipt = await sendTx(wallet, pub, usdc, usdcAbi, "transfer", [DEAD, surplus]);
      setupActions.push({ kind: "sweep", detail: { surplusUsdc: usd(surplus), to: lower(DEAD) }, tx: receipt.transactionHash });
    }
  }
  const amount = book / 2n;
  const target = lower(targets[0].address);
  const existing = vaultsByTarget()[target];
  const steps: Step[] = existing
    ? [{ kind: "approve", vault: existing, amount }, { kind: "deposit", vault: existing, amount }, { kind: "rekey" }]
    : [{ kind: "create_vault", target }, { kind: "accept" }, { kind: "register" }, { kind: "approve", vault: "new", amount }, { kind: "deposit", vault: "new", amount }, { kind: "rekey" }];
  await act(steps, deps(null));
}

/** On a fork or a Tenderly testnet, moves the chain clock so yield accrues between runs, then has the server read it. */
async function advanceClock(): Promise<void> {
  if (cfg.demoDays <= 0) return;
  try {
    await rpc("evm_increaseTime", [toHex(Math.round(cfg.demoDays * 86_400))]);
    await rpc("evm_mine", []);
  } catch (e) {
    console.log(`clock not advanced: ${errorOf(e)}`);
    return;
  }
  const vault = log.getMeta("vault");
  if (vault) await api("/api/admin/report", { vault }).catch((e) => console.log(`report after the clock move failed: ${errorOf(e)}`));
}

async function connectMcp(secret: string): Promise<{ mcp: Mcp; close(): Promise<void> }> {
  const client = new Client({ name: "inferest-agent", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${cfg.api}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }));
  return {
    mcp: {
      listTools: async () => (await client.listTools()).tools,
      // paid tools can take a few minutes (payment plus a scrape); the client default is 60 seconds
      callTool: (name, args) => client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> }, undefined, { timeout: 240_000 }),
    },
    close: () => client.close(),
  };
}

async function runOnce(): Promise<void> {
  const vault = (log.getMeta("vault") ?? null) as Hex | null;
  const book = await readBook({ pub, address, usdc, vault, targets: targets.map((t) => t.address), log });
  const runId = log.startRun({ clockAt: book.clockAt, bookBefore: { walletUsdc: usd(book.walletUsdc), vaultValue: usd(book.vaultValue), vault: book.vault && lower(book.vault), target: book.target } });
  for (const a of setupActions.splice(0)) log.addAction(runId, a);
  let status: "done" | "out_of_budget" | "failed" = "done";
  let note = "";
  let decision: unknown = null;
  let error: string | undefined;
  try {
    // shares left in a vault the agent moved away from come back to the working half
    let walletUsdc = book.walletUsdc;
    for (const [target, v] of Object.entries(vaultsByTarget())) {
      if (vault && lower(v) === lower(vault)) continue;
      const shares = await pub.readContract({ address: v as Hex, abi: vaultAbi, functionName: "balanceOf", args: [address] });
      if (shares === 0n) continue;
      const before = await usdcBalance();
      const receipt = await sendTx(wallet, pub, v as Hex, vaultAbi, "redeem", [shares, address, address]);
      walletUsdc = await usdcBalance();
      log.addAction(runId, { kind: "sweep", detail: { vault: lower(v), target, amountUsdc: usd(walletUsdc - before) }, tx: receipt.transactionHash });
    }
    const positions = log.openPositions();
    const promptBook: PromptBook = {
      walletUsdc: usd(walletUsdc), vaultValue: usd(book.vaultValue), floorUsdc: cfg.floorUsdc, currentTarget: book.target,
      targets: targets.map((t) => ({ address: lower(t.address), name: t.name, rate: rateFrom(log.lastSamples(t.address)) })),
      positions: positions.map((p) => ({ asset: p.asset, side: p.side, sizeUsdc: p.sizeUsdc, entryPrice: p.entryPrice, markPrice: p.markPrice })),
    };
    if (!key) throw new Error("no key in memory");
    const client = await connectMcp(key);
    let thought;
    try {
      thought = await think({ key, model: cfg.model, api: cfg.api, mcp: client.mcp, book: promptBook, maxTurns: cfg.maxTurns, maxToolCalls: cfg.maxToolCalls });
    } finally {
      await client.close().catch(() => {});
    }
    const extras = { toolCalls: thought.toolCalls, turns: thought.turns };
    if (thought.outOfBudget) { status = "out_of_budget"; note = OUT_OF_BUDGET; decision = extras; return; }
    if (!thought.decision) { status = "failed"; error = thought.error ?? "no decision"; decision = extras; return; }
    decision = { ...thought.decision, ...extras };
    note = thought.decision.note;
    const { accepted, refused } = applyFence(thought.decision, {
      walletUsdc: usd(walletUsdc), vaultValue: usd(book.vaultValue), floorUsdc: cfg.floorUsdc, currentTarget: book.target ?? "",
      targets: targets.map((t) => t.address), tradeCapBps: cfg.tradeCapBps, positions: positions.map((p) => ({ asset: p.asset, sizeUsdc: p.sizeUsdc })),
    });
    for (const r of refused) log.addAction(runId, { kind: "refused", detail: r });
    const steps = planActions(accepted, { vault, currentTarget: book.target, vaultsByTarget: vaultsByTarget(), vaultShares: book.vaultShares, walletUsdc });
    await act(steps, deps(runId));
    const prices: Record<string, number> = {};
    for (const t of thought.decision.trades) if (t.price > 0) prices[t.asset] = t.price;
    log.markPositions(prices);
  } catch (e) {
    status = "failed";
    error = errorOf(e);
  } finally {
    const after = await holdings().catch(() => null);
    log.finishRun(runId, { status, note, decision, bookAfter: after ?? {}, error });
    if (after) log.setMeta("book", JSON.stringify(after));
    // on a real chain the keeper settles; on a fork every fourth run stands in for a month end
    const settled = cfg.demoDays > 0 && runId % 4 === 0 ? await monthEnd() : "";
    const cost = await api("/api/agent").then((j) => j.runs?.find((r: any) => r.id === runId)?.cost).catch(() => null);
    const money = (x: unknown) => (typeof x === "number" ? `$${x.toFixed(4)}` : "$?");
    console.log(`run ${runId} ${status} models ${money(cost?.models)} tools ${money(cost?.tools)}${settled}${error ? ` error: ${error}` : ""}`);
  }
}

/** Every fourth run is a month end: settle every vault the agent has used. */
async function monthEnd(): Promise<string> {
  const results = [];
  for (const v of new Set(Object.values(vaultsByTarget()))) {
    results.push(await api("/api/admin/settle", { vault: v }).then((r) => (r.usageMicro === null ? "none" : r.pending ? "pending" : "ok")).catch(() => "failed"));
  }
  return ` month end settle ${results.join(",")}`;
}

try {
  await ensureRegistered();
  for (;;) {
    await advanceClock();
    try { await runOnce(); } catch (e) { console.log(`run not started: ${errorOf(e)}`); }
    if (once) break;
    await sleep(cfg.intervalMs);
  }
} catch (e) {
  console.log(`agent stopped: ${errorOf(e)}`);
  process.exitCode = 1;
} finally {
  log.close();
}
