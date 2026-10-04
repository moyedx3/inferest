import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Params } from "../engine/ledger.ts";
import type { Chain } from "./chain.ts";
import type { OpenRouter } from "./openrouter.ts";
import type { Store, VaultRow } from "./store.ts";
import type { ToolGateway } from "./tools.ts";
import { readBody, BodyTooLarge, type Proxy } from "./proxy.ts";
import type { Auth, Session } from "./auth.ts";
import type { Faucet } from "./faucet.ts";
import { OwnerCooldown } from "./cooldown.ts";
import { buildMcpServer } from "./mcp.ts";
import { computeLimits, settlePreview } from "./limits.ts";
import { sha256, sameSecret, newInferestKey, type SecretBox } from "./crypto.ts";
import { syncAll, syncVault, reportAll, reportVault, settleVault, markRegistered, isSettling, type KeeperDeps } from "./keeper.ts";
import type { AgentLog } from "../agent/log.ts";
import { rateFrom } from "../agent/rate.ts";
import { ASSETS, MAX_TRADES } from "../agent/fence.ts";

export { sha256 } from "./crypto.ts";

export type AppDeps = {
  store: Store; or: OpenRouter; chain: Chain; gateway: ToolGateway; params: Params;
  adminToken: string; publicConfig: Record<string, unknown>; keeper: KeeperDeps;
  /** Encrypts each vault's OpenRouter key at rest. */
  secrets: SecretBox;
  proxy: Proxy;
  /** Verifies finance-lead logins; unset means the operator token is the only credential. */
  auth?: Auth;
  /** Funds a signed-in wallet on a demo chain; unset on real chains. */
  faucet?: Faucet;
  /** The hosted agent's run log, read-only here; unset when no runner exists. */
  agentLog?: AgentLog;
  /** Logs an uncaught error from a route (default console.error). */
  logError?: (msg: string) => void;
  /**
   * How long a signed-in owner waits between two report calls and between two settle calls on one vault, so no
   * owner can make the keeper spend gas at will on a real chain. Unset means no limit (demo chains). The operator
   * is never limited.
   */
  ownerCooldown?: { reportMs: number; settleMs: number };
};

/** Who is asking: the operator (admin token), a signed-in finance lead, or nobody. */
export type Caller = { kind: "operator" } | { kind: "session"; session: Session } | { kind: "none" };

const DASHBOARD = fileURLToPath(new URL("./dashboard/", import.meta.url));
const ZERO = /^0x0{40}$/i;
const KEY_ROUTE = /^\/api\/keys\/([0-9a-f]{16})\/(weight|revoke|rotate)$/;
const NEED_LOGIN = { error: "sign in or send the admin token" };
const NOT_YOURS = { error: "not your vault" };
const OPERATOR_ONLY = { error: "operator only" };

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

const COOLDOWN_MESSAGE = {
  report: "reported less than an hour ago; the keeper reports every vault daily",
  settle: "settled less than a day ago; the keeper settles every vault at month end",
} as const;

/** Answers 429 and returns true when an owner (never the operator) is inside the cooldown for this kind and vault. */
function coolingDown(cooldown: OwnerCooldown | undefined, res: ServerResponse, caller: Caller, kind: "report" | "settle", vault: string): boolean {
  if (!cooldown || caller.kind === "operator") return false;
  const wait = cooldown.check(kind, vault, Date.now());
  if (wait === 0) return false;
  send(res, 429, { error: COOLDOWN_MESSAGE[kind], retryAfterSeconds: wait }, { "Retry-After": String(wait) });
  return true;
}

/** Cap on a JSON body outside /v1. Past it readBody throws BodyTooLarge, which createApp answers with 413. */
const MAX_JSON_BYTES = 1_000_000;

async function readJson(req: IncomingMessage): Promise<any> {
  const raw = await readBody(req, MAX_JSON_BYTES);
  return raw ? JSON.parse(raw) : {};
}

function bearer(req: IncomingMessage): string {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

/** Resolves the request's credentials once. A bearer that fails verification counts as nobody and is logged by reason only. */
export async function resolveCaller(d: AppDeps, req: IncomingMessage): Promise<Caller> {
  if (sameSecret(req.headers["x-admin-token"], d.adminToken)) return { kind: "operator" };
  const token = bearer(req);
  if (!token || !d.auth) return { kind: "none" };
  try {
    const session = await d.auth.verify(token);
    if (session.walletsError) d.keeper.log(`session ${session.userId} wallets unavailable: ${session.walletsError}`);
    return { kind: "session", session };
  } catch (e) {
    d.keeper.log(`login refused: ${(e as Error).message}`);
    return { kind: "none" };
  }
}

/** Whether the caller may act on a vault owned by `customer` (the creator address the factory reported). */
function owns(caller: Caller, customer: string): boolean {
  if (caller.kind === "operator") return true;
  if (caller.kind === "session") return caller.session.wallets.includes(customer.toLowerCase());
  return false;
}

/** One vault's public entry: field by field, never a spread of a store row, so a new secret column can never leak. */
function vaultEntry(d: AppDeps, v: VaultRow) {
  const keys = d.store.keysForVault(v.vault);
  const limits = computeLimits(v.yieldUsd, keys, d.params, v.frozen);
  return {
    vault: v.vault, customer: v.customer, label: v.label, period: v.period, frozen: v.frozen, settling: v.settling,
    yieldUsd: v.yieldUsd, orLimit: v.orLimit, orUsage: v.orUsage, hasOpenRouterKey: v.orKeyHash !== null,
    credit: v.frozen ? 0 : Math.max(0, v.yieldUsd) * (1 - d.params.railFee),
    preview: settlePreview(v.yieldUsd, keys, d.params),
    keys: keys.map((k, i) => ({
      id: k.id, name: k.name, weight: k.weight, revoked: k.revoked, createdAt: k.createdAt,
      modelSpent: k.modelSpent, toolSpent: k.toolSpent,
      budget: limits[i].budget, spent: limits[i].spent, remaining: limits[i].remaining,
    })),
  };
}

/** The public state for one caller. */
function state(d: AppDeps, caller: Caller) {
  const vaults = d.store.listVaults().filter((v) => owns(caller, v.customer));
  const mine = new Set(vaults.map((v) => v.vault));
  return {
    config: d.publicConfig,
    vaults: vaults.map((v: VaultRow) => vaultEntry(d, v)),
    settlements: d.store.listSettlements().filter((s) => mine.has(s.vault)),
    pendingSettlements: d.store.listPendingSettlements().filter((p) => mine.has(p.vault)).map((p) => ({
      vault: p.vault, usageMicro: p.usageMicro.toString(), tx: p.tx, createdAt: p.createdAt,
    })),
  };
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const PAGES: Record<string, string> = { "/": "home.html", "/treasury": "treasury.html", "/agents": "agents.html" };
  const TYPES: Record<string, string> = { js: "text/javascript", css: "text/css", svg: "image/svg+xml", html: "text/html" };
  const file = PAGES[pathname] ?? pathname.slice(1);
  if (file === "index.html" || file.endsWith(".html") && !Object.values(PAGES).includes(file)) return send(res, 404, { error: "not found" });
  if (!/^[a-z0-9.-]+$/i.test(file)) return send(res, 404, { error: "not found" });
  try {
    const body = await readFile(DASHBOARD + file);
    res.writeHead(200, { "Content-Type": TYPES[file.split(".").pop() ?? ""] ?? "text/html" });
    res.end(body);
  } catch {
    send(res, 404, { error: "not found" });
  }
}

/** Reopens the vault's backstop right after a key change, so a new key's first call does not wait for the next tick. */
async function resyncAfter(d: AppDeps, vault: string, why: string): Promise<void> {
  try {
    await syncVault(d.keeper, vault);
  } catch (e) {
    d.keeper.log(`sync ${vault} after ${why} failed: ${(e as Error).message}`);
  }
}

/** Mints the vault's single OpenRouter key (limit 0 until the keeper syncs) and returns it encrypted, filing nothing. */
async function mintCompanyKey(d: AppDeps, vault: string): Promise<{ hash: string; encrypted: string }> {
  const { key, hash } = await d.or.createKey(`inferest:vault:${vault.slice(2, 10)}`, 0);
  return { hash, encrypted: d.secrets.encrypt(key) };
}

/**
 * The one authorization question every vault-scoped route asks. Answers with the vault row when the caller may
 * act on it, or sends 404 (unknown vault) or 403 (not the caller's) and returns undefined.
 */
function vaultFor(d: AppDeps, res: ServerResponse, caller: Caller, vault: string): VaultRow | undefined {
  const row = d.store.vault(vault);
  if (!row) { send(res, 404, { error: "unknown vault" }); return undefined; }
  if (!owns(caller, row.customer)) { send(res, 403, NOT_YOURS); return undefined; }
  return row;
}

async function route(d: AppDeps, req: IncomingMessage, res: ServerResponse, cooldown?: OwnerCooldown): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (await d.proxy.handle(req, res)) return;

  if (url.pathname === "/mcp") {
    const key = d.store.keyBySecret(sha256(bearer(req)));
    if (!key || key.revoked) return send(res, 401, { error: "unknown key" });
    const body = req.method === "POST" ? await readJson(req) : undefined;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildMcpServer(d.gateway, key.id, d.keeper.log);
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  if (url.pathname === "/api/state" && req.method === "GET") return send(res, 200, state(d, await resolveCaller(d, req)));

  if (url.pathname === "/api/agent" && req.method === "GET") {
    const log = d.agentLog;
    const vault = log?.getMeta("vault")?.toLowerCase();
    const row = vault ? d.store.vault(vault) : undefined;
    if (!log || !vault || !row) return send(res, 404, { error: "no agent yet" });
    const keyIds: string[] = JSON.parse(log.getMeta("keys") ?? "[]");
    const runs = log.listRuns(50).map((r) => ({
      id: r.id, startedAt: r.startedAt, finishedAt: r.finishedAt, clockAt: r.clockAt, status: r.status, note: r.note, decision: r.decision,
      actions: r.actions.map((a) => ({ kind: a.kind, detail: a.detail, tx: a.tx })),
      cost: (({ modelUsd, toolUsd }) => ({ models: modelUsd, tools: toolUsd }))(d.store.spendInWindow(keyIds, r.startedAt, r.finishedAt ?? Date.now())),
    }));
    const sources = (d.publicConfig.targets as { address: string; name: string }[] | undefined ?? []).map((t) => {
      const s = log.lastSamples(t.address);
      return { target: t.address, name: t.name, rate: rateFrom(s), current: t.address.toLowerCase() === (log.getMeta("source") ?? "").toLowerCase() };
    });
    const book = JSON.parse(log.getMeta("book") ?? "{}");
    // a source move leaves settlements on the agent's older vaults: keep every vault it has used
    const agentVaults = new Set([vault, ...Object.values(JSON.parse(log.getMeta("vaultsByTarget") ?? "{}") as Record<string, string>).map((v) => v.toLowerCase())]);
    const fenceMeta = (() => { try { return JSON.parse(log.getMeta("fence") ?? "null"); } catch { return null; } })();
    const scheduleMeta = (() => { try { return JSON.parse(log.getMeta("schedule") ?? "null"); } catch { return null; } })();
    const fence = {
      floorUsdc: Number(fenceMeta?.floorUsdc ?? log.getMeta("floor") ?? 200), tradeCapBps: Number(fenceMeta?.tradeCapBps ?? 2000),
      maxToolCalls: Number(fenceMeta?.maxToolCalls ?? 4), maxTurns: Number(fenceMeta?.maxTurns ?? 10),
      maxTrades: MAX_TRADES, assets: [...ASSETS], splitMovesPerRun: 1, sourceMovesPerRun: 1, fromRunner: fenceMeta !== null,
    };
    return send(res, 200, {
      agent: { address: log.getMeta("address") ?? null, vault, source: sources.find((s) => s.current) ?? null, period: row.period, runCount: log.latestRun()?.id ?? 0,
        schedule: scheduleMeta && Number.isFinite(Number(scheduleMeta.intervalMs)) ? { intervalMs: Number(scheduleMeta.intervalMs), demoDays: Number(scheduleMeta.demoDays ?? 0) } : null },
      book: { walletUsdc: book.walletUsdc ?? null, vaultValue: book.vaultValue ?? null, floor: Number(log.getMeta("floor") ?? 200), positions: log.openPositions() },
      budget: vaultEntry(d, row),
      sources,
      runs,
      settlements: d.store.listSettlements().filter((s) => agentVaults.has(s.vault)),
      fence,
    });
  }

  if (url.pathname.startsWith("/api/")) {
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    const caller = await resolveCaller(d, req);
    if (caller.kind === "none") return send(res, 401, NEED_LOGIN);
    const body = await readJson(req);

    if (url.pathname === "/api/vaults") {
      const vault = String(body.vault ?? "").toLowerCase();
      const customer = await d.chain.customerOf(vault).catch(() => "");
      if (!customer || ZERO.test(customer)) return send(res, 400, { error: "not a vault from our factory" });
      if (!owns(caller, customer)) return send(res, 403, NOT_YOURS);
      // the provider key is minted before anything is written, so a provider failure leaves no half-registered
      // vault; a vault whose row already has a key is registered already and is only answered again
      if (!d.store.openRouterKeyFor(vault)) {
        const minted = await mintCompanyKey(d, vault);
        // another registration may have completed while minting; never orphan its funded key.
        // the unused freshly minted key stays at its initial zero limit.
        if (!d.store.openRouterKeyFor(vault)) {
          d.store.addVault(vault, customer, String(body.label ?? "customer"));
          markRegistered(d.store, vault); // a vault added mid-month is first settled next month
          d.store.setVaultOpenRouterKey(vault, minted.hash, minted.encrypted);
        }
      }
      return send(res, 201, { vault, customer: customer.toLowerCase() });
    }
    if (url.pathname === "/api/keys") {
      const vault = String(body.vault ?? "").toLowerCase();
      if (!vaultFor(d, res, caller, vault)) return;
      const weight = Number(body.weight ?? 1);
      if (!(Number.isFinite(weight) && weight >= 0)) return send(res, 400, { error: "weight must be a finite number >= 0" });
      const name = String(body.name ?? "key");
      const { id, secret } = newInferestKey();
      d.store.addKey({ id, vault, name, weight, secretSha256: sha256(secret) });
      await resyncAfter(d, vault, "key creation");
      return send(res, 201, { key: secret, id });
    }
    const m = url.pathname.match(KEY_ROUTE);
    if (m) {
      const [, id, action] = m;
      const key = d.store.keyById(id);
      if (!key) return send(res, 404, { error: "unknown key" });
      if (!vaultFor(d, res, caller, key.vault)) return;
      if (action === "weight") {
        const weight = Number(body.weight);
        if (!(Number.isFinite(weight) && weight >= 0)) return send(res, 400, { error: "weight must be a finite number >= 0" });
        d.store.setWeight(id, weight);
        await resyncAfter(d, key.vault, "weight change");
        return send(res, 200, { ok: true });
      }
      if (action === "revoke") {
        d.store.revokeKey(id); // already revoked is fine: the outcome is the same
        await resyncAfter(d, key.vault, "revocation");
        return send(res, 200, { ok: true });
      }
      if (key.revoked) return send(res, 409, { error: "key is revoked" });
      const { secret } = newInferestKey();
      d.store.rotateKey(id, sha256(secret));
      return send(res, 200, { key: secret, id });
    }
    if (url.pathname === "/api/demo/fund") {
      if (!d.faucet) return send(res, 404, { error: "not found" });
      const address = String(body.address ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address)) return send(res, 400, { error: "address must be 0x plus 40 hex characters" });
      if (caller.kind === "session" && !caller.session.wallets.includes(address)) {
        d.keeper.log(`faucet refused ${address}: the session's verified wallets are [${caller.session.wallets.join(", ")}]`);
        return send(res, 403, { error: "not your wallet" });
      }
      const funded = await d.faucet.fund(address);
      d.keeper.log(`faucet funded ${address}`);
      return send(res, 200, { ok: true, native: funded.native.toString(), usdc: funded.usdc.toString() });
    }
    if (url.pathname === "/api/admin/sync" || url.pathname === "/api/admin/report") {
      const report = url.pathname.endsWith("/report");
      if (caller.kind === "operator" && body.vault === undefined) {
        if (report) await reportAll(d.keeper); else await syncAll(d.keeper);
        return send(res, 200, { ok: true });
      }
      const vault = String(body.vault ?? "").toLowerCase();
      if (!vaultFor(d, res, caller, vault)) return;
      if (report && coolingDown(cooldown, res, caller, "report", vault)) return;
      if (report) await reportVault(d.keeper, vault);
      await syncVault(d.keeper, vault);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/admin/settle") {
      const vault = String(body.vault ?? "").toLowerCase();
      if (!vaultFor(d, res, caller, vault)) return;
      if (coolingDown(cooldown, res, caller, "settle", vault)) return;
      const r = await settleVault(d.keeper, vault);
      return send(res, 200, { usageMicro: r ? r.usage.toString() : null, tx: r ? r.tx : null, pending: r?.pending === true });
    }
    if (url.pathname === "/api/admin/pending/clear") {
      // manual escape hatch for a settlement the operator has confirmed will never mine
      if (caller.kind !== "operator") return send(res, 403, OPERATOR_ONLY);
      const vault = String(body.vault ?? "").toLowerCase();
      const tx = String(body.tx ?? "");
      if (isSettling(vault)) return send(res, 409, { error: "vault is settling" });
      const p = d.store.pendingSettlement(vault);
      if (!p || p.tx !== tx) return send(res, 404, { error: "no such pending settlement" });
      d.keeper.log(`admin clearing pending settlement ${tx} for ${vault} (${p.usageMicro} micro-USD)`);
      d.store.clearPendingSettlement(vault, tx);
      try {
        await syncVault(d.keeper, vault); // reopen the vault now rather than on the next tick
      } catch (e) {
        d.keeper.log(`sync ${vault} after clearing pending settlement failed: ${(e as Error).message}`);
      }
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "not found" });
  }

  // the developer setup page is now the Treasury page's Use a key section
  if (url.pathname === "/setup") { res.writeHead(302, { Location: "/treasury#use-a-key" }); res.end(); return; }
  return serveStatic(res, url.pathname);
}

function sanitizeError(message: string): string {
  return message.replace(/https?:\/\/\S+/gi, "[url]").slice(0, 300);
}

export function createApp(d: AppDeps): Server {
  const cooldown = d.ownerCooldown ? new OwnerCooldown(d.ownerCooldown) : undefined;
  return createServer((req, res) => {
    route(d, req, res, cooldown).catch((e) => {
      if (e instanceof BodyTooLarge && !res.headersSent) return send(res, 413, { error: "request too large" });
      const err = e as Error;
      (d.logError ?? console.error)(err.stack ?? err.message);
      if (res.headersSent) { res.end(); return; }
      send(res, 500, { error: sanitizeError(err.message) });
    });
  });
}
