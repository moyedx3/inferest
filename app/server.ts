import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Params } from "../engine/ledger.ts";
import type { Chain } from "./chain.ts";
import type { OpenRouter } from "./openrouter.ts";
import type { Store } from "./store.ts";
import type { ToolGateway } from "./tools.ts";
import type { Proxy } from "./proxy.ts";
import { buildMcpServer } from "./mcp.ts";
import { computeLimits } from "./limits.ts";
import { sha256, newInferestKey, type SecretBox } from "./crypto.ts";
import { syncAll, syncVault, reportAll, settleVault, markRegistered, isSettling, type KeeperDeps } from "./keeper.ts";

export { sha256 } from "./crypto.ts";

export type AppDeps = {
  store: Store; or: OpenRouter; chain: Chain; gateway: ToolGateway; params: Params;
  adminToken: string; publicConfig: Record<string, unknown>; keeper: KeeperDeps;
  /** Encrypts each vault's OpenRouter key at rest. */
  secrets: SecretBox;
  proxy: Proxy;
};

const DASHBOARD = fileURLToPath(new URL("./dashboard/", import.meta.url));
const ZERO = /^0x0{40}$/i;
const KEY_ROUTE = /^\/api\/keys\/([0-9a-f]{16})\/(weight|revoke|rotate)$/;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function bearer(req: IncomingMessage): string {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

/** The public state: field by field, never a spread of a store row, so a new secret column can never leak. */
function state(d: AppDeps) {
  return {
    config: d.publicConfig,
    vaults: d.store.listVaults().map((v) => {
      const keys = d.store.keysForVault(v.vault);
      const limits = computeLimits(v.yieldUsd, keys, d.params, v.frozen);
      return {
        vault: v.vault, customer: v.customer, label: v.label, period: v.period, frozen: v.frozen, settling: v.settling,
        yieldUsd: v.yieldUsd, orLimit: v.orLimit, orUsage: v.orUsage, hasOpenRouterKey: v.orKeyHash !== null,
        keys: keys.map((k, i) => ({
          id: k.id, name: k.name, weight: k.weight, revoked: k.revoked, createdAt: k.createdAt,
          modelSpent: k.modelSpent, toolSpent: k.toolSpent,
          budget: limits[i].budget, spent: limits[i].spent, remaining: limits[i].remaining,
        })),
      };
    }),
    settlements: d.store.listSettlements(),
    pendingSettlements: d.store.listPendingSettlements().map((p) => ({
      vault: p.vault, usageMicro: p.usageMicro.toString(), tx: p.tx, createdAt: p.createdAt,
    })),
  };
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const file = pathname === "/" ? "index.html" : pathname === "/setup" ? "setup.html" : pathname.slice(1);
  if (!/^[a-z0-9.-]+$/i.test(file)) return send(res, 404, { error: "not found" });
  try {
    const body = await readFile(DASHBOARD + file);
    res.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : "text/html" });
    res.end(body);
  } catch {
    send(res, 404, { error: "not found" });
  }
}

/** Mints the vault's single OpenRouter key (limit 0 until the keeper syncs) and returns it encrypted, filing nothing. */
async function mintCompanyKey(d: AppDeps, vault: string): Promise<{ hash: string; encrypted: string }> {
  const { key, hash } = await d.or.createKey(`inferest:vault:${vault.slice(2, 10)}`, 0);
  return { hash, encrypted: d.secrets.encrypt(key) };
}

async function route(d: AppDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (await d.proxy.handle(req, res)) return;

  if (url.pathname === "/mcp") {
    const key = d.store.keyBySecret(sha256(bearer(req)));
    if (!key || key.revoked) return send(res, 401, { error: "unknown key" });
    const body = req.method === "POST" ? await readJson(req) : undefined;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildMcpServer(d.gateway, key.id);
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  if (url.pathname === "/api/state" && req.method === "GET") return send(res, 200, state(d));

  if (url.pathname.startsWith("/api/")) {
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    if (req.headers["x-admin-token"] !== d.adminToken) return send(res, 401, { error: "admin token required" });
    const body = await readJson(req);

    if (url.pathname === "/api/vaults") {
      const vault = String(body.vault ?? "").toLowerCase();
      const customer = await d.chain.customerOf(vault).catch(() => "");
      if (!customer || ZERO.test(customer)) return send(res, 400, { error: "not a vault from our factory" });
      // the provider key is minted before anything is written, so a provider failure leaves no half-registered
      // vault; a vault whose row already has a key is registered already and is only answered again
      if (!d.store.openRouterKeyFor(vault)) {
        const minted = await mintCompanyKey(d, vault);
        d.store.addVault(vault, customer, String(body.label ?? "customer"));
        markRegistered(d.store, vault); // a vault added mid-month is first settled next month
        d.store.setVaultOpenRouterKey(vault, minted.hash, minted.encrypted);
      }
      return send(res, 201, { vault, customer: customer.toLowerCase() });
    }
    if (url.pathname === "/api/keys") {
      const vault = String(body.vault ?? "").toLowerCase();
      if (!d.store.vault(vault)) return send(res, 404, { error: "unknown vault" });
      const weight = Number(body.weight ?? 1);
      if (!(Number.isFinite(weight) && weight >= 0)) return send(res, 400, { error: "weight must be a finite number >= 0" });
      const name = String(body.name ?? "key");
      const { id, secret } = newInferestKey();
      d.store.addKey({ id, vault, name, weight, secretSha256: sha256(secret) });
      return send(res, 201, { key: secret, id });
    }
    const m = url.pathname.match(KEY_ROUTE);
    if (m) {
      const [, id, action] = m;
      const key = d.store.keyById(id);
      if (!key) return send(res, 404, { error: "unknown key" });
      if (action === "weight") {
        const weight = Number(body.weight);
        if (!(Number.isFinite(weight) && weight >= 0)) return send(res, 400, { error: "weight must be a finite number >= 0" });
        d.store.setWeight(id, weight);
        return send(res, 200, { ok: true });
      }
      if (action === "revoke") {
        d.store.revokeKey(id); // already revoked is fine: the outcome is the same
        return send(res, 200, { ok: true });
      }
      if (key.revoked) return send(res, 409, { error: "key is revoked" });
      const { secret } = newInferestKey();
      d.store.rotateKey(id, sha256(secret));
      return send(res, 200, { key: secret, id });
    }
    if (url.pathname === "/api/admin/sync") { await syncAll(d.keeper); return send(res, 200, { ok: true }); }
    if (url.pathname === "/api/admin/report") { await reportAll(d.keeper); return send(res, 200, { ok: true }); }
    if (url.pathname === "/api/admin/settle") {
      const vault = String(body.vault ?? "").toLowerCase();
      if (!d.store.vault(vault)) return send(res, 404, { error: "unknown vault" });
      const r = await settleVault(d.keeper, vault);
      return send(res, 200, { usageMicro: r ? r.usage.toString() : null, tx: r ? r.tx : null, pending: r?.pending === true });
    }
    if (url.pathname === "/api/admin/pending/clear") {
      // manual escape hatch for a settlement the operator has confirmed will never mine
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

  return serveStatic(res, url.pathname);
}

function sanitizeError(message: string): string {
  return message.replace(/https?:\/\/\S+/gi, "[url]").slice(0, 300);
}

export function createApp(d: AppDeps): Server {
  return createServer((req, res) => {
    route(d, req, res).catch((e) => {
      const err = e as Error;
      console.error(err.stack ?? err.message);
      if (res.headersSent) { res.end(); return; }
      send(res, 500, { error: sanitizeError(err.message) });
    });
  });
}
