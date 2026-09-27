import { parseAbi, parseEventLogs, type Account, type Chain, type Hex, type Transport, type WalletClient } from "viem";
import type { Decision } from "./fence.ts";
import type { AgentLog, ActionKind } from "./log.ts";
import type { publicClient } from "./book.ts";

export type Step =
  | { kind: "approve" | "deposit" | "withdraw"; vault: string; amount: bigint }
  | { kind: "redeem_all"; vault: string }
  | { kind: "create_vault"; target: string } | { kind: "accept" } | { kind: "register" } | { kind: "rekey" }
  | { kind: "paper_open" | "paper_close"; trade: Decision["trades"][number] };
export type PlanContext = { vault: string | null; currentTarget: string | null; vaultsByTarget: Record<string, string>; vaultShares: bigint; walletUsdc: bigint };
const micro = (usdc: number): bigint => BigInt(Math.round(usdc * 1e6));

/** The ordered steps an accepted decision needs. Pure, so the order and the reuse rule are testable. */
export function planActions(d: Decision, c: PlanContext): Step[] {
  const steps: Step[] = [];
  const lc = (s: string | null) => (s ?? "").toLowerCase();
  if (d.source.action === "move" && d.source.target) {
    if (c.vault) steps.push({ kind: "redeem_all", vault: c.vault });
    const existing = Object.entries(c.vaultsByTarget).find(([t]) => lc(t) === lc(d.source.target))?.[1];
    const amount = c.vaultShares > 0n ? c.vaultShares : 0n; // redeemed principal comes back as USDC; the executor uses the actual balance delta
    if (existing) steps.push({ kind: "approve", vault: existing, amount }, { kind: "deposit", vault: existing, amount });
    else steps.push({ kind: "create_vault", target: d.source.target }, { kind: "accept" }, { kind: "register" }, { kind: "approve", vault: "new", amount }, { kind: "deposit", vault: "new", amount });
    steps.push({ kind: "rekey" });
  }
  if (d.split.action === "deposit" && c.vault) steps.push({ kind: "approve", vault: c.vault, amount: micro(d.split.amountUsdc) }, { kind: "deposit", vault: c.vault, amount: micro(d.split.amountUsdc) });
  if (d.split.action === "withdraw" && c.vault) steps.push({ kind: "withdraw", vault: c.vault, amount: micro(d.split.amountUsdc) });
  for (const t of d.trades) steps.push({ kind: t.side === "buy" ? "paper_open" : "paper_close", trade: t });
  return steps;
}

export const factoryAbi = parseAbi([
  "function createVault(address target, string name, string symbol) returns (address)",
  "event VaultCreated(address indexed customer, address indexed vault, address indexed target)",
]);
export const vaultAbi = parseAbi([
  "function acceptManagement()",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function targetVault() view returns (address)",
]);
export const usdcAbi = parseAbi(["function approve(address, uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

export type LoggedAction = { kind: ActionKind; detail: Record<string, unknown>; tx?: string };
export type ActDeps = {
  wallet: WalletClient<Transport, Chain, Account>;
  pub: ReturnType<typeof publicClient>;
  log: AgentLog;
  /** The run the actions belong to; null on first start, when they go to `deferred` for the first run to record. */
  runId: number | null;
  deferred?: LoggedAction[];
  api(path: string, body?: unknown): Promise<any>;
  factory: Hex;
  usdc: Hex;
  address: Hex;
  targets: { address: string; name: string }[];
  /** Keeps a fresh key's secret in memory only. */
  setKey(secret: string): void;
};

const lower = (s: string) => s.toLowerCase();
/** An error's one-line text: viem's short message, which leaves out the request URL (an RPC URL can carry an API key). */
export const errorText = (e: unknown): string => String((e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? e);
const usdOf = (m: bigint) => Number(m) / 1e6;

/**
 * Performs the planned steps in order and writes each executed one to the run log. A step that throws stops the rest:
 * the remaining steps are recorded as refused, not attempted, and the error is rethrown for the run row.
 */
export async function act(steps: Step[], deps: ActDeps): Promise<void> {
  const { wallet, pub, log, address } = deps;
  const record = (a: LoggedAction) => { if (deps.runId === null) deps.deferred?.push(a); else log.addAction(deps.runId, a); };
  const send = async (to: Hex, abi: any, functionName: string, args: unknown[]) => {
    const hash = await wallet.writeContract({ address: to, abi, functionName, args } as any);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted in ${hash}`);
    return receipt;
  };
  const usdcBalance = () => pub.readContract({ address: deps.usdc, abi: usdcAbi, functionName: "balanceOf", args: [address] });
  const vaultsByTarget = (): Record<string, string> => JSON.parse(log.getMeta("vaultsByTarget") ?? "{}");

  // The deposit right before `rekey` belongs to the source move (or the first vault); every other deposit is a split.
  const rekeyAt = steps.findIndex((s) => s.kind === "rekey");
  const moveDepositAt = rekeyAt > 0 && steps[rekeyAt - 1].kind === "deposit" ? rekeyAt - 1 : -1;
  const startVault = log.getMeta("vault") ?? null;
  let currentVault = startVault;
  let newVault: string | null = null;
  let moveTarget: string | null = null;
  let redeemed: { amount: bigint; tx: string; from: string } | null = null;
  const resolve = (v: string): Hex => {
    if (v === "new") { if (!newVault) throw new Error("no new vault was created"); return newVault as Hex; }
    // a split planned against the vault the run started in follows a source move to the new vault
    if (startVault && lower(v) === lower(startVault) && currentVault) return currentVault as Hex;
    return v as Hex;
  };

  for (const [i, step] of steps.entries()) {
    try {
      const inMove = moveDepositAt >= 0 && (i === moveDepositAt || i === moveDepositAt - 1);
      switch (step.kind) {
        case "redeem_all": {
          const vault = step.vault as Hex;
          const shares = await pub.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [address] });
          const before = await usdcBalance();
          const r = await send(vault, vaultAbi, "redeem", [shares, address, address]);
          redeemed = { amount: (await usdcBalance()) - before, tx: r.transactionHash, from: lower(vault) };
          break;
        }
        case "create_vault": {
          const r = await send(deps.factory, factoryAbi, "createVault", [step.target, "Inferest Agent", "infVAULT"]);
          const created = parseEventLogs({ abi: factoryAbi, logs: r.logs, eventName: "VaultCreated" })[0];
          if (!created) throw new Error("createVault left no VaultCreated event");
          newVault = lower(created.args.vault);
          moveTarget = lower(step.target);
          break;
        }
        case "accept": {
          if (!newVault) throw new Error("no new vault to accept");
          await send(newVault as Hex, vaultAbi, "acceptManagement", []);
          break;
        }
        case "register": {
          if (!newVault || !moveTarget) throw new Error("no new vault to register");
          await deps.api("/api/vaults", { vault: newVault, label: "Agent" });
          log.setMeta("vaultsByTarget", JSON.stringify({ ...vaultsByTarget(), [moveTarget]: newVault }));
          break;
        }
        case "approve": {
          const amount = inMove && redeemed ? redeemed.amount : step.amount;
          await send(deps.usdc, usdcAbi, "approve", [resolve(step.vault), amount]);
          break;
        }
        case "deposit": {
          const vault = resolve(step.vault);
          const amount = inMove && redeemed ? redeemed.amount : step.amount;
          const r = await send(vault, vaultAbi, "deposit", [amount, address]);
          if (!inMove) { record({ kind: "deposit", detail: { vault: lower(vault), amountUsdc: usdOf(amount) }, tx: r.transactionHash }); break; }
          const target = moveTarget ?? Object.entries(vaultsByTarget()).find(([, v]) => lower(v) === lower(vault))?.[0]
            ?? lower(await pub.readContract({ address: vault, abi: vaultAbi, functionName: "targetVault" }));
          const name = deps.targets.find((t) => lower(t.address) === target)?.name ?? target;
          if (redeemed) {
            record({ kind: "move_source", detail: { from: redeemed.from, to: lower(vault), target, name, amountUsdc: usdOf(amount), created: newVault !== null, redeemTx: redeemed.tx, depositTx: r.transactionHash }, tx: r.transactionHash });
          } else {
            record({ kind: "deposit", detail: { vault: lower(vault), target, name, amountUsdc: usdOf(amount), created: newVault !== null }, tx: r.transactionHash });
          }
          currentVault = lower(vault);
          log.setMeta("vault", currentVault);
          log.setMeta("source", target);
          break;
        }
        case "withdraw": {
          const vault = resolve(step.vault);
          const r = await send(vault, vaultAbi, "withdraw", [step.amount, address, address]);
          record({ kind: "withdraw", detail: { vault: lower(vault), amountUsdc: usdOf(step.amount) }, tx: r.transactionHash });
          break;
        }
        case "rekey": {
          if (!currentVault) throw new Error("no vault to key");
          const previous = log.getMeta("keyId") ?? null;
          const { key, id } = await deps.api("/api/keys", { vault: currentVault, name: "agent", weight: 1 });
          deps.setKey(key);
          const keys: string[] = JSON.parse(log.getMeta("keys") ?? "[]");
          log.setMeta("keys", JSON.stringify([...keys, id]));
          log.setMeta("keyId", id);
          if (previous && previous !== id) await deps.api(`/api/keys/${previous}/revoke`, {});
          break;
        }
        case "paper_open": {
          const t = step.trade;
          const id = log.openPosition(deps.runId ?? 0, { asset: t.asset, side: "long", sizeUsdc: t.sizeUsdc, entryPrice: t.price });
          record({ kind: "paper_open", detail: { position: id, side: t.side, asset: t.asset, sizeUsdc: t.sizeUsdc, price: t.price, reasoning: t.reasoning } });
          break;
        }
        case "paper_close": {
          const t = step.trade;
          // whole positions only, oldest first, while each fits in what is left of the requested size
          let left = t.sizeUsdc;
          const closed: number[] = [];
          for (const p of log.openPositions().filter((p) => p.asset === t.asset)) {
            if (p.sizeUsdc > left + 1e-9) break;
            log.closePosition(p.id, deps.runId ?? 0, t.price);
            closed.push(p.id);
            left -= p.sizeUsdc;
          }
          if (closed.length) record({ kind: "paper_close", detail: { positions: closed, side: t.side, asset: t.asset, sizeUsdc: t.sizeUsdc - left, price: t.price, reasoning: t.reasoning } });
          else record({ kind: "refused", detail: { what: `sell ${t.asset}`, reason: `the oldest open ${t.asset} position is larger than ${t.sizeUsdc} USDC` } });
          break;
        }
      }
    } catch (e) {
      const message = errorText(e);
      for (const rest of steps.slice(i + 1)) record({ kind: "refused", detail: { what: rest.kind, reason: `not attempted: ${message}` } });
      throw e;
    }
  }
}
