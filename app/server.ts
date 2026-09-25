import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { sha256 } from "./crypto.ts";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Params } from "../engine/ledger.ts";
import type { Chain } from "./chain.ts";
import type { OpenRouter } from "./openrouter.ts";
import type { Store } from "./store.ts";
import type { ToolGateway } from "./tools.ts";
import { buildMcpServer } from "./mcp.ts";
import { computeLimits } from "./limits.ts";
import { syncAll, syncVault, reportAll, settleVault, markRegistered, isSettling, type KeeperDeps } from "./keeper.ts";

export type AppDeps = {
  store: Store; or: OpenRouter; chain: Chain; gateway: ToolGateway; params: Params;
  adminToken: string; publicConfig: Record<string, unknown>; keeper: KeeperDeps;
};

export { sha256 } from "./crypto.ts";

const DASHBOARD = fileURLToPath(new URL("./dashboard/", import.meta.url));
const ZERO = /^0x0{40}$/i;

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

function state(d: AppDeps) {
  return {
    config: d.publicConfig,
    vaults: d.store.listVaults().map((v) => {
      const keys = d.store.keysForVault(v.vault);
      const limits = computeLimits(v.yieldUsd, keys, d.params, v.frozen);
      return {
        ...v,
        keys: keys.map((k, i) => ({
          hash: k.hash, name: k.name, weight: k.weight, toolSpent: k.toolSpent,
          budget: limits[i].budget, spent: limits[i].spent, remaining: limits[i].remaining, limit: limits[i].limit,
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
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!/^[a-z0-9.-]+$/i.test(file)) return send(res, 404, { error: "not found" });
  try {
    const body = await readFile(DASHBOARD + file);
    res.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : "text/html" });
    res.end(body);
  } catch {
    send(res, 404, { error: "not found" });
  }
}

async function route(d: AppDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/mcp") {
    const key = d.store.keyBySecret(sha256(bearer(req)));
    if (!key) return send(res, 401, { error: "unknown key" });
    const body = req.method === "POST" ? await readJson(req) : undefined;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildMcpServer(d.gateway, key.hash);
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
      d.store.addVault(vault, customer, String(body.label ?? "customer"));
      markRegistered(d.store, vault); // a vault added mid-month is first settled next month
      return send(res, 201, { vault, customer: customer.toLowerCase() });
    }
    if (url.pathname === "/api/keys") {
      const vault = String(body.vault ?? "").toLowerCase();
      if (!d.store.vault(vault)) return send(res, 404, { error: "unknown vault" });
      const weight = Number(body.weight ?? 1);
      if (!(weight >= 0)) return send(res, 400, { error: "weight must be >= 0" });
      const name = String(body.name ?? "key");
      const { key, hash } = await d.or.createKey(`inferest:${name}`, 0);
      d.store.addKey({ hash, vault, name, weight, secretSha256: sha256(key) });
      return send(res, 201, { key, hash });
    }
    const w = url.pathname.match(/^\/api\/keys\/([0-9a-zA-Z]+)\/weight$/);
    if (w) {
      if (!d.store.keyByHash(w[1])) return send(res, 404, { error: "unknown key" });
      const weight = Number(body.weight);
      if (!(weight >= 0)) return send(res, 400, { error: "weight must be >= 0" });
      d.store.setWeight(w[1], weight);
      return send(res, 200, { ok: true });
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
        await syncVault(d.keeper, vault); // reopen the keys now rather than on the next tick
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
