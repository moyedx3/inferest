import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createHash } from "node:crypto";
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
import { syncAll, reportAll, settleVault, type KeeperDeps } from "./keeper.ts";

export type AppDeps = {
  store: Store; or: OpenRouter; chain: Chain; gateway: ToolGateway; params: Params;
  adminToken: string; publicConfig: Record<string, unknown>; keeper: KeeperDeps;
};

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

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
    const w = url.pathname.match(/^\/api\/keys\/([^/]+)\/weight$/);
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
      return send(res, 200, { usageMicro: r ? r.usage.toString() : null, tx: r ? r.tx : null });
    }
    return send(res, 404, { error: "not found" });
  }

  return serveStatic(res, url.pathname);
}

function sanitizeError(message: string): string {
  return message.replace(/https?:\/\/\S+/g, "[url]").slice(0, 300);
}

export function createApp(d: AppDeps): Server {
  return createServer((req, res) => {
    route(d, req, res).catch((e) => {
      const err = e as Error;
      console.error(err.message, err.stack);
      if (res.headersSent) { res.end(); return; }
      send(res, 500, { error: sanitizeError(err.message) });
    });
  });
}
