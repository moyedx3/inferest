import type { IncomingMessage, ServerResponse } from "node:http";
import type { Params } from "../engine/ledger.ts";
import type { Store, KeyRow } from "./store.ts";
import { computeLimits } from "./limits.ts";
import { sha256 } from "./crypto.ts";

export type ProxyDeps = {
  store: Store;
  params: Params;
  /** Decrypts a vault's OpenRouter key secret (secretBox(KEY_ENCRYPTION_KEY).decrypt in production). */
  decrypt: (encrypted: string) => string;
  fetchFn: typeof fetch;
  /** The provider's API base (default OpenRouter). */
  upstream?: string;
  /** Where a developer looks when a key is out of budget; printed in 402 messages. */
  dashboardUrl: string;
  log: (msg: string) => void;
};

export type Proxy = {
  /** Serves /v1/* requests. Resolves false, having touched nothing, for any other path. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** Waits up to ms for the vault's in-flight requests to finish metering. */
  drain(vault: string, ms: number): Promise<void>;
  /** Requests of the vault still in flight. */
  inFlight(vault: string): number;
};

export const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const DEFAULT_UPSTREAM = "https://openrouter.ai/api/v1";
/** Upstream response headers relayed to the client; the rest, which name the provider, are dropped. */
const RELAYED_HEADERS = ["content-type", "cache-control"];
/** The provider's answer when the company key's limit (our backstop) is hit before the sync caught up. */
const KEY_LIMIT = /key limit exceeded/i;

class BodyTooLarge extends Error {}

/** Every error the proxy makes itself is in the OpenAI shape, so SDKs surface the message. */
export function fail(res: ServerResponse, status: number, type: string, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ error: { message, type, code: status } }));
}

function bearer(req: IncomingMessage): string {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

/** Reads the body up to the cap. Past it, rejects at once and keeps draining, so the 413 can still be delivered. */
function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      if (size > max) return;
      size += c.length;
      if (size > max) reject(new BodyTooLarge());
      else chunks.push(c);
    });
    req.on("end", () => { if (size <= max) resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}

function relayHeaders(up: Response): Record<string, string> {
  const h: Record<string, string> = {};
  for (const name of RELAYED_HEADERS) {
    const v = up.headers.get(name);
    if (v) h[name] = v;
  }
  return h;
}

export type Budget = { ok: true; remaining: number } | { ok: false; status: 402 | 503; type: string; message: string };

/** The key's open budget this period, or why it has none. A store read: microseconds, no network. */
export function checkBudget(store: Store, params: Params, key: KeyRow, dashboardUrl: string): Budget {
  const vault = store.vault(key.vault);
  if (!vault) return { ok: false, status: 402, type: "insufficient_quota", message: `this key's vault is not registered. See ${dashboardUrl}` };
  if (vault.settling || store.pendingSettlement(vault.vault)) {
    return { ok: false, status: 503, type: "server_error", message: "settlement in progress for this key's vault; retry in a minute" };
  }
  if (vault.frozen) {
    return {
      ok: false, status: 402, type: "insufficient_quota",
      message: `this key's vault is frozen while a loss on the yield source is pending; $0.00 of budget is open until the next report. See ${dashboardUrl}`,
    };
  }
  const l = computeLimits(vault.yieldUsd, store.keysForVault(vault.vault), params, vault.frozen).find((x) => x.id === key.id);
  const remaining = l?.remaining ?? 0;
  if (!(remaining > 0)) {
    return { ok: false, status: 402, type: "insufficient_quota", message: `key budget used up: $${remaining.toFixed(2)} of this period's yield remains. See ${dashboardUrl}` };
  }
  return { ok: true, remaining };
}

export function createProxy(d: ProxyDeps): Proxy {
  const upstream = (d.upstream ?? DEFAULT_UPSTREAM).replace(/\/+$/, "");
  const inFlight = new Map<string, Set<Promise<void>>>();

  /** Registers a request under its vault until it has finished (metering included). */
  function track(vault: string, p: Promise<void>): void {
    let set = inFlight.get(vault);
    if (!set) {
      set = new Set();
      inFlight.set(vault, set);
    }
    const s = set;
    s.add(p);
    void p.catch(() => {}).finally(() => {
      s.delete(p);
      if (s.size === 0 && inFlight.get(vault) === s) inFlight.delete(vault);
    });
  }

  /** One row per call; a call whose cost did not arrive is filed pending for the keeper to resolve. */
  function record(key: KeyRow, model: string, generationId: string, costUsd: number | undefined, status: number, started: number): void {
    const ms = Date.now() - started;
    if (costUsd === undefined) {
      d.store.recordPendingModelCall({ keyId: key.id, model, generationId });
      d.log(`proxy key ${key.id} model ${model} gen ${generationId} cost pending ${ms}ms ${status}`);
    } else {
      d.store.recordModelCall({ keyId: key.id, model, costUsd, generationId });
      d.log(`proxy key ${key.id} model ${model} gen ${generationId} cost $${costUsd} ${ms}ms ${status}`);
    }
  }

  async function relayModels(res: ServerResponse): Promise<void> {
    let up: Response;
    try {
      up = await d.fetchFn(`${upstream}/models`);
    } catch (e) {
      d.log(`proxy models upstream unreachable: ${(e as Error).message}`);
      return fail(res, 502, "upstream_error", "could not reach the model provider");
    }
    res.writeHead(up.status, relayHeaders(up));
    res.end(Buffer.from(await up.arrayBuffer()));
  }

  /** Relays an upstream 4xx or 5xx as is, except that the company key's limit becomes our 402. */
  async function relayError(res: ServerResponse, up: Response, key: KeyRow, model: string, started: number): Promise<void> {
    const text = await up.text();
    d.log(`proxy key ${key.id} model ${model} upstream ${up.status} ${Date.now() - started}ms`);
    if (up.status === 403 && KEY_LIMIT.test(text)) {
      return fail(res, 402, "insufficient_quota", `the vault's provider limit was reached ahead of the budget sync; retry in a minute. See ${d.dashboardUrl}`);
    }
    res.writeHead(up.status, { "Content-Type": up.headers.get("content-type") ?? "application/json" });
    res.end(text);
  }

  /** Non-streaming: relay the JSON body untouched and meter from its usage object. */
  async function relayJson(res: ServerResponse, up: Response, key: KeyRow, model: string, started: number): Promise<void> {
    const text = await up.text();
    res.writeHead(up.status, relayHeaders(up));
    res.end(text);
    let j: any;
    try { j = JSON.parse(text); } catch { j = undefined; }
    const generationId = typeof j?.id === "string" ? j.id : "";
    if (!generationId) {
      d.log(`proxy key ${key.id} model ${model} response without a generation id: nothing to meter`);
      return;
    }
    const cost = typeof j?.usage?.cost === "number" ? j.usage.cost : undefined;
    record(key, typeof j?.model === "string" ? j.model : model, generationId, cost, up.status, started);
  }

  /**
   * Streaming: relay every SSE event byte for byte while parsing the data lines for the generation id and the
   * usage event. The upstream stream is read to its end even after the client has gone, because the provider
   * bills the whole generation regardless. A stream that breaks before the cost arrives leaves a pending row
   * for the generation id seen in the first event, which the keeper resolves through the generation lookup.
   */
  async function relayStream(res: ServerResponse, up: Response, key: KeyRow, model: string, started: number): Promise<void> {
    res.writeHead(up.status, { ...relayHeaders(up), "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    let clientGone = false;
    res.on("close", () => { clientGone = true; }); // fires early only if the client left; otherwise after end()
    let generationId = "";
    let usedModel = model;
    let cost: number | undefined;
    let buffer = "";
    const consume = (text: string) => {
      buffer += text.replace(/\r\n/g, "\n");
      let i: number;
      while ((i = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const j = JSON.parse(data);
            if (!generationId && typeof j?.id === "string") generationId = j.id;
            if (typeof j?.model === "string") usedModel = j.model;
            if (typeof j?.usage?.cost === "number") cost = j.usage.cost;
          } catch {
            // a partial or non-JSON data line is the provider's business; it is relayed regardless
          }
        }
      }
    };
    let broken: Error | undefined;
    if (!up.body) {
      broken = new Error("empty upstream body");
    } else {
      const reader = up.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!clientGone && !res.destroyed) res.write(value);
          consume(decoder.decode(value, { stream: true }));
        }
        consume(decoder.decode());
      } catch (e) {
        broken = e as Error;
      }
    }
    if (!clientGone && !res.destroyed) res.end();
    if (!generationId) {
      d.log(`proxy key ${key.id} model ${model} stream without a generation id: nothing to meter${broken ? ` (${broken.message})` : ""}`);
      return;
    }
    if (cost === undefined && broken) d.log(`proxy key ${key.id} model ${usedModel} gen ${generationId} stream broke before usage: ${broken.message}`);
    record(key, usedModel, generationId, cost, up.status, started);
  }

  /** Forwards a checked request with the company key and relays the answer. Runs tracked, so drain() can wait on it. */
  async function forward(res: ServerResponse, body: any, key: KeyRow, apiKey: string): Promise<void> {
    const model = String(body.model ?? "");
    const streaming = body.stream === true;
    const started = Date.now();
    let up: Response;
    try {
      up = await d.fetchFn(`${upstream}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: streaming ? "text/event-stream" : "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      d.log(`proxy key ${key.id} model ${model} upstream unreachable: ${(e as Error).message}`);
      return fail(res, 502, "upstream_error", "could not reach the model provider");
    }
    if (!up.ok) return relayError(res, up, key, model, started);
    if (streaming && (up.headers.get("content-type") ?? "").includes("text/event-stream")) return relayStream(res, up, key, model, started);
    return relayJson(res, up, key, model, started);
  }

  async function completions(req: IncomingMessage, res: ServerResponse, key: KeyRow): Promise<void> {
    if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) return fail(res, 413, "invalid_request_error", "request body over 4 MB");
    let raw: string;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch (e) {
      if (e instanceof BodyTooLarge) return fail(res, 413, "invalid_request_error", "request body over 4 MB");
      throw e;
    }
    let body: any;
    try { body = JSON.parse(raw); } catch { body = undefined; }
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail(res, 400, "invalid_request_error", "request body must be a JSON object");
    const budget = checkBudget(d.store, d.params, key, d.dashboardUrl);
    if (!budget.ok) return fail(res, budget.status, budget.type, budget.message, budget.status === 503 ? { "Retry-After": "15" } : {});
    const orKey = d.store.openRouterKeyFor(key.vault);
    if (!orKey) {
      d.log(`proxy key ${key.id}: vault ${key.vault} has no OpenRouter key on file`);
      return fail(res, 503, "server_error", "this key's vault has no provider key yet; ask the admin to re-register it");
    }
    body.usage = { ...(body.usage && typeof body.usage === "object" && !Array.isArray(body.usage) ? body.usage : {}), include: true };
    const work = forward(res, body, key, d.decrypt(orKey.encryptedSecret));
    track(key.vault, work);
    await work;
  }

  return {
    async handle(req, res) {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/v1/")) return false;
      const key = d.store.keyBySecret(sha256(bearer(req)));
      if (!key || key.revoked) {
        fail(res, 401, "authentication_error", "unknown or revoked Inferest key; send it as Authorization: Bearer sk-inf-...");
        return true;
      }
      try {
        if (url.pathname === "/v1/models" && req.method === "GET") await relayModels(res);
        else if (url.pathname === "/v1/chat/completions" && req.method === "POST") await completions(req, res, key);
        else fail(res, 404, "invalid_request_error", "only POST /v1/chat/completions and GET /v1/models are served");
      } catch (e) {
        d.log(`proxy key ${key.id} failed: ${(e as Error).message}`);
        if (!res.headersSent) fail(res, 500, "server_error", "internal error");
        else if (!res.writableEnded) res.end();
      }
      return true;
    },
    async drain(vault, ms) {
      const set = inFlight.get(vault.toLowerCase());
      if (!set || set.size === 0) return;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((r) => { timer = setTimeout(r, ms); });
      try {
        await Promise.race([Promise.allSettled([...set]), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    inFlight(vault) {
      return inFlight.get(vault.toLowerCase())?.size ?? 0;
    },
  };
}
