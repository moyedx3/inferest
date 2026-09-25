# Inference Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Developers and agents call `POST /v1/chat/completions` on the Inferest server with an Inferest key (`sk-inf-...`); the server checks the key's remaining yield budget, forwards to OpenRouter with the company vault's single OpenRouter key, streams the answer back and records the cost against the key.

**Architecture:** One new module, `app/proxy.ts`, does auth, budget check, forwarding, stream relay and cost capture; `app/server.ts` mounts it. The store moves to schema version 3: Inferest keys carry a random `id` and a secret hash, spend is our own `model_calls` and `tool_calls` rows per period, and each vault holds one encrypted OpenRouter key. The keeper keeps that company key's OpenRouter limit at `usage + Σ remaining` as a backstop, freezes in both layers, waits for in-flight metering before settling, resolves pending metering rows through OpenRouter's generation lookup, and logs daily drift.

**Tech Stack:** Node 26 native TypeScript (erasable syntax only, `.ts` imports), `node:test`, `node:sqlite`, `node:crypto` (AES-256-GCM), `node:http`; OpenRouter chat completions and Management API; existing viem, MCP SDK and x402 packages untouched.

**Spec:** [`docs/superpowers/specs/2026-09-25-inference-proxy-design.md`](../specs/2026-09-25-inference-proxy-design.md). The spec is the authority; this plan is its argument. Read both.

## Global Constraints

- Node >= 22.6 (development machine runs 26.4). TypeScript must be **erasable syntax only**: no `enum`, no `namespace`, no constructor parameter properties. Relative imports carry the `.ts` extension. Type-only imports use `import type` or inline `type`.
- Verification for every task: `npm test` (node:test over `engine/*.test.ts app/test/*.test.ts`) and `npm run typecheck` (`tsc --noEmit`, must print nothing). Tasks 3 and 4 are the exception named in their text: the keeper and server suites are red between Task 3 and the end of Task 5, and those three tasks share one branch.
- **No hackathon or event names** in any committed file, commit message or branch name. The generic word "hackathon" and the identifier `HACKATHON_PARAMS` are allowed.
- English prose: no em dashes, American spelling.
- Never read `.env`. Never commit `.env.anvil`, `inferest.db`, `.obsidian/workspace.json` or `contracts/deployments/42161.json`. Stage files by name, never `git add -A`.
- Secrets: the `sk-inf-...` secret is returned exactly once (create and rotate) and stored only as a SHA-256 hash. The company OpenRouter key is stored AES-256-GCM encrypted under `KEY_ENCRYPTION_KEY` (64 hex characters) and never returned by any route. No prompt content and no secret ever reaches a log line.
- Error shape on `/v1/*`: `{ "error": { "message": string, "type": string, "code": number } }`. 401 `authentication_error`, 402 `insufficient_quota`, 413 `invalid_request_error`, 502 `upstream_error`, 503 `server_error`.
- Request body cap on the proxy: 4 MB (`4 * 1024 * 1024` bytes).
- Keeper cadence unchanged: sync every minute, `report()` daily (drift check rides with it), `settle()` monthly. Settlement waits at most 10 s (`drainMs`, default `10_000`) for in-flight metering.
- Money units: model cost and yield are USD floats; tool spend is USDC floats; on-chain amounts are USDC base units (`bigint`, 6 decimals). `HACKATHON_PARAMS` has `railFee = 0`.
- Branch per task: `proxy-<slug>` off `main`, reviewed by a fresh subagent, merged with `git merge --no-ff` only when the review is clean. Tasks 3, 4 and 5 share the branch `proxy-key-model` and merge together after Task 5's review.
- End every commit message with:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_017pfxD343MHfruJDutYH1Qy`
- If `git` prints `xcrun: error ... SDK "macosx" cannot be located`, run `/usr/bin/git` instead.

## Review Focus

1. **A revoked key on the MCP endpoint.** The spec says revocation is immediate and that the same key authenticates to the tools endpoint, so `/mcp` must refuse a revoked bearer too, not only `/v1/*`. Test: Task 5 `MCP rejects a revoked key`.
2. **Two concurrent requests on the last dollar.** The budget check is local and happens before the call, so two requests can both pass and both meter; the overshoot must be bounded by one request per key, never unbounded. Test: Task 6 `two requests that both pass the check both meter, and the third is refused`.
3. **An upstream response with `usage` but no `cost`.** OpenRouter sends `usage.cost` only when `usage.include` is set; a proxy that forwards a client body which already carries `usage: { include: false }` would lose metering. Expected: the proxy always sets `include: true`, and a response without a cost still leaves a pending row keyed by generation id. Tests: Task 6 `usage.include is forced on even when the client sets it false` and `a response without a cost leaves a pending row`.
4. **A generation id that never resolves.** A pending row whose lookup keeps returning 404 must not block the tick, must not be counted twice and must be surfaced after a day. Tests: Task 4 `a pending model call unresolved for a day is logged, not dropped`, Task 3 `recording a model call twice with the same generation id counts once`.
5. **A body that is not JSON, or exceeds 4 MB.** Expected: 400 or 413 in OpenAI error shape before anything is forwarded, so a malformed client cannot spend or crash the process. Tests: Task 6 `a non-JSON body is refused with 400 before forwarding` and `a body over 4 MB is refused with 413 before forwarding`.

---

## File Structure

```
app/crypto.ts                 NEW   sha256, AES-256-GCM secret box, Inferest key generation
app/config.ts                 MOD   KEY_ENCRYPTION_KEY (required), PUBLIC_URL
app/openrouter.ts             MOD   deleteKey, getGeneration
app/store.ts                  MOD   schema 3: keys by id, model_calls, vault OpenRouter key, settling flag
app/limits.ts                 MOD   inputs are metered spend; companyLimit
app/keeper.ts                 MOD   one OpenRouter key per vault, freeze, drain before settle, pending rows, drift
app/proxy.ts                  NEW   /v1/chat/completions and /v1/models: auth, budget, relay, metering
app/server.ts                 MOD   mounts proxy; key create/revoke/rotate; company key on vault registration; /setup
app/mcp.ts                    MOD   keyId instead of keyHash (rename)
app/cli.ts                    MOD   wires crypto, proxy, keeper drain
app/dashboard/index.html      MOD   setup panel markup, per-key buttons
app/dashboard/app.js          MOD   panel, revoke/rotate, backstop figure
app/dashboard/snippets.js     NEW   snippet text shared by the panel and /setup
app/dashboard/setup.html      NEW   GET /setup
app/test/crypto.test.ts       NEW
app/test/proxy.test.ts        NEW
app/test/*.test.ts            MOD   config, openrouter, store, limits, keeper, server adapted
demo/lib.ts                   MOD   chat() targets the Inferest server
demo/treasury.ts, agent.ts    MOD   key id instead of hash
README.md, docs/06-workflow.md, deck/outline.md, .env.example   MOD
```

Every task below runs from the repository root `~/inferest`.

---

### Task 1: Secrets: encryption, Inferest key generation, config

**Branch:** `proxy-secrets`

**Files:**
- Create: `app/crypto.ts`
- Create: `app/test/crypto.test.ts`
- Modify: `app/config.ts`
- Modify: `app/test/config.test.ts`
- Modify: `app/server.ts:20` (sha256 moves to crypto.ts and is re-exported)
- Modify: `.env.example`

**Interfaces:**
- Produces: `sha256(s: string): string`; `encryptSecret(plain: string, keyHex: string): string`; `decryptSecret(enc: string, keyHex: string): string`; `newInferestKey(): { id: string; secret: string }`; `type SecretBox = { encrypt(plain: string): string; decrypt(enc: string): string }`; `secretBox(keyHex: string): SecretBox`; `Config.keyEncryptionKey: string`; `Config.publicUrl: string`.

- [ ] **Step 1: Write the failing tests**

Create `app/test/crypto.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256, encryptSecret, decryptSecret, newInferestKey, secretBox } from "../crypto.ts";

const KEY = "00".repeat(31) + "01";

test("sha256 is hex of the utf8 input", () => {
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("a secret round-trips and the ciphertext does not contain it", () => {
  const enc = encryptSecret("sk-or-v1-company", KEY);
  assert.ok(enc.startsWith("v1."));
  assert.ok(!enc.includes("company"));
  assert.equal(decryptSecret(enc, KEY), "sk-or-v1-company");
});

test("two encryptions of the same secret differ", () => {
  assert.notEqual(encryptSecret("x", KEY), encryptSecret("x", KEY));
});

test("a wrong key or a tampered ciphertext is refused", () => {
  const enc = encryptSecret("x", KEY);
  assert.throws(() => decryptSecret(enc, "00".repeat(31) + "02"));
  const [v, iv, tag, body] = enc.split(".");
  const flipped = body[0] === "A" ? "B" : "A";
  assert.throws(() => decryptSecret([v, iv, tag, flipped + body.slice(1)].join("."), KEY));
  assert.throws(() => decryptSecret("nonsense", KEY), /malformed/);
});

test("a key that is not 64 hex characters is refused", () => {
  assert.throws(() => encryptSecret("x", "abc"), /64 hex/);
  assert.throws(() => secretBox("abc"), /64 hex/);
});

test("newInferestKey makes an sk-inf secret and a separate id", () => {
  const a = newInferestKey();
  const b = newInferestKey();
  assert.match(a.secret, /^sk-inf-[A-Za-z0-9_-]{32}$/);
  assert.match(a.id, /^[0-9a-f]{16}$/);
  assert.notEqual(a.secret, b.secret);
  assert.notEqual(a.id, b.id);
  assert.ok(!a.secret.includes(a.id));
});

test("secretBox binds the key", () => {
  const box = secretBox(KEY);
  assert.equal(box.decrypt(box.encrypt("hello")), "hello");
});
```

Add to `app/test/config.test.ts`, inside `envFor`'s returned object, the two keys `KEY_ENCRYPTION_KEY: "ab".repeat(32), PORT: "8787"` so it reads:

```ts
  return {
    CHAIN_CONFIG: chainPath, DEPLOYMENTS: depPath, RPC_URL: "http://localhost:8545",
    KEEPER_PRIVATE_KEY: "0x05", OPENROUTER_MANAGEMENT_KEY: "or", ADMIN_TOKEN: "admin",
    KEY_ENCRYPTION_KEY: "ab".repeat(32), PORT: "8787",
  };
```

and append these tests:

```ts
test("refuses to start without a key encryption key", () => {
  const env = envFor(42161, 42161);
  delete env.KEY_ENCRYPTION_KEY;
  assert.throws(() => loadConfig(env), /missing env KEY_ENCRYPTION_KEY/);
});

test("refuses a key encryption key that is not 64 hex characters", () => {
  assert.throws(() => loadConfig({ ...envFor(42161, 42161), KEY_ENCRYPTION_KEY: "abc" }), /64 hex/);
});

test("public url defaults to localhost on the port", () => {
  assert.equal(loadConfig(envFor(42161, 42161)).publicUrl, "http://localhost:8787");
  assert.equal(loadConfig({ ...envFor(42161, 42161), PUBLIC_URL: "https://inferest.example/" }).publicUrl, "https://inferest.example");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test app/test/crypto.test.ts app/test/config.test.ts`
Expected: crypto tests fail with `Cannot find module '../crypto.ts'`; the three new config tests fail (missing `keyEncryptionKey` handling, `publicUrl` undefined).

- [ ] **Step 3: Write `app/crypto.ts`**

```ts
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

function keyBytes(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("KEY_ENCRYPTION_KEY must be 32 bytes as 64 hex characters");
  return Buffer.from(hex, "hex");
}

/** AES-256-GCM. Output is "v1.<iv>.<tag>.<ciphertext>", each part base64url: one line, safe for a text column. */
export function encryptSecret(plain: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(keyHex), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function decryptSecret(enc: string, keyHex: string): string {
  const [v, iv, tag, body] = enc.split(".");
  if (v !== "v1" || !iv || !tag || body === undefined) throw new Error("malformed encrypted secret");
  const d = createDecipheriv("aes-256-gcm", keyBytes(keyHex), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
}

/** A fresh Inferest key: the secret the developer sees once, and the id we file it under. */
export function newInferestKey(): { id: string; secret: string } {
  return { id: randomBytes(8).toString("hex"), secret: `sk-inf-${randomBytes(24).toString("base64url")}` };
}

export type SecretBox = { encrypt(plain: string): string; decrypt(enc: string): string };

/** Binds the environment key once, so callers never carry key material around. */
export function secretBox(keyHex: string): SecretBox {
  keyBytes(keyHex);
  return { encrypt: (p) => encryptSecret(p, keyHex), decrypt: (e) => decryptSecret(e, keyHex) };
}
```

- [ ] **Step 4: Update `app/config.ts`**

Add to the `Config` type, after `adminToken: string;`:

```ts
  keyEncryptionKey: string; publicUrl: string;
```

In `loadConfig`, after the `railFee` check and before `return {`, add:

```ts
  const keyEncryptionKey = need("KEY_ENCRYPTION_KEY");
  if (!/^[0-9a-f]{64}$/i.test(keyEncryptionKey)) throw new Error("KEY_ENCRYPTION_KEY must be 32 bytes as 64 hex characters");
  const port = Number(env.PORT ?? 8787);
```

Replace `port: Number(env.PORT ?? 8787),` in the returned object with:

```ts
    port,
    keyEncryptionKey,
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
```

- [ ] **Step 5: Move `sha256` in `app/server.ts`**

Replace the line `export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");` with:

```ts
export { sha256 } from "./crypto.ts";
```

Change the second import line of `app/server.ts` from `import { createHash } from "node:crypto";` to `import { sha256 } from "./crypto.ts";` (the file still calls `sha256` in the `/mcp` and `/api/keys` handlers).

- [ ] **Step 6: Update `.env.example`**

After the `ADMIN_TOKEN=` line add:

```
# 32 random bytes as hex, encrypts each vault's OpenRouter key at rest: openssl rand -hex 32
KEY_ENCRYPTION_KEY=
# base URL developers reach the server on; printed in 402 messages and setup snippets
PUBLIC_URL=http://localhost:8787
```

- [ ] **Step 7: Run the tests and the typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass (the previous 106 plus the new 10); tsc prints nothing.

Add `KEY_ENCRYPTION_KEY=<output of openssl rand -hex 32>` to the git-ignored `.env.anvil` so the local server still starts. Do not commit that file.

- [ ] **Step 8: Commit**

```bash
git add app/crypto.ts app/test/crypto.test.ts app/config.ts app/test/config.test.ts app/server.ts .env.example
git commit -m "Add secret encryption, Inferest key generation and the key encryption config"
```

---

### Task 2: OpenRouter client: delete a key, look up a generation

**Branch:** `proxy-openrouter-client`

**Files:**
- Modify: `app/openrouter.ts`
- Modify: `app/test/openrouter.test.ts`
- Modify: `app/test/keeper.test.ts:35-45` (the `or` fake gains the two new methods)
- Modify: `app/test/server.test.ts:16-20` (same)

**Interfaces:**
- Produces: `type Generation = { id: string; model: string; totalCost: number }`; `OpenRouter.deleteKey(hash: string): Promise<void>`; `OpenRouter.getGeneration(id: string, apiKey: string): Promise<Generation | undefined>` (undefined on 404; the bearer is the company's OpenRouter API key, not the management key, because the generation endpoint is scoped to the key that made the call).

- [ ] **Step 1: Write the failing tests**

Append to `app/test/openrouter.test.ts`:

```ts
test("deleteKey deletes the key", async () => {
  const f = fakeFetch([{ data: {} }]);
  await openRouter("m", f.fn).deleteKey("h1");
  assert.equal(f.calls[0].url, "https://openrouter.ai/api/v1/keys/h1");
  assert.equal(f.calls[0].init.method, "DELETE");
});

test("getGeneration reads the cost with the company key as bearer", async () => {
  const f = fakeFetch([{ data: { id: "gen-1", model: "openai/gpt-4o-mini", total_cost: 0.00123, tokens_prompt: 10 } }]);
  const g = await openRouter("m", f.fn).getGeneration("gen-1", "sk-or-v1-company");
  assert.deepEqual(g, { id: "gen-1", model: "openai/gpt-4o-mini", totalCost: 0.00123 });
  assert.equal(f.calls[0].url, "https://openrouter.ai/api/v1/generation?id=gen-1");
  assert.equal(f.calls[0].init.method, "GET");
  assert.equal((f.calls[0].init.headers as Record<string, string>).Authorization, "Bearer sk-or-v1-company");
});

test("getGeneration returns undefined when OpenRouter does not know the id yet", async () => {
  const fn = (async () => new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 })) as unknown as typeof fetch;
  assert.equal(await openRouter("m", fn).getGeneration("gen-x", "k"), undefined);
});

test("getGeneration throws on other failures", async () => {
  const fn = (async () => new Response("down", { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(openRouter("m", fn).getGeneration("gen-x", "k"), /500/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test app/test/openrouter.test.ts`
Expected: the four new tests fail with `deleteKey is not a function` and `getGeneration is not a function`.

- [ ] **Step 3: Extend `app/openrouter.ts`**

Replace the whole file with:

```ts
export type OrKey = { hash: string; usage: number; limit: number | null; disabled: boolean };
/** One completed request as OpenRouter accounts for it. */
export type Generation = { id: string; model: string; totalCost: number };
export type OpenRouter = {
  createKey(name: string, limit: number): Promise<{ key: string; hash: string }>;
  getKey(hash: string): Promise<OrKey>;
  setLimit(hash: string, limit: number): Promise<void>;
  deleteKey(hash: string): Promise<void>;
  /** Cost of one generation, read with the API key that made it. Undefined while OpenRouter has not indexed it. */
  getGeneration(id: string, apiKey: string): Promise<Generation | undefined>;
};

export function openRouter(managementKey: string, fetchFn: typeof fetch = fetch, base = "https://openrouter.ai/api/v1"): OpenRouter {
  async function request(method: string, path: string, bearer: string, body?: unknown): Promise<Response> {
    return fetchFn(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await request(method, path, managementKey, body);
    if (!res.ok) throw new Error(`OpenRouter ${method} ${path} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
  const toKey = (d: any): OrKey => ({
    hash: String(d.hash), usage: Number(d.usage ?? 0), limit: d.limit ?? null, disabled: Boolean(d.disabled),
  });
  return {
    async createKey(name, limit) {
      const r = await call("POST", "/keys", { name, limit, include_byok_in_limit: true });
      return { key: String(r.key), hash: String(r.data.hash) };
    },
    async getKey(hash) {
      return toKey((await call("GET", `/keys/${hash}`)).data);
    },
    async setLimit(hash, limit) {
      await call("PATCH", `/keys/${hash}`, { limit });
    },
    async deleteKey(hash) {
      await call("DELETE", `/keys/${hash}`);
    },
    async getGeneration(id, apiKey) {
      const res = await request("GET", `/generation?id=${encodeURIComponent(id)}`, apiKey);
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`OpenRouter GET /generation failed: ${res.status} ${await res.text()}`);
      const d = (await res.json()).data ?? {};
      return { id: String(d.id ?? id), model: String(d.model ?? ""), totalCost: Number(d.total_cost ?? 0) };
    },
  };
}
```

- [ ] **Step 4: Extend the fakes so the typecheck passes**

In `app/test/keeper.test.ts`, inside the `const or: OpenRouter = { ... }` literal, after the `setLimit` line add:

```ts
    deleteKey: async () => {},
    getGeneration: async () => undefined,
```

In `app/test/server.test.ts`, inside the `or: { ... }` literal of `start()`, after the `setLimit: async () => {},` line add:

```ts
      deleteKey: async () => {},
      getGeneration: async () => undefined,
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass; tsc prints nothing.

- [ ] **Step 6: Commit**

```bash
git add app/openrouter.ts app/test/openrouter.test.ts app/test/keeper.test.ts app/test/server.test.ts
git commit -m "OpenRouter client: delete a key and look up a generation's cost"
```

---

### Task 3: Store schema 3 and the budget math on metered spend

**Branch:** `proxy-key-model` (shared with Tasks 4 and 5; merged after Task 5's review). After this task `app/test/keeper.test.ts` and `app/test/server.test.ts` fail at runtime because they still use the old key shape; that is expected and is repaired by Tasks 4 and 5. Verify this task with the store and limits suites plus the typecheck of the two files.

**Files:**
- Modify: `app/store.ts` (whole file)
- Modify: `app/limits.ts` (whole file)
- Modify: `app/test/store.test.ts` (whole file)
- Modify: `app/test/limits.test.ts` (whole file)

**Interfaces:**
- Consumes: nothing new.
- Produces (store): `VaultRow { vault, customer, label, period, frozen, yieldUsd, settling: boolean, orKeyHash: string | null, orLimit: number, orUsage: number }`; `KeyRow { id, vault, name, weight, createdAt, revoked: boolean, modelSpent, toolSpent }`; `SpendSnapshot { keyId, spentUsd }`; `PendingSettlement { vault, usageMicro: bigint, baselines: SpendSnapshot[], tx, createdAt }`; `ModelCallRow { id, keyId, vault, period, model, costUsd: number | null, generationId, status: "recorded" | "pending", at }`; methods `addVault`, `vault`, `listVaults`, `setVaultState(vault, { frozen?, yieldUsd?, orLimit?, orUsage? })`, `setSettling(vault, bool)`, `setVaultOpenRouterKey(vault, hash, encryptedSecret)`, `openRouterKeyFor(vault): { hash, encryptedSecret } | undefined`, `addKey({ id, vault, name, weight, secretSha256 })`, `setWeight(id, weight)`, `rotateKey(id, secretSha256): boolean`, `revokeKey(id): boolean`, `keysForVault(vault): KeyRow[]` (revoked included), `keyById(id)`, `keyBySecret(sha256)` (revoked included; callers check `revoked`), `recordToolCall(keyId, api, path, priceUsd)`, `recordModelCall({ keyId, model, costUsd, generationId })`, `recordPendingModelCall({ keyId, model, generationId })`, `resolveModelCall(generationId, costUsd): boolean`, `listPendingModelCalls(): ModelCallRow[]`, `modelCall(generationId): ModelCallRow | undefined`, `spendForKey(id): { modelUsd, toolUsd }`, `spendForVault(vault): { modelUsd, toolUsd }`, `totalModelCost(vault): number`, `startNewPeriod(vault)`, `recordSettlement`, `setPendingSettlement(vault, { usageMicro, baselines: SpendSnapshot[], tx, createdAt? }): boolean`, `pendingSettlement`, `listPendingSettlements`, `clearPendingSettlement(vault, tx): boolean` (also clears `settling`), `completePendingSettlement(vault, tx, month): boolean` (also clears `settling`), `listSettlements`, `getMeta`, `setMeta`, `close`.
- Produces (limits): `KeyInput { id, weight, revoked, modelSpent, toolSpent }` (a `KeyRow` satisfies it); `KeyLimit { id, budget, spent, remaining }`; `computeLimits(yieldUsd, keys, params, frozen)`; `companyLimit(orUsage: number, limits: KeyLimit[]): number`; `toolBudgetUsd(l, params)`; `usageMicro(keys, params): bigint`.

- [ ] **Step 1: Write the failing store tests**

Replace `app/test/store.test.ts` with:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "../store.ts";

const V = "0xAbC0000000000000000000000000000000000001";

function fresh() {
  const s = openStore(":memory:");
  s.addVault(V, "0xC0FFEE000000000000000000000000000000000A", "Treasury");
  s.addKey({ id: "k1", vault: V, name: "dev-1", weight: 1, secretSha256: "s1" });
  s.addKey({ id: "k2", vault: V, name: "dev-2", weight: 2, secretSha256: "s2" });
  return s;
}

/** A database file as versions 1 and 2 of the app wrote it: keys by OpenRouter hash, no model_calls. */
function writeOldDb(path: string, version: "1" | "2") {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE vaults (vault TEXT PRIMARY KEY, customer TEXT NOT NULL, label TEXT NOT NULL,
      period INTEGER NOT NULL DEFAULT 0, frozen INTEGER NOT NULL DEFAULT 0, yield_usd REAL NOT NULL DEFAULT 0);
    CREATE TABLE keys (hash TEXT PRIMARY KEY, vault TEXT NOT NULL, name TEXT NOT NULL, weight REAL NOT NULL,
      secret_sha256 TEXT NOT NULL UNIQUE, baseline REAL NOT NULL DEFAULT 0, usage_total REAL NOT NULL DEFAULT 0);
    CREATE TABLE tool_calls (id INTEGER PRIMARY KEY, key_hash TEXT NOT NULL, api TEXT NOT NULL, path TEXT NOT NULL,
      price REAL NOT NULL, period INTEGER NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE settlements (id INTEGER PRIMARY KEY, vault TEXT NOT NULL, usage_micro TEXT NOT NULL, tx TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    INSERT INTO meta (k, v) VALUES ('schemaVersion', '${version}');
    INSERT INTO vaults (vault, customer, label, period, yield_usd) VALUES ('0xaa', '0xcc', 'T', 3, 12.5);
    INSERT INTO keys (hash, vault, name, weight, secret_sha256) VALUES ('h1', '0xaa', 'old', 1, 's1');
    INSERT INTO settlements (vault, usage_micro, tx, at) VALUES ('0xaa', '5', '0xold', 1);
  `);
  if (version === "2") {
    db.exec(`CREATE TABLE pending_settlements (vault TEXT PRIMARY KEY, usage_micro TEXT NOT NULL, baselines TEXT NOT NULL,
      tx TEXT NOT NULL, created_at INTEGER NOT NULL);`);
  }
  db.close();
}

test("stores addresses lowercase and starts at period 0, unfrozen, not settling", () => {
  const s = fresh();
  const v = s.vault(V)!;
  assert.equal(v.vault, V.toLowerCase());
  assert.equal(v.period, 0);
  assert.equal(v.frozen, false);
  assert.equal(v.settling, false);
  assert.equal(v.orKeyHash, null);
  assert.equal(v.orLimit, 0);
  assert.equal(s.listVaults().length, 1);
});

test("keys carry weight, this period's model and tool spend, and are found by secret hash", () => {
  const s = fresh();
  s.recordModelCall({ keyId: "k1", model: "m", costUsd: 0.5, generationId: "g1" });
  s.recordModelCall({ keyId: "k1", model: "m", costUsd: 0.25, generationId: "g2" });
  s.recordToolCall("k1", "olostep", "/v1/scrapes", 0.005);
  s.recordToolCall("k1", "olostep", "/v1/scrapes", 0.005);
  const k = s.keysForVault(V).find((k) => k.id === "k1")!;
  assert.equal(k.modelSpent, 0.75);
  assert.equal(k.toolSpent, 0.01);
  assert.equal(k.revoked, false);
  assert.ok(k.createdAt > 0);
  assert.equal(s.keyBySecret("s2")!.id, "k2");
  assert.equal(s.keyById("nope"), undefined);
  assert.deepEqual(s.spendForKey("k1"), { modelUsd: 0.75, toolUsd: 0.01 });
  assert.deepEqual(s.spendForKey("nope"), { modelUsd: 0, toolUsd: 0 });
  assert.deepEqual(s.spendForVault(V), { modelUsd: 0.75, toolUsd: 0.01 });
  const call = s.modelCall("g1")!;
  assert.equal(call.keyId, "k1");
  assert.equal(call.vault, V.toLowerCase());
  assert.equal(call.period, 0);
  assert.equal(call.costUsd, 0.5);
  assert.equal(call.status, "recorded");
});

test("recording a model call twice with the same generation id counts once", () => {
  const s = fresh();
  s.recordModelCall({ keyId: "k1", model: "m", costUsd: 0.5, generationId: "g1" });
  s.recordModelCall({ keyId: "k1", model: "m", costUsd: 0.5, generationId: "g1" });
  assert.equal(s.spendForKey("k1").modelUsd, 0.5);
  assert.equal(s.modelCall("g1")!.status, "recorded");
});

test("pending model calls count as zero until resolved, and resolve once", () => {
  const s = fresh();
  s.recordPendingModelCall({ keyId: "k1", model: "m", generationId: "g1" });
  assert.equal(s.spendForKey("k1").modelUsd, 0);
  assert.equal(s.listPendingModelCalls().length, 1);
  assert.equal(s.listPendingModelCalls()[0].generationId, "g1");
  assert.equal(s.listPendingModelCalls()[0].costUsd, null);
  assert.equal(s.resolveModelCall("g1", 0.3), true);
  assert.equal(s.resolveModelCall("g1", 0.9), false);
  assert.equal(s.spendForKey("k1").modelUsd, 0.3);
  assert.equal(s.listPendingModelCalls().length, 0);
  // a pending row that is later recorded directly is upgraded, not duplicated
  s.recordPendingModelCall({ keyId: "k1", model: "m", generationId: "g2" });
  s.recordModelCall({ keyId: "k1", model: "m", costUsd: 0.1, generationId: "g2" });
  assert.equal(s.spendForKey("k1").modelUsd, 0.4);
  // a recorded row is not demoted by a late pending write
  s.recordPendingModelCall({ keyId: "k1", model: "m", generationId: "g2" });
  assert.equal(s.modelCall("g2")!.status, "recorded");
  assert.equal(s.modelCall("g2")!.costUsd, 0.1);
});

test("model and tool calls reject an unknown key", () => {
  const s = fresh();
  assert.throws(() => s.recordToolCall("nope", "a", "/b", 1), /unknown key/);
  assert.throws(() => s.recordModelCall({ keyId: "nope", model: "m", costUsd: 1, generationId: "g" }), /unknown key/);
  assert.throws(() => s.recordPendingModelCall({ keyId: "nope", model: "m", generationId: "g" }), /unknown key/);
});

test("a new period is a bump: this period's spend starts at zero, history stays", () => {
  const s = fresh();
  s.recordModelCall({ keyId: "k1", model: "m", costUsd: 3.5, generationId: "g1" });
  s.recordToolCall("k1", "a", "/b", 1);
  s.startNewPeriod(V);
  const k = s.keyById("k1")!;
  assert.equal(k.modelSpent, 0);
  assert.equal(k.toolSpent, 0);
  assert.equal(s.vault(V)!.period, 1);
  assert.equal(s.totalModelCost(V), 3.5);
  s.recordModelCall({ keyId: "k1", model: "m", costUsd: 1, generationId: "g2" });
  assert.equal(s.modelCall("g2")!.period, 1);
  assert.equal(s.totalModelCost(V), 4.5);
});

test("rotate replaces the secret on the same row; revoke keeps the row and its spend", () => {
  const s = fresh();
  s.recordModelCall({ keyId: "k1", model: "m", costUsd: 1, generationId: "g1" });
  assert.equal(s.rotateKey("k1", "s1b"), true);
  assert.equal(s.keyBySecret("s1"), undefined);
  assert.equal(s.keyBySecret("s1b")!.id, "k1");
  assert.equal(s.revokeKey("k1"), true);
  assert.equal(s.revokeKey("nope"), false);
  assert.equal(s.rotateKey("nope", "x"), false);
  const k = s.keyBySecret("s1b")!;
  assert.equal(k.revoked, true);
  assert.equal(k.modelSpent, 1);
  assert.equal(s.keysForVault(V).length, 2);
  s.setWeight("k2", 5);
  assert.equal(s.keyById("k2")!.weight, 5);
});

test("the company OpenRouter key is filed per vault and never on the vault row", () => {
  const s = fresh();
  assert.equal(s.openRouterKeyFor(V), undefined);
  s.setVaultOpenRouterKey(V, "orhash", "v1.enc");
  assert.deepEqual(s.openRouterKeyFor(V), { hash: "orhash", encryptedSecret: "v1.enc" });
  assert.equal(s.vault(V)!.orKeyHash, "orhash");
  assert.ok(!JSON.stringify(s.vault(V)).includes("v1.enc"));
  assert.ok(!JSON.stringify(s.listVaults()).includes("v1.enc"));
  s.setVaultState(V, { orLimit: 12.5, orUsage: 2 });
  assert.equal(s.vault(V)!.orLimit, 12.5);
  assert.equal(s.vault(V)!.orUsage, 2);
});

test("vault state, settling flag, settlements and meta round-trip", () => {
  const s = fresh();
  s.setVaultState(V, { frozen: true, yieldUsd: 12.5 });
  s.setSettling(V, true);
  assert.equal(s.vault(V)!.frozen, true);
  assert.equal(s.vault(V)!.yieldUsd, 12.5);
  assert.equal(s.vault(V)!.settling, true);
  s.setSettling(V, false);
  assert.equal(s.vault(V)!.settling, false);
  s.recordSettlement(V, 1_500_000n, "0xtx");
  assert.deepEqual(s.listSettlements().map((r) => [r.vault, r.usageMicro, r.tx]), [[V.toLowerCase(), "1500000", "0xtx"]]);
  s.setMeta("lastReport", "5");
  assert.equal(s.getMeta("lastReport"), "5");
  assert.equal(s.getMeta("nope"), undefined);
});

test("a fresh store records schema version 3", () => {
  assert.equal(fresh().getMeta("schemaVersion"), "3");
});

test("pending settlements round-trip with the spend snapshot", () => {
  const s = fresh();
  assert.equal(s.pendingSettlement(V), undefined);
  const ok = s.setPendingSettlement(V, { usageMicro: 2_000_000n, baselines: [{ keyId: "k1", spentUsd: 1.5 }], tx: "0xtx", createdAt: 7 });
  assert.equal(ok, true);
  const p = s.pendingSettlement(V)!;
  assert.equal(p.usageMicro, 2_000_000n);
  assert.deepEqual(p.baselines, [{ keyId: "k1", spentUsd: 1.5 }]);
  assert.equal(p.tx, "0xtx");
  assert.equal(p.createdAt, 7);
  assert.equal(s.listPendingSettlements().length, 1);
});

test("clearing a pending settlement takes the vault out of settling, but only for its tx", () => {
  const s = fresh();
  s.setSettling(V, true);
  s.setPendingSettlement(V, { usageMicro: 1n, baselines: [], tx: "0xnew" });
  assert.equal(s.clearPendingSettlement(V, "0xold"), false);
  assert.equal(s.vault(V)!.settling, true);
  assert.equal(s.pendingSettlement(V)!.tx, "0xnew");
  assert.equal(s.clearPendingSettlement(V, "0xnew"), true);
  assert.equal(s.pendingSettlement(V), undefined);
  assert.equal(s.vault(V)!.settling, false);
});

test("setPendingSettlement does not overwrite an existing row and reports it", () => {
  const s = fresh();
  assert.equal(s.setPendingSettlement(V, { usageMicro: 1n, baselines: [], tx: "0xa" }), true);
  assert.equal(s.setPendingSettlement(V, { usageMicro: 2n, baselines: [], tx: "0xb" }), false);
  assert.equal(s.pendingSettlement(V)!.tx, "0xa");
});

test("completing a pending settlement applies it once, only for its tx, and clears settling", () => {
  const s = fresh();
  s.recordModelCall({ keyId: "k1", model: "m", costUsd: 2, generationId: "g1" });
  s.setSettling(V, true);
  s.setPendingSettlement(V, { usageMicro: 2_000_000n, baselines: [{ keyId: "k1", spentUsd: 2 }], tx: "0xtx", createdAt: 7 });
  assert.equal(s.completePendingSettlement(V, "0xother", "2026-11"), false);
  assert.equal(s.completePendingSettlement(V, "0xtx", "2026-11"), true);
  assert.equal(s.completePendingSettlement(V, "0xtx", "2026-11"), false);
  assert.equal(s.listSettlements().length, 1);
  assert.equal(s.listSettlements()[0].usageMicro, "2000000");
  assert.equal(s.vault(V)!.period, 1);
  assert.equal(s.vault(V)!.settling, false);
  assert.equal(s.keyById("k1")!.modelSpent, 0);
  assert.equal(s.pendingSettlement(V), undefined);
  assert.equal(s.getMeta(`settledMonth:${V.toLowerCase()}`), "2026-11");
});

for (const version of ["1", "2"] as const) {
  test(`a version ${version} database migrates to version 3, keeping vaults and settlements`, () => {
    const path = join(tmpdir(), `inferest-test-migrate${version}-${process.pid}-${Date.now()}.db`);
    try {
      writeOldDb(path, version);
      const s = openStore(path);
      assert.equal(s.getMeta("schemaVersion"), "3");
      const v = s.vault("0xaa")!;
      assert.equal(v.period, 3);
      assert.equal(v.yieldUsd, 12.5);
      assert.equal(v.settling, false);
      assert.equal(v.orKeyHash, null);
      assert.equal(s.listSettlements().length, 1);
      assert.equal(s.keysForVault("0xaa").length, 0);
      assert.deepEqual(s.listPendingSettlements(), []);
      s.addKey({ id: "k1", vault: "0xaa", name: "new", weight: 1, secretSha256: "s1" });
      s.recordModelCall({ keyId: "k1", model: "m", costUsd: 1, generationId: "g" });
      assert.equal(s.keyById("k1")!.modelSpent, 1);
      s.close();
      assert.equal(openStore(path).getMeta("schemaVersion"), "3"); // a second open is a no-op
    } finally {
      rmSync(path, { force: true });
    }
  });
}

test("an unsupported schema version is refused", () => {
  const path = join(tmpdir(), `inferest-test-${process.pid}-${Date.now()}.db`);
  try {
    const s = openStore(path);
    s.setMeta("schemaVersion", "99");
    s.close();
    assert.throws(() => openStore(path), /unsupported schema version 99/);
  } finally {
    rmSync(path, { force: true });
  }
});
```

- [ ] **Step 2: Write the failing limits tests**

Replace `app/test/limits.test.ts` with:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLimits, companyLimit, toolBudgetUsd, usageMicro, type KeyInput } from "../limits.ts";
import { HACKATHON_PARAMS } from "../../engine/ledger.ts";

const key = (id: string, weight: number, modelSpent = 0, toolSpent = 0, revoked = false): KeyInput =>
  ({ id, weight, revoked, modelSpent, toolSpent });
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("equal weights split the credit evenly", () => {
  const l = computeLimits(2_000, [key("a", 1, 100), key("b", 1)], HACKATHON_PARAMS, false);
  assert.deepEqual(l.map((x) => [x.id, x.budget, x.spent, x.remaining]), [["a", 1000, 100, 900], ["b", 1000, 0, 1000]]);
});

test("a key's unused share does not flow to the others", () => {
  const l = computeLimits(300, [key("a", 1, 100), key("b", 2)], HACKATHON_PARAMS, false);
  close(l[0].budget, 100); close(l[0].remaining, 0);
  close(l[1].budget, 200); close(l[1].remaining, 200);
});

test("tool spend comes out of the same key budget", () => {
  const l = computeLimits(100, [key("a", 1, 10, 5)], HACKATHON_PARAMS, false);
  close(l[0].spent, 15); close(l[0].remaining, 85);
});

test("frozen vaults open nothing but keep spend", () => {
  const l = computeLimits(100, [key("a", 1, 10)], HACKATHON_PARAMS, true);
  assert.equal(l[0].budget, 0); assert.equal(l[0].remaining, 0); assert.equal(l[0].spent, 10);
});

test("revoked keys get no credit but their spend still counts against the pool", () => {
  const l = computeLimits(100, [key("a", 1, 40, 0, true), key("b", 1)], HACKATHON_PARAMS, false);
  assert.equal(l[0].budget, 0); assert.equal(l[0].remaining, 0); assert.equal(l[0].spent, 40);
  close(l[1].budget, 100); close(l[1].remaining, 60);
});

test("zero weights and negative yield open nothing", () => {
  assert.equal(computeLimits(100, [key("a", 0)], HACKATHON_PARAMS, false)[0].remaining, 0);
  assert.equal(computeLimits(-5, [key("a", 1)], HACKATHON_PARAMS, false)[0].remaining, 0);
});

test("the rail fee scales credit and settlement usage", () => {
  const p = { ...HACKATHON_PARAMS, railFee: 0.05 };
  const l = computeLimits(100, [key("a", 1, 19, 10)], p, false);
  close(l[0].budget, 95); close(l[0].spent, 28.5); close(l[0].remaining, 66.5);
  close(toolBudgetUsd(l[0], p), 70);
  assert.equal(usageMicro([key("a", 1, 19, 10)], p), 30_000_000n);
});

test("settlement usage in USDC base units", () => {
  assert.equal(usageMicro([key("a", 1, 1.5, 0.25), key("b", 1, 0.000001)], HACKATHON_PARAMS), 1_750_001n);
});

test("reweighting after spend never opens more than the yield", () => {
  const l = computeLimits(100, [key("a", 1, 100), key("b", 3)], HACKATHON_PARAMS, false);
  close(l[0].remaining + l[1].remaining, 0);
});

test("open credit never exceeds the pool, and scaling is a no-op without overspend", () => {
  const l = computeLimits(100, [key("a", 1, 60), key("b", 1)], HACKATHON_PARAMS, false);
  close(l[0].remaining, 0); close(l[1].remaining, 40);
  const n = computeLimits(100, [key("a", 1, 10), key("b", 1, 10)], HACKATHON_PARAMS, false);
  close(n[0].remaining, 40); close(n[1].remaining, 40);
});

test("the company limit is cumulative usage plus open credit, floored to 4 decimals", () => {
  const l = computeLimits(100, [key("a", 1, 10), key("b", 1)], HACKATHON_PARAMS, false);
  assert.equal(companyLimit(12.34567, l), 102.3456);
  assert.equal(companyLimit(5, []), 5);
});
```

- [ ] **Step 3: Run both suites to verify they fail**

Run: `node --test app/test/store.test.ts app/test/limits.test.ts`
Expected: failures such as `s.recordModelCall is not a function`, `addKey` complaining about `hash`, and `companyLimit` undefined.

- [ ] **Step 4: Write `app/store.ts`**

Replace the whole file with:

```ts
import { DatabaseSync } from "node:sqlite";

export type VaultRow = {
  vault: string; customer: string; label: string; period: number; frozen: boolean; yieldUsd: number;
  /** set while a settlement is in progress; the proxy refuses new requests for the vault */
  settling: boolean;
  /** the company's OpenRouter key on the Management API (an identifier, not a secret) and its last synced limit and usage */
  orKeyHash: string | null; orLimit: number; orUsage: number;
};
export type KeyRow = {
  id: string; vault: string; name: string; weight: number; createdAt: number; revoked: boolean;
  /** this period's recorded model cost (USD) and paid tool spend (USDC) */
  modelSpent: number; toolSpent: number;
};
export type SettlementRow = { vault: string; usageMicro: string; tx: string; at: number };
/** What each key had spent when a settlement was signed, kept with the pending row for the record. */
export type SpendSnapshot = { keyId: string; spentUsd: number };
/** A settlement sent on chain whose receipt has not yet been seen: its bookkeeping is still owed. */
export type PendingSettlement = { vault: string; usageMicro: bigint; baselines: SpendSnapshot[]; tx: string; createdAt: number };
export type ModelCallStatus = "recorded" | "pending";
export type ModelCallRow = {
  id: number; keyId: string; vault: string; period: number; model: string; costUsd: number | null;
  generationId: string; status: ModelCallStatus; at: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vaults (
  vault TEXT PRIMARY KEY, customer TEXT NOT NULL, label TEXT NOT NULL,
  period INTEGER NOT NULL DEFAULT 0, frozen INTEGER NOT NULL DEFAULT 0, yield_usd REAL NOT NULL DEFAULT 0,
  settling INTEGER NOT NULL DEFAULT 0, or_key_hash TEXT, or_key_secret TEXT,
  or_limit REAL NOT NULL DEFAULT 0, or_usage REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS keys (
  id TEXT PRIMARY KEY, vault TEXT NOT NULL REFERENCES vaults(vault), name TEXT NOT NULL,
  weight REAL NOT NULL, secret_sha256 TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY, key_id TEXT NOT NULL, api TEXT NOT NULL, path TEXT NOT NULL,
  price REAL NOT NULL, period INTEGER NOT NULL, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS model_calls (
  id INTEGER PRIMARY KEY, key_id TEXT NOT NULL, vault TEXT NOT NULL, period INTEGER NOT NULL,
  model TEXT NOT NULL, cost_usd REAL, generation_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY, vault TEXT NOT NULL, usage_micro TEXT NOT NULL, tx TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pending_settlements (
  vault TEXT PRIMARY KEY, usage_micro TEXT NOT NULL, baselines TEXT NOT NULL, tx TEXT NOT NULL, created_at INTEGER NOT NULL
);
`;

export const SCHEMA_VERSION = "3";

/** Brings an older database up to SCHEMA_VERSION. Returns the version it ends at. */
function migrate(db: DatabaseSync, from: string): string {
  let at = from;
  if (at === "1") at = "2"; // version 2 only added pending_settlements, which SCHEMA has already created
  if (at === "2") {
    // Version 3 files keys under our own ids and meters spend in our own rows. The old keys, tool_calls and
    // pending_settlements rows were keyed by OpenRouter hashes that mean nothing now; they came from demos and
    // are dropped. Vault rows and the settlement history survive, with the new vault columns added.
    db.exec("DROP TABLE IF EXISTS keys; DROP TABLE IF EXISTS tool_calls; DROP TABLE IF EXISTS pending_settlements;");
    const cols = ["settling INTEGER NOT NULL DEFAULT 0", "or_key_hash TEXT", "or_key_secret TEXT",
      "or_limit REAL NOT NULL DEFAULT 0", "or_usage REAL NOT NULL DEFAULT 0"];
    for (const col of cols) db.exec(`ALTER TABLE vaults ADD COLUMN ${col}`);
    db.exec(SCHEMA);
    at = "3";
  }
  if (at !== from) db.prepare("UPDATE meta SET v = ? WHERE k = ?").run(at, "schemaVersion");
  return at;
}

const KEY_SELECT = `
SELECT k.id, k.vault, k.name, k.weight, k.created_at AS createdAt, k.revoked_at AS revokedAt,
  COALESCE((SELECT SUM(m.cost_usd) FROM model_calls m WHERE m.key_id = k.id AND m.period = v.period AND m.status = 'recorded'), 0) AS modelSpent,
  COALESCE((SELECT SUM(t.price) FROM tool_calls t WHERE t.key_id = k.id AND t.period = v.period), 0) AS toolSpent
FROM keys k JOIN vaults v ON v.vault = k.vault`;

const lc = (a: string) => a.toLowerCase();
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** The meta key holding the last month a vault was settled for. */
export const settledMonthKey = (vault: string): string => `settledMonth:${lc(vault)}`;

export function openStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  const versionRow = db.prepare("SELECT v FROM meta WHERE k = ?").get("schemaVersion") as { v: string } | undefined;
  if (!versionRow) {
    db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run("schemaVersion", SCHEMA_VERSION);
  } else if (migrate(db, String(versionRow.v)) !== SCHEMA_VERSION) {
    throw new Error(`unsupported schema version ${versionRow.v}, expected ${SCHEMA_VERSION}`);
  }

  const toVault = (r: any): VaultRow => ({
    vault: r.vault, customer: r.customer, label: r.label, period: Number(r.period),
    frozen: Number(r.frozen) === 1, yieldUsd: Number(r.yield_usd), settling: Number(r.settling) === 1,
    orKeyHash: r.or_key_hash ?? null, orLimit: Number(r.or_limit), orUsage: Number(r.or_usage),
  });
  const toKey = (r: any): KeyRow => ({
    id: r.id, vault: r.vault, name: r.name, weight: Number(r.weight), createdAt: Number(r.createdAt),
    revoked: r.revokedAt !== null && r.revokedAt !== undefined,
    modelSpent: round6(Number(r.modelSpent)), toolSpent: round6(Number(r.toolSpent)),
  });
  const toPending = (r: any): PendingSettlement => ({
    vault: r.vault, usageMicro: BigInt(r.usage_micro), baselines: JSON.parse(r.baselines) as SpendSnapshot[],
    tx: r.tx, createdAt: Number(r.created_at),
  });
  const toModelCall = (r: any): ModelCallRow => ({
    id: Number(r.id), keyId: r.key_id, vault: r.vault, period: Number(r.period), model: r.model,
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd), generationId: r.generation_id,
    status: r.status as ModelCallStatus, at: Number(r.at),
  });

  function inTransaction<T>(fn: () => T): T {
    db.exec("BEGIN");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  const insertSettlement = (vault: string, usageMicro: bigint, tx: string) =>
    db.prepare("INSERT INTO settlements (vault, usage_micro, tx, at) VALUES (?, ?, ?, ?)").run(lc(vault), usageMicro.toString(), tx, Date.now());
  const requireKey = (id: string): void => {
    if (!db.prepare("SELECT 1 FROM keys WHERE id = ?").get(id)) throw new Error(`unknown key ${id}`);
  };
  const keysForVault = (vault: string): KeyRow[] =>
    db.prepare(`${KEY_SELECT} WHERE k.vault = ? ORDER BY k.created_at, k.id`).all(lc(vault)).map(toKey);
  const keyById = (id: string): KeyRow | undefined => {
    const r = db.prepare(`${KEY_SELECT} WHERE k.id = ?`).get(id);
    return r ? toKey(r) : undefined;
  };
  const MODEL_CALL_INSERT = `INSERT INTO model_calls (key_id, vault, period, model, cost_usd, generation_id, status, at)
    SELECT k.id, k.vault, v.period, ?, ?, ?, ?, ? FROM keys k JOIN vaults v ON v.vault = k.vault WHERE k.id = ?`;

  return {
    addVault(vault: string, customer: string, label: string): void {
      db.prepare("INSERT OR IGNORE INTO vaults (vault, customer, label) VALUES (?, ?, ?)").run(lc(vault), lc(customer), label);
    },
    vault(vault: string): VaultRow | undefined {
      const r = db.prepare("SELECT * FROM vaults WHERE vault = ?").get(lc(vault));
      return r ? toVault(r) : undefined;
    },
    listVaults(): VaultRow[] {
      return db.prepare("SELECT * FROM vaults ORDER BY vault").all().map(toVault);
    },
    setVaultState(vault: string, s: { frozen?: boolean; yieldUsd?: number; orLimit?: number; orUsage?: number }): void {
      if (s.frozen !== undefined) db.prepare("UPDATE vaults SET frozen = ? WHERE vault = ?").run(s.frozen ? 1 : 0, lc(vault));
      if (s.yieldUsd !== undefined) db.prepare("UPDATE vaults SET yield_usd = ? WHERE vault = ?").run(s.yieldUsd, lc(vault));
      if (s.orLimit !== undefined) db.prepare("UPDATE vaults SET or_limit = ? WHERE vault = ?").run(s.orLimit, lc(vault));
      if (s.orUsage !== undefined) db.prepare("UPDATE vaults SET or_usage = ? WHERE vault = ?").run(s.orUsage, lc(vault));
    },
    setSettling(vault: string, settling: boolean): void {
      db.prepare("UPDATE vaults SET settling = ? WHERE vault = ?").run(settling ? 1 : 0, lc(vault));
    },
    /** Files the company's OpenRouter key: its hash for the Management API and its secret, encrypted by the caller. */
    setVaultOpenRouterKey(vault: string, hash: string, encryptedSecret: string): void {
      db.prepare("UPDATE vaults SET or_key_hash = ?, or_key_secret = ? WHERE vault = ?").run(hash, encryptedSecret, lc(vault));
    },
    /** The company's OpenRouter key with its secret still encrypted. Never send this to a client. */
    openRouterKeyFor(vault: string): { hash: string; encryptedSecret: string } | undefined {
      const r: any = db.prepare("SELECT or_key_hash, or_key_secret FROM vaults WHERE vault = ?").get(lc(vault));
      return r && r.or_key_hash && r.or_key_secret ? { hash: String(r.or_key_hash), encryptedSecret: String(r.or_key_secret) } : undefined;
    },
    addKey(k: { id: string; vault: string; name: string; weight: number; secretSha256: string }, now: number = Date.now()): void {
      db.prepare("INSERT INTO keys (id, vault, name, weight, secret_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(k.id, lc(k.vault), k.name, k.weight, k.secretSha256, now);
    },
    setWeight(id: string, weight: number): void {
      db.prepare("UPDATE keys SET weight = ? WHERE id = ?").run(weight, id);
    },
    /** Replaces the secret on the same row, so budget and history stay with the developer. */
    rotateKey(id: string, secretSha256: string): boolean {
      return Number(db.prepare("UPDATE keys SET secret_sha256 = ? WHERE id = ?").run(secretSha256, id).changes) > 0;
    },
    revokeKey(id: string, now: number = Date.now()): boolean {
      return Number(db.prepare("UPDATE keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id).changes) > 0;
    },
    keysForVault,
    keyById,
    keyBySecret(sha256: string): KeyRow | undefined {
      const r = db.prepare(`${KEY_SELECT} WHERE k.secret_sha256 = ?`).get(sha256);
      return r ? toKey(r) : undefined;
    },
    recordToolCall(keyId: string, api: string, path: string, priceUsd: number): void {
      const r = db.prepare(`INSERT INTO tool_calls (key_id, api, path, price, period, at)
        SELECT ?, ?, ?, ?, v.period, ? FROM keys k JOIN vaults v ON v.vault = k.vault WHERE k.id = ?`)
        .run(keyId, api, path, priceUsd, Date.now(), keyId);
      if (Number(r.changes) === 0) throw new Error(`unknown key ${keyId}`);
    },
    /** Records a metered call. Idempotent on generation id: a repeat is ignored, a pending row is upgraded. */
    recordModelCall(c: { keyId: string; model: string; costUsd: number; generationId: string }, now: number = Date.now()): void {
      requireKey(c.keyId);
      db.prepare(`${MODEL_CALL_INSERT}
        ON CONFLICT(generation_id) DO UPDATE SET cost_usd = excluded.cost_usd, status = 'recorded' WHERE model_calls.status = 'pending'`)
        .run(c.model, c.costUsd, c.generationId, "recorded", now, c.keyId);
    },
    /** A call whose cost did not arrive; the keeper resolves it through OpenRouter's generation lookup. */
    recordPendingModelCall(c: { keyId: string; model: string; generationId: string }, now: number = Date.now()): void {
      requireKey(c.keyId);
      db.prepare(`${MODEL_CALL_INSERT} ON CONFLICT(generation_id) DO NOTHING`)
        .run(c.model, null, c.generationId, "pending", now, c.keyId);
    },
    resolveModelCall(generationId: string, costUsd: number): boolean {
      const r = db.prepare("UPDATE model_calls SET cost_usd = ?, status = 'recorded' WHERE generation_id = ? AND status = 'pending'")
        .run(costUsd, generationId);
      return Number(r.changes) > 0;
    },
    listPendingModelCalls(): ModelCallRow[] {
      return db.prepare("SELECT * FROM model_calls WHERE status = 'pending' ORDER BY at, id").all().map(toModelCall);
    },
    modelCall(generationId: string): ModelCallRow | undefined {
      const r = db.prepare("SELECT * FROM model_calls WHERE generation_id = ?").get(generationId);
      return r ? toModelCall(r) : undefined;
    },
    /** This period's spend: model cost in USD, tool spend in USDC. Zero for an unknown key. */
    spendForKey(id: string): { modelUsd: number; toolUsd: number } {
      const k = keyById(id);
      return k ? { modelUsd: k.modelSpent, toolUsd: k.toolSpent } : { modelUsd: 0, toolUsd: 0 };
    },
    spendForVault(vault: string): { modelUsd: number; toolUsd: number } {
      const keys = keysForVault(vault);
      return {
        modelUsd: round6(keys.reduce((s, k) => s + k.modelSpent, 0)),
        toolUsd: round6(keys.reduce((s, k) => s + k.toolSpent, 0)),
      };
    },
    /** Every recorded model cost for the vault across all periods, for the daily drift check. */
    totalModelCost(vault: string): number {
      const r: any = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM model_calls WHERE vault = ? AND status = 'recorded'").get(lc(vault));
      return round6(Number(r.c));
    },
    /** Opens the next period. Spend is per period, so a bump is all it takes. */
    startNewPeriod(vault: string): void {
      db.prepare("UPDATE vaults SET period = period + 1 WHERE vault = ?").run(lc(vault));
    },
    recordSettlement(vault: string, usageMicro: bigint, tx: string): void {
      insertSettlement(vault, usageMicro, tx);
    },
    /**
     * Persists a settlement about to be broadcast. Insert-only: returns false, changing nothing, when the vault
     * already has a pending settlement (possibly from another process), so the caller must not broadcast.
     */
    setPendingSettlement(vault: string, p: { usageMicro: bigint; baselines: SpendSnapshot[]; tx: string; createdAt?: number }): boolean {
      const r = db.prepare(`INSERT INTO pending_settlements (vault, usage_micro, baselines, tx, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(vault) DO NOTHING`)
        .run(lc(vault), p.usageMicro.toString(), JSON.stringify(p.baselines), p.tx, p.createdAt ?? Date.now());
      return Number(r.changes) === 1;
    },
    pendingSettlement(vault: string): PendingSettlement | undefined {
      const r = db.prepare("SELECT * FROM pending_settlements WHERE vault = ?").get(lc(vault));
      return r ? toPending(r) : undefined;
    },
    listPendingSettlements(): PendingSettlement[] {
      return db.prepare("SELECT * FROM pending_settlements ORDER BY created_at, vault").all().map(toPending);
    },
    /** Clears the pending row only if it is still this tx, and then reopens the vault to the proxy. */
    clearPendingSettlement(vault: string, tx: string): boolean {
      return inTransaction(() => {
        const cleared = Number(db.prepare("DELETE FROM pending_settlements WHERE vault = ? AND tx = ?").run(lc(vault), tx).changes) > 0;
        if (cleared) db.prepare("UPDATE vaults SET settling = 0 WHERE vault = ?").run(lc(vault));
        return cleared;
      });
    },
    /**
     * Applies a mined settlement's bookkeeping in one transaction: records it, opens the next period, clears the
     * pending row and the settling flag, and writes the vault's settled-month marker. Returns false, and changes
     * nothing, unless a pending row for exactly this vault and tx exists, so it applies at most once.
     */
    completePendingSettlement(vault: string, tx: string, month: string): boolean {
      return inTransaction(() => {
        const r = db.prepare("SELECT * FROM pending_settlements WHERE vault = ? AND tx = ?").get(lc(vault), tx);
        if (!r) return false;
        const p = toPending(r);
        insertSettlement(vault, p.usageMicro, p.tx);
        db.prepare("UPDATE vaults SET period = period + 1, settling = 0 WHERE vault = ?").run(lc(vault));
        db.prepare("DELETE FROM pending_settlements WHERE vault = ?").run(lc(vault));
        db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
          .run(settledMonthKey(vault), month);
        return true;
      });
    },
    listSettlements(): SettlementRow[] {
      return db.prepare("SELECT vault, usage_micro AS usageMicro, tx, at FROM settlements ORDER BY id DESC").all()
        .map((r: any) => ({ vault: r.vault, usageMicro: String(r.usageMicro), tx: r.tx, at: Number(r.at) }));
    },
    getMeta(k: string): string | undefined {
      const r: any = db.prepare("SELECT v FROM meta WHERE k = ?").get(k);
      return r ? String(r.v) : undefined;
    },
    setMeta(k: string, v: string): void {
      db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
    },
    close(): void {
      db.close();
    },
  };
}

export type Store = ReturnType<typeof openStore>;
```

- [ ] **Step 5: Write `app/limits.ts`**

Replace the whole file with:

```ts
import type { Params } from "../engine/ledger.ts";

/** One key's inputs to the budget math: its weight and what it has spent this period (a store KeyRow fits). */
export type KeyInput = { id: string; weight: number; revoked: boolean; modelSpent: number; toolSpent: number };
export type KeyLimit = { id: string; budget: number; spent: number; remaining: number };

const floor4 = (x: number) => Math.floor(x * 1e4) / 1e4;

/**
 * Per-key budgets for this period. Credit = yield in the Splitter × (1 − railFee), split by weight; a revoked
 * key weighs nothing. Spent = recorded model cost + tool spend × (1 − railFee), in credit units.
 * A key's budget is fixed by its weight: what one key leaves unused does not flow to the others.
 * The sum of open credit is capped at the pool: if reweighting after spend would open more than
 * credit minus total spend, every key's remaining budget is scaled down proportionally.
 */
export function computeLimits(yieldUsd: number, keys: KeyInput[], params: Params, frozen: boolean): KeyLimit[] {
  const credit = frozen ? 0 : Math.max(0, yieldUsd) * (1 - params.railFee);
  const weightOf = (k: KeyInput) => (k.revoked ? 0 : Math.max(0, k.weight));
  const weightSum = keys.reduce((s, k) => s + weightOf(k), 0);
  const rows = keys.map((k) => {
    const budget = weightSum > 0 ? (credit * weightOf(k)) / weightSum : 0;
    const spent = Math.max(0, k.modelSpent) + k.toolSpent * (1 - params.railFee);
    return { k, budget, spent, remaining: Math.max(0, budget - spent) };
  });
  const poolLeft = Math.max(0, credit - rows.reduce((s, r) => s + r.spent, 0));
  const sumRemaining = rows.reduce((s, r) => s + r.remaining, 0);
  const scale = sumRemaining > 0 && sumRemaining > poolLeft + 1e-9 ? poolLeft / sumRemaining : 1;
  return rows.map(({ k, budget, spent, remaining }) => ({ id: k.id, budget, spent, remaining: remaining * scale }));
}

/** The company key's cumulative limit on OpenRouter: what it has used plus everything still open here. */
export function companyLimit(orUsage: number, limits: KeyLimit[]): number {
  return floor4(orUsage + limits.reduce((s, l) => s + l.remaining, 0));
}

/** USDC a key may still spend on tools (tools are paid in USDC, so no rail fee). */
export function toolBudgetUsd(l: KeyLimit, params: Params): number {
  return l.remaining / (1 - params.railFee);
}

/** What the period cost, in USDC base units, for Splitter.settle. */
export function usageMicro(keys: KeyInput[], params: Params): bigint {
  const usd = keys.reduce((s, k) => s + Math.max(0, k.modelSpent) / (1 - params.railFee) + k.toolSpent, 0);
  return BigInt(Math.round(usd * 1e6));
}
```

- [ ] **Step 6: Run the two suites and typecheck the two modules**

Run: `node --test app/test/store.test.ts app/test/limits.test.ts && npm run typecheck`
Expected: all store and limits tests pass. The typecheck reports errors only in `app/keeper.ts`, `app/server.ts`, `app/cli.ts`, `app/mcp.ts` and `app/test/keeper.test.ts`, `app/test/server.test.ts` (old key shape); Tasks 4 and 5 repair those. No error may mention `store.ts`, `limits.ts` or their tests.

- [ ] **Step 7: Commit**

```bash
git add app/store.ts app/limits.ts app/test/store.test.ts app/test/limits.test.ts
git commit -m "Store schema 3: Inferest keys by id, metered model calls, company OpenRouter key; budget math on metered spend"
```

---

### Task 4: Keeper on one OpenRouter key per company

**Branch:** `proxy-key-model` (continues Task 3's branch). After this task the keeper suite is green again; the server suite stays red until Task 5.

**Files:**
- Modify: `app/keeper.ts` (whole file)
- Modify: `app/test/keeper.test.ts` (whole file)
- Modify: `app/mcp.ts:7,51,54` (rename `keyHash` to `keyId`)
- Modify: `app/tools.ts:31-32,74-118` (rename `keyHash` to `keyId`; behavior unchanged)
- Modify: `app/cli.ts:1-13` (keeper gets `decrypt`)

**Interfaces:**
- Consumes: store methods from Task 3 (`openRouterKeyFor`, `setSettling`, `keysForVault`, `keyById`, `listPendingModelCalls`, `resolveModelCall`, `totalModelCost`, `setVaultState({ orLimit, orUsage })`), `computeLimits`/`companyLimit`/`usageMicro` from Task 3, `OpenRouter.getGeneration` from Task 2, `secretBox` from Task 1.
- Produces: `KeeperDeps` gains `decrypt: (encrypted: string) => string` (required), `drain?: (vault: string, ms: number) => Promise<void>`, `drainMs?: number` (default `10_000`). New exports `resolvePendingModelCalls(d, now?)` and `checkDrift(d)`. `toolBudgetFor(store, params, keyId)` returns 0 for a revoked key or a settling vault. Log line formats other code and tests rely on: `drift <vault>: openrouter usage <n> recorded <n> drift <n>`, `model call <gen> on key <id> unresolved for <h> h: operator attention needed`, `sync <vault>: stale settling flag cleared`.

- [ ] **Step 1: Write `app/keeper.ts`**

Replace the whole file with:

```ts
import type { Params } from "../engine/ledger.ts";
import type { Chain, TxStatus } from "./chain.ts";
import type { OpenRouter } from "./openrouter.ts";
import { settledMonthKey, type Store, type PendingSettlement, type SpendSnapshot } from "./store.ts";
import { computeLimits, companyLimit, toolBudgetUsd, usageMicro, type KeyLimit } from "./limits.ts";

export type KeeperDeps = {
  chain: Chain; store: Store; or: OpenRouter; params: Params; log: (msg: string) => void;
  /** Decrypts a vault's OpenRouter key secret (secretBox(KEY_ENCRYPTION_KEY).decrypt in production). */
  decrypt: (encrypted: string) => string;
  /** Waits for the vault's in-flight proxy requests to finish metering, up to ms. The server sets it from the proxy. */
  drain?: (vault: string, ms: number) => Promise<void>;
  /** How long settlement waits for in-flight metering (default 10 s). */
  drainMs?: number;
  /** Delay between receipt polls after sending a settlement (default 2 s). */
  waitMs?: number;
  /** Receipt polls before leaving a settlement pending for reconciliation (default 60, about 2 minutes). */
  waitAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Age after which reconciliation checks whether an unmined settlement is known to the node (default 30 min). */
  maxPendingMs?: number;
  /** How long a vault waits before retrying a settlement that failed to prepare (default 10 min). */
  retryDelayMs?: number;
};

export type SettleResult = { usage: bigint; tx: string; pending?: true };

const DAY_MS = 86_400_000;
const DEFAULT_WAIT_MS = 2_000;
const DEFAULT_WAIT_ATTEMPTS = 60;
const DEFAULT_MAX_PENDING_MS = 30 * 60_000;
const DEFAULT_RETRY_DELAY_MS = 10 * 60_000;
const DEFAULT_DRAIN_MS = 10_000;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const noDrain = async (): Promise<void> => {};

/** UTC calendar month, e.g. "2026-11". */
export const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
export { settledMonthKey };
/** The meta key holding the time before which a vault's failed settlement is not retried. */
export const retryAfterKey = (vault: string): string => `settleRetryAfter:${vault.toLowerCase()}`;

/** Marks a newly registered vault as settled for this month, so its first settlement is next month. */
export function markRegistered(store: Store, vault: string, now: number = Date.now()): void {
  if (store.getMeta(settledMonthKey(vault)) === undefined) store.setMeta(settledMonthKey(vault), monthOf(now));
}

let ticking = false;
const settlingVaults = new Set<string>();

/** Whether this process is settling or reconciling the vault right now. */
export const isSettling = (vault: string): boolean => settlingVaults.has(vault.toLowerCase());

/**
 * Pins the company OpenRouter key's cumulative limit at its usage plus the credit open here: the backstop.
 * With no open credit (a freeze, or the settlement snapshot) the limit is the usage itself.
 */
async function syncCompanyKey(d: KeeperDeps, vault: string, limits: KeyLimit[]): Promise<void> {
  const orKey = d.store.openRouterKeyFor(vault);
  if (!orKey) {
    d.log(`sync ${vault}: no OpenRouter key on file, nothing to pin`);
    return;
  }
  const live = await d.or.getKey(orKey.hash);
  const limit = companyLimit(live.usage, limits);
  await d.or.setLimit(orKey.hash, limit);
  d.store.setVaultState(vault, { orLimit: limit, orUsage: live.usage });
}

export async function syncVault(d: KeeperDeps, vault: string): Promise<KeyLimit[]> {
  if (d.store.pendingSettlement(vault)) {
    // the vault stays closed until the settlement's receipt is seen
    d.log(`sync ${vault} skipped: settlement pending`);
    return [];
  }
  if (d.store.vault(vault)?.settling && !settlingVaults.has(vault.toLowerCase())) {
    // a settling flag with no pending row and no settlement in this process is left over from a crash
    d.store.setSettling(vault, false);
    d.log(`sync ${vault}: stale settling flag cleared`);
  }
  const frozen = await d.chain.lossPending(vault);
  const yieldUsd = Number(await d.chain.yieldOf(vault)) / 1e6;
  d.store.setVaultState(vault, { frozen, yieldUsd });
  if (frozen) d.log(`loss pending on ${vault}: keys frozen at current usage`);
  const limits = computeLimits(yieldUsd, d.store.keysForVault(vault), d.params, frozen);
  await syncCompanyKey(d, vault, limits);
  return limits;
}

export async function syncAll(d: KeeperDeps): Promise<void> {
  for (const v of d.store.listVaults()) {
    if (settlingVaults.has(v.vault.toLowerCase())) {
      d.log(`sync ${v.vault} skipped: settling`);
      continue;
    }
    try {
      await syncVault(d, v.vault);
    } catch (e) {
      d.log(`sync ${v.vault} failed: ${(e as Error).message}`);
    }
  }
}

/** Octant's minimum liquidity seed; a vault at or below this holds only dust and fails report()'s health check. */
const MIN_REPORTABLE_ASSETS = 1_000n;

export async function reportAll(d: KeeperDeps, now: number = Date.now()): Promise<void> {
  for (const v of d.store.listVaults()) {
    try {
      const assets = await d.chain.totalAssets(v.vault);
      if (assets <= MIN_REPORTABLE_ASSETS) {
        d.log(`report ${v.vault} skipped: vault is empty`);
        continue;
      }
      await d.chain.report(v.vault);
    } catch (e) {
      d.log(`report ${v.vault} failed: ${(e as Error).message}`);
    }
  }
  d.store.setMeta("lastReport", String(now));
}

/**
 * Compares each company key's cumulative usage on OpenRouter with the model cost recorded here since the vault
 * was registered. Logs the drift and corrects nothing: it is the alarm for lost metering.
 */
export async function checkDrift(d: KeeperDeps): Promise<void> {
  for (const v of d.store.listVaults()) {
    const orKey = d.store.openRouterKeyFor(v.vault);
    if (!orKey) continue;
    try {
      const live = await d.or.getKey(orKey.hash);
      const recorded = d.store.totalModelCost(v.vault);
      const drift = Math.round((live.usage - recorded) * 1e6) / 1e6;
      d.log(`drift ${v.vault}: openrouter usage ${live.usage} recorded ${recorded} drift ${drift}`);
    } catch (e) {
      d.log(`drift ${v.vault} check failed: ${(e as Error).message}`);
    }
  }
}

/** Fills in the cost of calls whose usage never reached the proxy, through OpenRouter's generation lookup. */
export async function resolvePendingModelCalls(d: KeeperDeps, now: number = Date.now()): Promise<void> {
  const apiKeys = new Map<string, string | undefined>();
  for (const row of d.store.listPendingModelCalls()) {
    if (!apiKeys.has(row.vault)) {
      const orKey = d.store.openRouterKeyFor(row.vault);
      apiKeys.set(row.vault, orKey ? d.decrypt(orKey.encryptedSecret) : undefined);
    }
    const apiKey = apiKeys.get(row.vault);
    if (!apiKey) {
      d.log(`model call ${row.generationId} for ${row.vault}: no OpenRouter key on file`);
      continue;
    }
    try {
      const g = await d.or.getGeneration(row.generationId, apiKey);
      if (g) {
        if (d.store.resolveModelCall(row.generationId, g.totalCost)) {
          d.log(`model call ${row.generationId} on key ${row.keyId} resolved: $${g.totalCost}`);
        }
        continue;
      }
    } catch (e) {
      d.log(`model call ${row.generationId} lookup failed: ${(e as Error).message}`);
    }
    const age = now - row.at;
    if (age >= DAY_MS) {
      d.log(`model call ${row.generationId} on key ${row.keyId} unresolved for ${Math.round(age / 3_600_000)} h: operator attention needed`);
    }
  }
}

async function resync(d: KeeperDeps, vault: string, why: string): Promise<void> {
  try {
    await syncVault(d, vault);
  } catch (e) {
    d.log(`sync ${vault} after ${why} failed: ${(e as Error).message}`);
  }
}

/**
 * Applies a mined settlement's bookkeeping (settlement row, new period, pending row and settling flag cleared,
 * month marker) in one store transaction, then re-syncs. Returns false, applying nothing, if the pending
 * row for this tx is gone (applied or cleared by someone else).
 */
async function applySettlement(d: KeeperDeps, p: PendingSettlement): Promise<boolean> {
  if (!d.store.completePendingSettlement(p.vault, p.tx, monthOf(p.createdAt))) {
    d.log(`settlement ${p.tx} for ${p.vault} mined but its pending row is gone: bookkeeping not applied here`);
    return false;
  }
  d.log(`settled ${p.vault}: ${p.usageMicro} micro-USD in ${p.tx}`);
  await resync(d, p.vault, "settlement");
  return true;
}

/** Clears a reverted settlement's row (only if it is still this tx) and reopens the vault. */
async function clearReverted(d: KeeperDeps, p: { vault: string; tx: string }): Promise<void> {
  d.store.clearPendingSettlement(p.vault, p.tx);
  d.log(`settlement ${p.tx} for ${p.vault} reverted: nothing moved`);
  await resync(d, p.vault, "revert");
}

type Reconciled = "applied" | "cleared" | "pending";

/** Resolves one pending settlement from its receipt. The caller holds the vault in settlingVaults. */
async function reconcileOne(d: KeeperDeps, p: PendingSettlement, now: number): Promise<Reconciled> {
  let status: TxStatus;
  try {
    status = await d.chain.settleStatus(p.tx);
  } catch (e) {
    d.log(`settlement ${p.tx} for ${p.vault} status unknown: ${(e as Error).message}`);
    return "pending";
  }
  if (status === "success") return (await applySettlement(d, p)) ? "applied" : "pending";
  if (status === "reverted") {
    await clearReverted(d, p);
    return "cleared";
  }
  const age = now - p.createdAt;
  if (age < (d.maxPendingMs ?? DEFAULT_MAX_PENDING_MS)) return "pending";
  let known: boolean;
  try {
    known = await d.chain.transactionKnown(p.tx);
  } catch (e) {
    d.log(`settlement ${p.tx} for ${p.vault} lookup failed: ${(e as Error).message}`);
    return "pending";
  }
  const minutes = Math.round(age / 60_000);
  if (known) {
    d.log(`settlement ${p.tx} for ${p.vault} still unmined after ${minutes} min: vault stays closed`);
    return "pending";
  }
  // never accepted by the node: nothing can mine, so the month rule may settle the vault again
  d.store.clearPendingSettlement(p.vault, p.tx);
  d.log(`settlement ${p.tx} for ${p.vault} unknown to the node after ${minutes} min: pending row cleared`);
  await resync(d, p.vault, "dropped settlement");
  return "cleared";
}

/** Settles the bookkeeping of every settlement sent earlier whose receipt was not seen at the time. */
export async function reconcilePending(d: KeeperDeps, now: number = Date.now()): Promise<void> {
  for (const p of d.store.listPendingSettlements()) {
    if (settlingVaults.has(p.vault)) continue; // whoever holds the vault owns its row
    settlingVaults.add(p.vault);
    try {
      await reconcileOne(d, p, now);
    } finally {
      settlingVaults.delete(p.vault);
    }
  }
}

/** Polls the receipt of a just-sent settlement for a bounded time. */
async function waitForStatus(d: KeeperDeps, vault: string, tx: string): Promise<TxStatus> {
  const attempts = d.waitAttempts ?? DEFAULT_WAIT_ATTEMPTS;
  const sleep = d.sleep ?? defaultSleep;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(d.waitMs ?? DEFAULT_WAIT_MS);
    let status: TxStatus;
    try {
      status = await d.chain.settleStatus(tx);
    } catch (e) {
      d.log(`settlement ${tx} for ${vault} status unknown: ${(e as Error).message}`);
      return "pending";
    }
    if (status !== "pending") return status;
  }
  return "pending";
}

/**
 * Close the vault (proxy refuses, backstop pinned at usage), drain in-flight metering, read this period's spend,
 * sign the settlement, persist it as pending, broadcast, then wait for its receipt. The bookkeeping is applied
 * only once the receipt shows success; a settlement not yet confirmed (or whose broadcast failed ambiguously)
 * is left pending for reconcilePending and returned with pending: true. The vault reopens when the pending row
 * is completed or cleared.
 */
export async function settleVault(d: KeeperDeps, vault: string, now: number = Date.now()): Promise<SettleResult | null> {
  const key = vault.toLowerCase();
  if (!d.store.vault(vault)) {
    d.log(`settle ${vault} skipped: unknown vault`);
    return null;
  }
  if (settlingVaults.has(key)) {
    d.log(`settle ${vault} skipped: already settling`);
    return null;
  }
  settlingVaults.add(key);
  try {
    const earlier = d.store.pendingSettlement(vault);
    if (earlier) {
      const r = await reconcileOne(d, earlier, now);
      if (r === "pending") {
        d.log(`settle ${vault} skipped: settlement ${earlier.tx} still pending`);
        return { usage: earlier.usageMicro, tx: earlier.tx, pending: true };
      }
      // an applied earlier settlement is this call's result, not a reason to settle again
      if (r === "applied") return { usage: earlier.usageMicro, tx: earlier.tx };
    }
    if (await d.chain.lossPending(vault)) {
      d.log(`settle ${vault} skipped: loss pending`);
      return null;
    }
    d.store.setSettling(vault, true);
    let usage = 0n;
    let baselines: SpendSnapshot[] = [];
    let prepared;
    try {
      await syncCompanyKey(d, vault, []); // the backstop closes at current usage
      await (d.drain ?? noDrain)(vault, d.drainMs ?? DEFAULT_DRAIN_MS); // requests already past the budget check finish metering
      const keys = d.store.keysForVault(vault);
      usage = usageMicro(keys, d.params);
      baselines = keys.map((k) => ({ keyId: k.id, spentUsd: k.modelSpent + k.toolSpent }));
      prepared = await d.chain.prepareSettle(vault, usage);
    } catch (e) {
      // nothing was signed or sent: reopen the vault now and back off
      d.store.setSettling(vault, false);
      d.store.setMeta(retryAfterKey(vault), String(now + (d.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)));
      d.log(`settle ${vault} failed to prepare: ${(e as Error).message}`);
      await resync(d, vault, "failed settlement");
      throw e;
    }
    const tx = prepared.hash;
    const pending: PendingSettlement = { vault: key, usageMicro: usage, baselines, tx, createdAt: now };
    if (!d.store.setPendingSettlement(vault, pending)) {
      // another settlement (e.g. from the CLI in another process) persisted first: never broadcast a second one.
      // The signed transaction is discarded unsent, so its nonce was never consumed. The vault stays closed
      // until that other settlement completes or is cleared.
      const other = d.store.pendingSettlement(vault);
      d.log(`settle ${vault} not broadcast: settlement ${other?.tx ?? "(unknown)"} is already pending for this vault`);
      return other ? { usage: other.usageMicro, tx: other.tx, pending: true } : { usage, tx, pending: true };
    }
    try {
      await prepared.send();
    } catch (e) {
      // the broadcast may or may not have reached the node: keep the row and let reconciliation decide
      d.log(`settlement ${tx} for ${vault} broadcast failed, left pending: ${(e as Error).message}`);
      return { usage, tx, pending: true };
    }
    const status = await waitForStatus(d, vault, tx);
    if (status === "success") {
      return (await applySettlement(d, pending)) ? { usage, tx } : { usage, tx, pending: true };
    }
    if (status === "reverted") {
      await clearReverted(d, pending);
      return null;
    }
    d.log(`settlement ${tx} for ${vault} not confirmed yet: left pending, vault stays closed`);
    return { usage, tx, pending: true };
  } finally {
    settlingVaults.delete(key);
  }
}

export async function tick(d: KeeperDeps, now: number = Date.now()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await reconcilePending(d, now);
    await resolvePendingModelCalls(d, now);
    await syncAll(d);
    const lastReport = Number(d.store.getMeta("lastReport") ?? 0);
    if (now - lastReport >= DAY_MS) {
      await reportAll(d, now);
      await checkDrift(d);
    }
    const month = monthOf(now);
    // a vault without a marker starts at the last month the keeper ran (this month on the first tick ever)
    const initial = d.store.getMeta("lastSettleMonth") ?? month;
    for (const v of d.store.listVaults()) {
      const mk = settledMonthKey(v.vault);
      let marker = d.store.getMeta(mk);
      if (marker === undefined) {
        marker = initial;
        d.store.setMeta(mk, marker);
      }
      if (marker === month || d.store.pendingSettlement(v.vault)) continue;
      if (now < Number(d.store.getMeta(retryAfterKey(v.vault)) ?? 0)) continue;
      try {
        await settleVault(d, v.vault, now); // a success writes the marker with its bookkeeping
      } catch (e) {
        d.log(`settle ${v.vault} failed: ${(e as Error).message}`);
      }
    }
    d.store.setMeta("lastSettleMonth", month);
  } finally {
    ticking = false;
  }
}

/** USDC a key may still spend on tools from the last synced state. Zero for a revoked key or a closed vault. */
export function toolBudgetFor(store: Store, params: Params, keyId: string): number {
  const key = store.keyById(keyId);
  if (!key || key.revoked) return 0;
  const v = store.vault(key.vault);
  if (!v || v.settling) return 0;
  const l = computeLimits(v.yieldUsd, store.keysForVault(key.vault), params, v.frozen).find((x) => x.id === keyId);
  return l ? toolBudgetUsd(l, params) : 0;
}
```

- [ ] **Step 2: Rename `keyHash` to `keyId` in `app/mcp.ts` and `app/tools.ts`**

In `app/mcp.ts`, replace every `keyHash` with `keyId` (three places: the `buildMcpServer` parameter, the `gateway.run` call, the `console.error` line). In `app/tools.ts`, replace every `keyHash` with `keyId` (the two callback types in `toolGateway`'s parameter, and the `run` method's parameter and its uses). No logic changes. `app/test/mcp.test.ts` and `app/test/tools.test.ts` pass positional strings and need no change.

- [ ] **Step 3: Give the keeper its decrypt in `app/cli.ts`**

Add the import `import { secretBox } from "./crypto.ts";` after the `loadConfig` import. Replace the `keeper` line with:

```ts
const box = secretBox(cfg.keyEncryptionKey);
const keeper: KeeperDeps = {
  chain, store, or, params: cfg.params, decrypt: box.decrypt,
  log: (m) => console.log(new Date().toISOString(), m),
};
```

(`box.encrypt` is used by the server in Task 5.)

- [ ] **Step 4: Write the keeper tests**

Replace `app/test/keeper.test.ts` with:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../store.ts";
import {
  syncVault, syncAll, settleVault, reportAll, tick, toolBudgetFor, reconcilePending, resolvePendingModelCalls, checkDrift,
  type KeeperDeps,
} from "../keeper.ts";
import type { Chain, TxStatus } from "../chain.ts";
import type { OpenRouter } from "../openrouter.ts";
import { HACKATHON_PARAMS } from "../../engine/ledger.ts";

const V = "0x00000000000000000000000000000000000000aa";
const OR = "orhash";

/** Yield defaults to $2,000. orUsage is the sequence of cumulative usage readings OpenRouter returns for the company key. */
function setup(opts: { yieldMicro?: bigint; lossPending?: boolean; orUsage?: number[]; status?: TxStatus; noOrKey?: boolean } = {}) {
  const events: string[] = [];
  const logs: string[] = [];
  const store = openStore(":memory:");
  store.addVault(V, "0x00000000000000000000000000000000000000cc", "T");
  if (!opts.noOrKey) store.setVaultOpenRouterKey(V, OR, "enc:sk-or-v1-company");
  store.addKey({ id: "k1", vault: V, name: "a", weight: 1, secretSha256: "s1" });
  store.addKey({ id: "k2", vault: V, name: "b", weight: 1, secretSha256: "s2" });
  const usage = opts.orUsage ?? [0];
  const ctl = { status: opts.status ?? ("success" as TxStatus), known: true, prepared: 0, generations: {} as Record<string, number> };
  const chain: Chain = {
    yieldOf: async () => opts.yieldMicro ?? 2_000_000_000n,
    lossPending: async () => opts.lossPending ?? false,
    report: async (v) => { events.push(`report:${v}`); return "0xr"; },
    totalAssets: async () => 1_000_000_000n,
    settle: async (v, u) => chain.sendSettle(v, u),
    // each prepared transaction gets its own hash: "0xs", then "0xs2", "0xs3", ...; send() records the broadcast
    prepareSettle: async (v, u) => {
      ctl.prepared++;
      const hash = ctl.prepared === 1 ? "0xs" : `0xs${ctl.prepared}`;
      return { hash, send: async () => { events.push(`settle:${u}`); } };
    },
    sendSettle: async (v, u) => { const p = await chain.prepareSettle(v, u); await p.send(); return p.hash; },
    settleStatus: async () => ctl.status,
    transactionKnown: async () => ctl.known,
    customerOf: async () => "0x00000000000000000000000000000000000000cc",
  };
  const or: OpenRouter = {
    createKey: async () => ({ key: "k", hash: "h" }),
    getKey: async (h) => {
      const u = usage.length > 1 ? usage.shift()! : usage[0];
      events.push(`get:${h}:${u}`);
      return { hash: h, usage: u, limit: null, disabled: false };
    },
    setLimit: async (h, l) => { events.push(`limit:${h}:${l}`); },
    deleteKey: async () => {},
    getGeneration: async (id, apiKey) => {
      events.push(`gen:${id}:${apiKey}`);
      const cost = ctl.generations[id];
      return cost === undefined ? undefined : { id, model: "m", totalCost: cost };
    },
  };
  const d: KeeperDeps = {
    chain, store, or, params: HACKATHON_PARAMS, log: (m) => logs.push(m), sleep: async () => {},
    decrypt: (e) => e.replace(/^enc:/, ""),
  };
  let gen = 0;
  /** A metered model call on a key, as the proxy records it. */
  const spend = (keyId: string, usd: number) => store.recordModelCall({ keyId, model: "m", costUsd: usd, generationId: `g${++gen}` });
  return { d, store, events, logs, ctl, spend };
}

const OCT = Date.UTC(2026, 9, 10, 12, 0);
const NOV = Date.UTC(2026, 10, 1, 0, 0);
const MIN = 60_000;
const settles = (events: string[]) => events.filter((e) => e.startsWith("settle:")).length;
const lastLimit = (events: string[]) => events.filter((e) => e.startsWith(`limit:${OR}:`)).at(-1);

test("sync pins the company key at its usage plus open credit and stores yield", async () => {
  const { d, store, events, spend } = setup({ orUsage: [100] });
  spend("k1", 100); // k1 has 900 of its 1,000 left, k2 all of its 1,000
  await syncVault(d, V);
  assert.ok(events.includes(`limit:${OR}:2000`)); // 100 used + 1,900 open
  const v = store.vault(V)!;
  assert.equal(v.yieldUsd, 2_000);
  assert.equal(v.orLimit, 2000);
  assert.equal(v.orUsage, 100);
});

test("a vault without an OpenRouter key on file syncs its yield and pins nothing", async () => {
  const { d, store, events, logs } = setup({ noOrKey: true });
  await syncVault(d, V);
  assert.equal(store.vault(V)!.yieldUsd, 2_000);
  assert.ok(!events.some((e) => e.startsWith("limit:")));
  assert.ok(logs.some((m) => m.includes("no OpenRouter key on file")));
});

test("freezes the company key at its usage when a loss is pending", async () => {
  const { d, store, events } = setup({ lossPending: true, orUsage: [47.5] });
  await syncVault(d, V);
  assert.ok(events.includes(`limit:${OR}:47.5`));
  assert.equal(store.vault(V)!.frozen, true);
});

test("skips settlement when a loss is pending", async () => {
  const { d, store, events } = setup({ lossPending: true });
  assert.equal(await settleVault(d, V), null);
  assert.ok(!events.some((e) => e.startsWith("settle:")));
  assert.equal(store.vault(V)!.settling, false);
});

test("settle closes the vault, pins the backstop, drains in-flight metering, then settles", async () => {
  const { d, store, events, spend } = setup({ orUsage: [100] });
  spend("k1", 100);
  d.drain = async (vault, ms) => {
    events.push(`drain:${vault}:${ms}`);
    assert.equal(store.vault(V)!.settling, true);
    spend("k1", 1); // a request that was in flight finishes metering during the drain
  };
  const r = await settleVault(d, V);
  const iFreeze = events.indexOf(`limit:${OR}:100`);
  const iDrain = events.indexOf(`drain:${V}:10000`);
  const iSettle = events.findIndex((e) => e.startsWith("settle:"));
  assert.ok(iFreeze >= 0 && iFreeze < iDrain && iDrain < iSettle, events.join(","));
  assert.equal(r!.usage, 101_000_000n);
  assert.equal(store.vault(V)!.period, 1);
  assert.equal(store.vault(V)!.settling, false);
  assert.equal(store.keyById("k1")!.modelSpent, 0);
  assert.equal(store.listSettlements().length, 1);
  assert.equal(lastLimit(events), `limit:${OR}:2100`); // reopened after settlement: 100 used + 2,000 open
});

test("settlement usage is model cost over the rail fee plus tool spend", async () => {
  const { d, store, spend } = setup();
  d.params = { ...HACKATHON_PARAMS, railFee: 0.05 };
  spend("k1", 19);
  store.recordToolCall("k2", "a", "/b", 10);
  const r = await settleVault(d, V);
  assert.equal(r!.usage, 30_000_000n);
});

test("reportAll reports every vault and survives a failing one", async () => {
  const { d, store, events } = setup();
  store.addVault("0x00000000000000000000000000000000000000bb", "0x1", "U");
  const orig = d.chain.report;
  d.chain.report = async (v) => { if (v.endsWith("aa")) throw new Error("boom"); return orig(v); };
  await reportAll(d, 5);
  assert.ok(events.includes("report:0x00000000000000000000000000000000000000bb"));
  assert.equal(store.getMeta("lastReport"), "5");
});

test("reportAll skips an empty vault", async () => {
  const empty = "0x00000000000000000000000000000000000000bb";
  const { d, store, events } = setup();
  store.addVault(empty, "0x1", "U");
  d.chain.totalAssets = async (v) => (v === empty ? 1_000n : 1_000_000_000n);
  await reportAll(d, 5);
  assert.ok(!events.includes(`report:${empty}`));
  assert.ok(events.includes(`report:${V}`));
});

test("tick reports once a day with a drift check, and settles on a new month, not on first run", async () => {
  const { d, store, events, logs, spend } = setup({ orUsage: [1.5] });
  spend("k1", 1.5);
  const day1 = Date.UTC(2026, 9, 1, 0, 0);
  await tick(d, day1);
  assert.equal(events.filter((e) => e.startsWith("report:")).length, 1);
  assert.equal(events.filter((e) => e.startsWith("settle:")).length, 0);
  assert.ok(logs.includes(`drift ${V}: openrouter usage 1.5 recorded 1.5 drift 0`), logs.join("\n"));
  await tick(d, day1 + 60_000);
  assert.equal(events.filter((e) => e.startsWith("report:")).length, 1);
  assert.equal(logs.filter((m) => m.startsWith("drift ")).length, 1);
  await tick(d, Date.UTC(2026, 10, 1, 0, 0));
  assert.equal(events.filter((e) => e.startsWith("settle:")).length, 1);
  assert.equal(store.getMeta("lastSettleMonth"), "2026-11");
});

test("the drift check compares the company key's usage with recorded model cost", async () => {
  const { d, logs, spend } = setup({ orUsage: [3] });
  spend("k1", 1);
  spend("k2", 1.5);
  await checkDrift(d);
  assert.ok(logs.includes(`drift ${V}: openrouter usage 3 recorded 2.5 drift 0.5`), logs.join("\n"));
});

test("pending model calls are resolved through the generation lookup with the company key", async () => {
  const { d, store, events, ctl } = setup();
  store.recordPendingModelCall({ keyId: "k1", model: "m", generationId: "gen-1" });
  store.recordPendingModelCall({ keyId: "k1", model: "m", generationId: "gen-2" });
  ctl.generations["gen-1"] = 0.25;
  await resolvePendingModelCalls(d, OCT);
  assert.ok(events.includes("gen:gen-1:sk-or-v1-company")); // decrypted, never the stored form
  assert.equal(store.modelCall("gen-1")!.status, "recorded");
  assert.equal(store.modelCall("gen-1")!.costUsd, 0.25);
  assert.equal(store.modelCall("gen-2")!.status, "pending");
  assert.equal(store.keyById("k1")!.modelSpent, 0.25);
  ctl.generations["gen-2"] = 0.5;
  await tick(d, OCT + MIN); // the tick resolves the rest
  assert.equal(store.listPendingModelCalls().length, 0);
  assert.equal(store.keyById("k1")!.modelSpent, 0.75);
});

test("a pending model call unresolved for a day is logged, not dropped", async () => {
  const { d, store, logs } = setup();
  store.recordPendingModelCall({ keyId: "k1", model: "m", generationId: "gen-old" }, OCT - 2 * 86_400_000);
  d.or.getGeneration = async () => { throw new Error("rate limited"); };
  await resolvePendingModelCalls(d, OCT);
  assert.equal(store.listPendingModelCalls().length, 1);
  assert.ok(logs.some((m) => m.includes("gen-old") && m.includes("lookup failed")));
  assert.ok(logs.some((m) => m.includes("gen-old") && m.includes("unresolved for 48 h")));
  d.or.getGeneration = async () => undefined;
  await resolvePendingModelCalls(d, OCT + MIN);
  assert.equal(store.listPendingModelCalls().length, 1);
});

test("overlapping ticks do not run twice", async () => {
  const { d, events } = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const orig = d.chain.report;
  d.chain.report = async (v) => { await gate; return orig(v); };
  const day1 = Date.UTC(2026, 9, 1, 0, 0);
  const p1 = tick(d, day1);
  const p2 = tick(d, day1 + 1000); // second tick while the first is still in flight
  release();
  await Promise.all([p1, p2]);
  assert.equal(events.filter((e) => e.startsWith("report:")).length, 1);
  const syncedBefore = events.filter((e) => e === `get:${OR}:0`).length;
  await tick(d, day1 + 86_400_000 + 60_000); // a third tick, after both earlier ones settled
  const syncedAfter = events.filter((e) => e === `get:${OR}:0`).length;
  assert.equal(events.filter((e) => e.startsWith("report:")).length, 2);
  assert.equal(syncedAfter, syncedBefore + 2); // one sync read plus one drift read
});

test("a vault already settling is not settled twice", async () => {
  const { d, events } = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const orig = d.chain.prepareSettle;
  d.chain.prepareSettle = async (v, u) => { await gate; return orig(v, u); };
  const p1 = settleVault(d, V);
  const p2 = settleVault(d, V);
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(events.filter((e) => e.startsWith("settle:")).length, 1);
  assert.ok(r1 !== null);
  assert.equal(r2, null);
});

test("toolBudgetFor uses the last synced state and refuses revoked keys and closed vaults", async () => {
  const { d, store, spend } = setup();
  spend("k1", 100);
  await syncVault(d, V);
  store.recordToolCall("k1", "a", "/b", 50);
  assert.equal(toolBudgetFor(store, HACKATHON_PARAMS, "k1"), 850);
  assert.equal(toolBudgetFor(store, HACKATHON_PARAMS, "nope"), 0);
  store.setSettling(V, true);
  assert.equal(toolBudgetFor(store, HACKATHON_PARAMS, "k1"), 0);
  store.setSettling(V, false);
  store.revokeKey("k1");
  assert.equal(toolBudgetFor(store, HACKATHON_PARAMS, "k1"), 0);
  assert.equal(toolBudgetFor(store, HACKATHON_PARAMS, "k2"), 1850); // the pool cap: 2,000 credit minus k1's 150 spent
});

test("a sync during settlement does not reopen the backstop", async () => {
  const { d, store, events, spend } = setup({ orUsage: [100] });
  spend("k1", 100);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const waiting = new Promise<void>((r) => { entered = r; });
  const orig = d.chain.prepareSettle;
  d.chain.prepareSettle = async (v, u) => { entered(); await gate; return orig(v, u); };
  const p = settleVault(d, V);
  await waiting;
  await syncAll(d); // a minute tick or POST /api/admin/sync while the settlement is in flight
  assert.deepEqual(events.filter((e) => e.startsWith(`limit:${OR}:`)), [`limit:${OR}:100`]); // only the freeze
  release();
  const r = await p;
  assert.equal(r!.usage, 100_000_000n);
  assert.equal(store.vault(V)!.period, 1);
});

test("a stale settling flag is cleared by the next sync", async () => {
  const { d, store, logs } = setup();
  store.setSettling(V, true); // e.g. the process died between the freeze and the pending row
  await syncVault(d, V);
  assert.equal(store.vault(V)!.settling, false);
  assert.ok(logs.some((m) => m.includes("stale settling flag cleared")));
});

test("settling an unknown vault does nothing", async () => {
  const { d, store, events } = setup();
  assert.equal(await settleVault(d, "0x00000000000000000000000000000000000000bb"), null);
  assert.ok(!events.some((e) => e.startsWith("settle:")));
  assert.equal(store.listSettlements().length, 0);
});

test("a settlement is persisted before the broadcast", async () => {
  const { d, store, spend } = setup({ orUsage: [100], status: "pending" });
  spend("k1", 100);
  const orig = d.chain.prepareSettle;
  let persistedAtSend: string | undefined;
  d.chain.prepareSettle = async (v, u) => {
    const p = await orig(v, u);
    assert.equal(store.pendingSettlement(V), undefined); // nothing persisted until the hash is known
    return { hash: p.hash, send: async () => { persistedAtSend = store.pendingSettlement(V)?.tx; await p.send(); } };
  };
  const r = await settleVault(d, V, OCT);
  assert.equal(persistedAtSend, "0xs");
  assert.deepEqual(r, { usage: 100_000_000n, tx: "0xs", pending: true });
  const p = store.pendingSettlement(V)!;
  assert.equal(p.usageMicro, 100_000_000n);
  assert.deepEqual(p.baselines, [{ keyId: "k1", spentUsd: 100 }, { keyId: "k2", spentUsd: 0 }]);
  assert.equal(p.createdAt, OCT);
  assert.equal(store.vault(V)!.period, 0);
  assert.equal(store.vault(V)!.settling, true); // the proxy keeps refusing until the receipt is seen
  assert.equal(store.listSettlements().length, 0);
});

test("an error while waiting for the receipt leaves the settlement pending", async () => {
  const { d, store, spend } = setup({ orUsage: [100] });
  spend("k1", 100);
  d.chain.settleStatus = async () => { throw new Error("rpc down"); };
  const r = await settleVault(d, V, OCT);
  assert.equal(r!.pending, true);
  assert.equal(store.pendingSettlement(V)!.tx, "0xs");
  assert.equal(store.listSettlements().length, 0);
});

test("reconciliation applies the bookkeeping once", async () => {
  const { d, store, events, ctl, spend } = setup({ orUsage: [100], status: "pending" });
  spend("k1", 100);
  await settleVault(d, V, OCT);
  ctl.status = "success";
  await tick(d, OCT + MIN);
  assert.equal(store.listSettlements().length, 1);
  assert.equal(store.listSettlements()[0].usageMicro, "100000000");
  assert.equal(store.vault(V)!.period, 1);
  assert.equal(store.vault(V)!.settling, false);
  assert.equal(store.keyById("k1")!.modelSpent, 0);
  assert.equal(store.pendingSettlement(V), undefined);
  assert.equal(store.getMeta("settledMonth:" + V), "2026-10");
  await tick(d, OCT + 2 * MIN);
  await reconcilePending(d, OCT + 3 * MIN);
  assert.equal(store.listSettlements().length, 1);
  assert.equal(store.vault(V)!.period, 1);
  assert.equal(settles(events), 1);
});

test("a reverted settlement clears the pending row, moves nothing and reopens the vault", async () => {
  const { d, store, events, spend } = setup({ orUsage: [100], status: "reverted" });
  spend("k1", 100);
  assert.equal(await settleVault(d, V, OCT), null);
  assert.equal(store.pendingSettlement(V), undefined);
  assert.equal(store.listSettlements().length, 0);
  assert.equal(store.vault(V)!.period, 0);
  assert.equal(store.vault(V)!.settling, false);
  assert.equal(store.keyById("k1")!.modelSpent, 100); // still this period's spend
  assert.equal(lastLimit(events), `limit:${OR}:2000`); // the freeze at 100 was lifted: 100 used + 1,900 open
});

test("reconciling a reverted settlement clears the row and moves nothing", async () => {
  const { d, store, events, ctl, spend } = setup({ orUsage: [100], status: "pending" });
  spend("k1", 100);
  await settleVault(d, V, OCT);
  ctl.status = "reverted";
  await reconcilePending(d, OCT + MIN);
  assert.equal(store.pendingSettlement(V), undefined);
  assert.equal(store.listSettlements().length, 0);
  assert.equal(store.vault(V)!.period, 0);
  assert.equal(store.vault(V)!.settling, false);
  assert.equal(lastLimit(events), `limit:${OR}:2000`);
});

test("a vault with a pending settlement is not synced or settled again", async () => {
  const { d, store, events, spend } = setup({ orUsage: [100], status: "pending" });
  spend("k1", 100);
  await tick(d, OCT); // first tick: marks the month, settles nothing
  await settleVault(d, V, OCT);
  const before = events.length;
  await syncAll(d);
  await syncVault(d, V);
  assert.equal(events.length, before); // no usage reads, no limit writes: the vault stays closed
  const r = await settleVault(d, V, OCT);
  assert.deepEqual(r, { usage: 100_000_000n, tx: "0xs", pending: true });
  await tick(d, NOV); // a new month, but the vault still has a pending settlement
  assert.equal(settles(events), 1);
  assert.equal(store.listPendingSettlements().length, 1);
});

test("a failed settlement is retried on a later tick within the month", async () => {
  const { d, store, events } = setup();
  await tick(d, OCT);
  const orig = d.chain.prepareSettle;
  d.chain.prepareSettle = async () => { throw new Error("simulation failed"); };
  await tick(d, NOV);
  assert.equal(settles(events), 0);
  assert.equal(store.pendingSettlement(V), undefined);
  assert.equal(store.getMeta("settledMonth:" + V), "2026-10");
  d.chain.prepareSettle = orig;
  await tick(d, NOV + 10 * MIN); // once the backoff has passed
  assert.equal(settles(events), 1);
  assert.equal(store.listSettlements().length, 1);
  assert.equal(store.getMeta("settledMonth:" + V), "2026-11");
  await tick(d, NOV + 20 * MIN);
  assert.equal(settles(events), 1);
});

test("a failed prepare reopens the vault and backs off before retrying", async () => {
  const { d, store, events, ctl, spend } = setup({ orUsage: [100] });
  spend("k1", 100);
  await tick(d, OCT);
  const orig = d.chain.prepareSettle;
  d.chain.prepareSettle = async () => { ctl.prepared++; throw new Error("simulation failed"); };
  await tick(d, NOV);
  assert.equal(ctl.prepared, 1);
  assert.ok(events.includes(`limit:${OR}:100`)); // the freeze happened
  assert.equal(lastLimit(events), `limit:${OR}:2000`); // and was lifted within the same tick
  assert.equal(store.vault(V)!.settling, false);
  assert.equal(store.getMeta("settleRetryAfter:" + V), String(NOV + 10 * MIN));
  await tick(d, NOV + 5 * MIN);
  assert.equal(ctl.prepared, 1); // within the backoff: not retried
  d.chain.prepareSettle = orig;
  await tick(d, NOV + 10 * MIN);
  assert.equal(settles(events), 1);
  assert.equal(store.listSettlements().length, 1);
});

test("a vault registered mid-month is not settled that month", async () => {
  const { d, store, events } = setup();
  const W = "0x00000000000000000000000000000000000000bb";
  await tick(d, OCT);
  store.addVault(W, "0x00000000000000000000000000000000000000cc", "U");
  await tick(d, OCT + 86_400_000);
  assert.equal(settles(events), 0);
  assert.equal(store.getMeta("settledMonth:" + W), "2026-10");
  await tick(d, NOV);
  assert.equal(settles(events), 2); // both vaults settle in the next month
});

test("a reconcile in flight holds the vault, so a revert cannot drop a newer settlement", async () => {
  const { d, store, events, ctl, spend } = setup({ orUsage: [100], status: "pending" });
  spend("k1", 100);
  await settleVault(d, V, OCT); // pending row for 0xs
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const waiting = new Promise<void>((r) => { entered = r; });
  let gated = false;
  d.chain.settleStatus = async (tx) => {
    if (tx !== "0xs") return ctl.status;
    if (!gated) { gated = true; entered(); await gate; } // only the reconcile's lookup waits
    return "reverted";
  };
  const reconciling = reconcilePending(d, OCT + MIN);
  await waiting;
  // an admin settle while the reconcile waits on the old receipt must not start a new settlement
  assert.equal(await settleVault(d, V, OCT + MIN), null);
  assert.equal(settles(events), 1);
  release();
  await reconciling;
  assert.equal(store.pendingSettlement(V), undefined);
  ctl.status = "success";
  const r = await settleVault(d, V, OCT + 2 * MIN);
  assert.deepEqual(r, { usage: 100_000_000n, tx: "0xs2" });
  await reconcilePending(d, OCT + 3 * MIN);
  assert.deepEqual(store.listSettlements().map((x) => x.tx), ["0xs2"]);
  assert.equal(store.vault(V)!.period, 1);
});

test("a mined settlement whose row vanished is reported pending, not settled", async () => {
  const { d, store, spend } = setup({ orUsage: [100] });
  spend("k1", 100);
  let polls = 0;
  d.chain.settleStatus = async (tx) => {
    if (polls++ === 0) {
      store.clearPendingSettlement(V, tx); // e.g. the admin escape hatch while the receipt was awaited
      return "pending";
    }
    return "success";
  };
  const r = await settleVault(d, V, OCT);
  assert.deepEqual(r, { usage: 100_000_000n, tx: "0xs", pending: true });
  assert.equal(store.listSettlements().length, 0);
  assert.equal(store.vault(V)!.period, 0);
});

test("an ambiguous broadcast stays pending and is not sent twice", async () => {
  const { d, store, events, ctl, spend } = setup({ orUsage: [100], status: "pending" });
  spend("k1", 100);
  await tick(d, OCT);
  const orig = d.chain.prepareSettle;
  d.chain.prepareSettle = async (v, u) => {
    const p = await orig(v, u);
    return { hash: p.hash, send: async () => { await p.send(); throw new Error("send timed out"); } };
  };
  await tick(d, NOV);
  assert.equal(settles(events), 1);
  assert.equal(store.pendingSettlement(V)!.tx, "0xs");
  assert.equal(store.getMeta("settleRetryAfter:" + V), undefined); // not a prepare failure
  await tick(d, NOV + MIN);
  assert.equal(settles(events), 1); // still pending: no second send
  ctl.status = "success";
  await tick(d, NOV + 2 * MIN);
  assert.equal(store.listSettlements().length, 1);
  assert.equal(store.pendingSettlement(V), undefined);
  assert.equal(store.getMeta("settledMonth:" + V), "2026-11");
  await tick(d, NOV + 3 * MIN);
  assert.equal(settles(events), 1);
  assert.equal(store.listSettlements().length, 1);
});

test("a settlement unknown to the node past the age limit is cleared and retried", async () => {
  const { d, store, events, ctl, spend } = setup({ orUsage: [100], status: "pending" });
  spend("k1", 100);
  let lookups = 0;
  d.chain.transactionKnown = async () => { lookups++; return ctl.known; };
  await tick(d, OCT);
  await tick(d, NOV); // sends 0xs, which never mines
  ctl.known = false;
  await tick(d, NOV + 10 * MIN);
  assert.equal(lookups, 0); // young rows are not looked up
  assert.equal(store.pendingSettlement(V)!.tx, "0xs");
  await tick(d, NOV + 31 * MIN);
  assert.equal(lookups, 1);
  // cleared, then the month rule settled the vault again in the same tick
  assert.equal(settles(events), 2);
  assert.equal(store.pendingSettlement(V)!.tx, "0xs2");
});

test("a settlement known to the node but unmined stays pending past the age limit", async () => {
  const { d, store, logs, spend } = setup({ orUsage: [100], status: "pending" });
  spend("k1", 100);
  await settleVault(d, V, OCT);
  await tick(d, OCT + 31 * MIN);
  assert.equal(store.pendingSettlement(V)!.tx, "0xs");
  assert.equal(store.vault(V)!.settling, true);
  assert.ok(logs.some((m) => m.includes("still unmined after 31 min")));
});

test("a second settle that loses the persist race does not broadcast", async () => {
  // a second copy of the keeper module has its own in-process guard, like the CLI in another process
  const other: typeof import("../keeper.ts") = await import(new URL("../keeper.ts?process=cli", import.meta.url).href);
  const { d, store, events, ctl, spend } = setup({ orUsage: [100], status: "pending" });
  spend("k1", 100);
  const orig = d.chain.prepareSettle;
  const gates: (() => void)[] = [];
  const entered: Promise<void>[] = [];
  const arrivals: (() => void)[] = [];
  for (let i = 0; i < 2; i++) entered.push(new Promise<void>((r) => { arrivals.push(r); }));
  let calls = 0;
  d.chain.prepareSettle = async (v, u) => {
    const i = calls++;
    const p = await orig(v, u);
    await new Promise<void>((r) => { gates[i] = r; arrivals[i](); });
    return p;
  };
  const first = settleVault(d, V, OCT); // the server's settlement: 0xs
  const second = other.settleVault(d, V, OCT); // the CLI's: 0xs2, signed while the first is in flight
  await Promise.all(entered);
  gates[0]();
  assert.deepEqual(await first, { usage: 100_000_000n, tx: "0xs", pending: true });
  gates[1]();
  const r2 = await second;
  assert.equal(settles(events), 1); // exactly one broadcast
  assert.equal(store.pendingSettlement(V)!.tx, "0xs");
  assert.deepEqual(r2, { usage: 100_000_000n, tx: "0xs", pending: true });
  assert.equal(store.getMeta("settleRetryAfter:" + V), undefined);
  ctl.status = "success";
  await reconcilePending(d, OCT + MIN);
  await other.reconcilePending(d, OCT + 2 * MIN);
  assert.deepEqual(store.listSettlements().map((x) => x.tx), ["0xs"]);
  assert.equal(store.vault(V)!.period, 1);
  assert.equal(store.vault(V)!.settling, false);
  assert.equal(store.pendingSettlement(V), undefined);
});
```

- [ ] **Step 5: Run the keeper, mcp, tools, store and limits suites, then the typecheck**

Run: `node --test app/test/keeper.test.ts app/test/mcp.test.ts app/test/tools.test.ts app/test/store.test.ts app/test/limits.test.ts && npm run typecheck`
Expected: all pass. The typecheck now reports errors only in `app/server.ts`, `app/cli.ts` (the `createApp` call) and `app/test/server.test.ts`; Task 5 repairs them.

If `overlapping ticks do not run twice` fails on the `syncedAfter` count, count the `get:` events the third tick makes (one from `syncAll`, one from `checkDrift`) and fix the expectation to match the code, not the other way round.

- [ ] **Step 6: Commit**

```bash
git add app/keeper.ts app/test/keeper.test.ts app/mcp.ts app/tools.ts app/cli.ts
git commit -m "Keeper: one OpenRouter key per company, freeze and drain before settlement, pending model calls, drift check"
```

---

### Task 5: Server: Inferest keys (create, revoke, rotate) and the company key on registration

**Branch:** `proxy-key-model` (continues Task 4's branch). At the end of this task `npm test` and `npm run typecheck` are fully green again; merge the branch into `main` with `--no-ff` after the review.

**Files:**
- Modify: `app/server.ts` (whole file)
- Modify: `app/test/server.test.ts` (whole file)
- Modify: `app/cli.ts:25-30` (`createApp` gets `secrets`)

**Interfaces:**
- Consumes: `newInferestKey`, `sha256`, `SecretBox` (Task 1); store methods (Task 3); `KeeperDeps.decrypt` (Task 4).
- Produces: `AppDeps` gains `secrets: SecretBox`. Routes: `POST /api/vaults` also creates the vault's OpenRouter key (`inferest:vault:<first 8 hex chars>`, limit 0) and files it encrypted; `POST /api/keys` returns `{ key: "sk-inf-...", id }`; `POST /api/keys/:id/weight`, `POST /api/keys/:id/revoke` (`{ ok: true }`), `POST /api/keys/:id/rotate` (`{ key, id }`, 409 `{ error: "key is revoked" }` on a revoked key); all three 404 `{ error: "unknown key" }` for an unknown id. `/mcp` rejects revoked keys with 401. `GET /api/state` vault objects: `{ vault, customer, label, period, frozen, settling, yieldUsd, orLimit, orUsage, hasOpenRouterKey, keys: [{ id, name, weight, revoked, createdAt, modelSpent, toolSpent, budget, spent, remaining }] }`; never the OpenRouter secret in any form.

- [ ] **Step 1: Write the failing server tests**

Replace `app/test/server.test.ts` with:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp, sha256, type AppDeps } from "../server.ts";
import { openStore } from "../store.ts";
import { HACKATHON_PARAMS } from "../../engine/ledger.ts";
import type { ToolGateway } from "../tools.ts";

const V = "0x00000000000000000000000000000000000000aa";
const ZERO = "0x0000000000000000000000000000000000000000";

async function start(customer = "0x00000000000000000000000000000000000000cc") {
  const store = openStore(":memory:");
  const created: string[] = [];
  const d: AppDeps = {
    store,
    or: {
      createKey: async (name) => { created.push(name); return { key: "sk-or-v1-company", hash: "orhash" }; },
      getKey: async (h) => ({ hash: h, usage: 0, limit: 0, disabled: false }),
      setLimit: async () => {},
      deleteKey: async () => {},
      getGeneration: async () => undefined,
    },
    chain: {
      yieldOf: async () => 0n, lossPending: async () => false,
      report: async () => "0x", settle: async () => "0x", totalAssets: async () => 1_000_000_000n,
      prepareSettle: async () => ({ hash: "0x", send: async () => {} }), sendSettle: async () => "0x",
      settleStatus: async () => "success" as const, transactionKnown: async () => true,
      customerOf: async (v) => (v === V ? customer : ZERO),
    },
    gateway: { search: async () => [], details: async () => ({}), run: async () => ({}) } as unknown as ToolGateway,
    params: HACKATHON_PARAMS,
    adminToken: "admin",
    publicConfig: { chainId: 42161 },
    secrets: { encrypt: (p) => `enc:${p}`, decrypt: (e) => e.replace(/^enc:/, "") },
    keeper: undefined as unknown as AppDeps["keeper"],
  };
  d.keeper = { chain: d.chain, store, or: d.or, params: d.params, log: () => {}, sleep: async () => {}, decrypt: d.secrets.decrypt };
  const server = createApp(d);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, server, store, created, d };
}

const post = (base: string, path: string, body: unknown, token = "admin") =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", "x-admin-token": token }, body: JSON.stringify(body) });

const mcpList = (base: string, bearer: string) =>
  fetch(base + "/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

test("mutating routes require the admin token", async () => {
  const { base, server } = await start();
  assert.equal((await post(base, "/api/vaults", { vault: V }, "wrong")).status, 401);
  assert.equal((await post(base, "/api/admin/sync", {}, "")).status, 401);
  server.close();
});

test("POST /api/vaults rejects a vault the factory does not know", async () => {
  const { base, server, created } = await start();
  const r = await post(base, "/api/vaults", { vault: "0x00000000000000000000000000000000000000bb" });
  assert.equal(r.status, 400);
  assert.equal(created.length, 0);
  server.close();
});

test("registering a vault creates its company OpenRouter key once and files it encrypted", async () => {
  const { base, server, store, created } = await start();
  const r = await post(base, "/api/vaults", { vault: V, label: "Treasury" });
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { vault: V, customer: "0x00000000000000000000000000000000000000cc" });
  assert.deepEqual(created, ["inferest:vault:00000000"]);
  assert.deepEqual(store.openRouterKeyFor(V), { hash: "orhash", encryptedSecret: "enc:sk-or-v1-company" });
  assert.equal((await post(base, "/api/vaults", { vault: V, label: "Treasury" })).status, 201);
  assert.equal(created.length, 1); // registering again does not mint a second key
  const state = await (await fetch(base + "/api/state")).text();
  assert.ok(!state.includes("sk-or-v1-company"));
  assert.ok(!state.includes("enc:"));
  assert.equal(JSON.parse(state).vaults[0].hasOpenRouterKey, true);
  server.close();
});

test("creating a key returns an sk-inf secret once and stores only its hash", async () => {
  const { base, server, store, created } = await start();
  await post(base, "/api/vaults", { vault: V, label: "Treasury" });
  const r = await post(base, "/api/keys", { vault: V, name: "dev-1", weight: 1 });
  assert.equal(r.status, 201);
  const body: any = await r.json();
  assert.match(body.key, /^sk-inf-[A-Za-z0-9_-]{32}$/);
  assert.match(body.id, /^[0-9a-f]{16}$/);
  assert.equal(store.keyBySecret(sha256(body.key))!.id, body.id);
  assert.equal(created.length, 1); // no OpenRouter key per developer any more
  const state: any = await (await fetch(base + "/api/state")).json();
  const k = state.vaults[0].keys[0];
  assert.equal(k.name, "dev-1");
  assert.equal(k.id, body.id);
  assert.equal(k.revoked, false);
  assert.deepEqual([k.modelSpent, k.toolSpent, k.spent], [0, 0, 0]);
  assert.ok(!JSON.stringify(state).includes(body.key));
  server.close();
});

test("creating a key for an unknown vault returns 404", async () => {
  const { base, server } = await start();
  assert.equal((await post(base, "/api/keys", { vault: V, name: "x", weight: 1 })).status, 404);
  server.close();
});

test("negative weights are rejected", async () => {
  const { base, server } = await start();
  await post(base, "/api/vaults", { vault: V });
  assert.equal((await post(base, "/api/keys", { vault: V, name: "x", weight: -1 })).status, 400);
  server.close();
});

test("MCP rejects an unknown key", async () => {
  const { base, server } = await start();
  assert.equal((await mcpList(base, "nope")).status, 401);
  server.close();
});

test("MCP rejects a revoked key", async () => {
  const { base, server } = await start();
  await post(base, "/api/vaults", { vault: V });
  const { key, id } = await (await post(base, "/api/keys", { vault: V, name: "dev-1", weight: 1 })).json();
  assert.notEqual((await mcpList(base, key)).status, 401);
  assert.equal((await post(base, `/api/keys/${id}/revoke`, {})).status, 200);
  assert.equal((await mcpList(base, key)).status, 401);
  server.close();
});

test("serves the dashboard", async () => {
  const { base, server } = await start();
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Inferest/);
  server.close();
});

test("settle rejects an unknown vault with 404", async () => {
  const { base, server, store } = await start();
  const r = await post(base, "/api/admin/settle", { vault: "0x00000000000000000000000000000000000000bb" });
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: "unknown vault" });
  assert.equal(store.listSettlements().length, 0);
  server.close();
});

test("500 bodies do not leak URLs", async () => {
  const { base, server, store, d } = await start();
  await post(base, "/api/vaults", { vault: V });
  d.chain.prepareSettle = async () => { throw new Error("boom https://secret-rpc.example/abc?key=1"); };
  const r = await post(base, "/api/admin/settle", { vault: V });
  assert.equal(r.status, 500);
  const body: any = await r.json();
  assert.ok(!body.error.includes("secret-rpc"));
  assert.ok(body.error.includes("[url]"));
  assert.equal(store.listSettlements().length, 0);

  d.chain.prepareSettle = async () => { throw new Error("boom HTTPS://secret-rpc.example/abc?key=1"); };
  const r2 = await post(base, "/api/admin/settle", { vault: V });
  assert.equal(r2.status, 500);
  const body2: any = await r2.json();
  assert.ok(!body2.error.includes("secret-rpc"));
  assert.ok(body2.error.includes("[url]"));

  server.close();
});

test("weight, revoke and rotate on an unknown key return 404", async () => {
  const { base, server } = await start();
  for (const action of ["weight", "revoke", "rotate"]) {
    const r = await post(base, `/api/keys/deadbeefdeadbeef/${action}`, { weight: 2 });
    assert.equal(r.status, 404, action);
    assert.deepEqual(await r.json(), { error: "unknown key" });
  }
  server.close();
});

test("weight change on a known key updates it", async () => {
  const { base, server, store } = await start();
  await post(base, "/api/vaults", { vault: V });
  const { id } = await (await post(base, "/api/keys", { vault: V, name: "dev-1", weight: 1 })).json();
  const r = await post(base, `/api/keys/${id}/weight`, { weight: 2 });
  assert.equal(r.status, 200);
  assert.equal(store.keyById(id)!.weight, 2);
  assert.equal((await post(base, `/api/keys/${id}/weight`, { weight: -3 })).status, 400);
  server.close();
});

test("rotate issues a new secret on the same key; revoke keeps the row and refuses further rotation", async () => {
  const { base, server, store } = await start();
  await post(base, "/api/vaults", { vault: V });
  const { key, id } = await (await post(base, "/api/keys", { vault: V, name: "dev-1", weight: 1 })).json();
  const rot = await post(base, `/api/keys/${id}/rotate`, {});
  assert.equal(rot.status, 200);
  const rotated: any = await rot.json();
  assert.equal(rotated.id, id);
  assert.match(rotated.key, /^sk-inf-/);
  assert.notEqual(rotated.key, key);
  assert.equal(store.keyBySecret(sha256(key)), undefined);
  assert.equal(store.keyBySecret(sha256(rotated.key))!.id, id);
  const rev = await post(base, `/api/keys/${id}/revoke`, {});
  assert.equal(rev.status, 200);
  assert.deepEqual(await rev.json(), { ok: true });
  assert.equal(store.keyById(id)!.revoked, true);
  assert.equal((await post(base, `/api/keys/${id}/revoke`, {})).status, 200); // idempotent
  const again = await post(base, `/api/keys/${id}/rotate`, {});
  assert.equal(again.status, 409);
  assert.deepEqual(await again.json(), { error: "key is revoked" });
  const state: any = await (await fetch(base + "/api/state")).json();
  assert.equal(state.vaults[0].keys[0].revoked, true);
  server.close();
});

test("registering a vault marks it settled for the current month", async () => {
  const { base, server, store } = await start();
  await post(base, "/api/vaults", { vault: V });
  assert.equal(store.getMeta("settledMonth:" + V), new Date().toISOString().slice(0, 7));
  server.close();
});

test("state exposes pending settlements and the settling flag", async () => {
  const { base, server, store } = await start();
  await post(base, "/api/vaults", { vault: V });
  store.setSettling(V, true);
  store.setPendingSettlement(V, { usageMicro: 12_345_678_901_234n, baselines: [], tx: "0xtx" });
  const state: any = await (await fetch(base + "/api/state")).json();
  assert.equal(state.vaults[0].settling, true);
  assert.equal(state.pendingSettlements.length, 1);
  const p = state.pendingSettlements[0];
  assert.deepEqual([p.vault, p.usageMicro, p.tx, typeof p.createdAt], [V, "12345678901234", "0xtx", "number"]);
  assert.equal("baselines" in p, false);
  server.close();
});

test("the admin settle route reports whether the settlement is pending", async () => {
  const { base, server, d } = await start();
  await post(base, "/api/vaults", { vault: V });
  const r = await post(base, "/api/admin/settle", { vault: V });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { usageMicro: "0", tx: "0x", pending: false });
  d.chain.settleStatus = async () => "pending";
  const r2 = await post(base, "/api/admin/settle", { vault: V });
  assert.deepEqual(await r2.json(), { usageMicro: "0", tx: "0x", pending: true });
  server.close();
});

test("the admin route clears a specific pending settlement", async () => {
  const { base, server, store, d } = await start();
  await post(base, "/api/vaults", { vault: V });
  await post(base, "/api/keys", { vault: V, name: "dev-1", weight: 1 });
  store.setPendingSettlement(V, { usageMicro: 5n, baselines: [], tx: "0xtx" });
  assert.equal((await post(base, "/api/admin/pending/clear", { vault: V, tx: "0xtx" }, "wrong")).status, 401);
  const wrongTx = await post(base, "/api/admin/pending/clear", { vault: V, tx: "0xother" });
  assert.equal(wrongTx.status, 404);
  assert.deepEqual(await wrongTx.json(), { error: "no such pending settlement" });
  assert.equal(store.pendingSettlement(V)!.tx, "0xtx");
  const limits: number[] = [];
  d.or.setLimit = async (_h, l) => { limits.push(l); };
  const ok = await post(base, "/api/admin/pending/clear", { vault: V, tx: "0xtx" });
  assert.equal(ok.status, 200);
  assert.equal(limits.length, 1); // the vault was re-synced at once
  assert.equal(store.pendingSettlement(V), undefined);
  assert.equal((await post(base, "/api/admin/pending/clear", { vault: V, tx: "0xtx" })).status, 404);
  server.close();
});

test("clearing a pending settlement is refused while the vault is settling", async () => {
  const { base, server, store, d } = await start();
  await post(base, "/api/vaults", { vault: V });
  store.setPendingSettlement(V, { usageMicro: 5n, baselines: [], tx: "0xtx" });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const waiting = new Promise<void>((r) => { entered = r; });
  // hold the vault in-process: the reconcile of the existing row waits on its receipt
  d.chain.settleStatus = async () => { entered(); await gate; return "pending"; };
  const settling = post(base, "/api/admin/settle", { vault: V });
  await waiting;
  const r = await post(base, "/api/admin/pending/clear", { vault: V, tx: "0xtx" });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: "vault is settling" });
  release();
  assert.equal((await settling).status, 200);
  assert.equal(store.pendingSettlement(V)!.tx, "0xtx");
  server.close();
});
```

- [ ] **Step 2: Run the server suite to verify it fails**

Run: `node --test app/test/server.test.ts`
Expected: failures on `secrets` not being an `AppDeps` field (at runtime: `d.store.addKey` complaining about a missing id, `hasOpenRouterKey` undefined, 404s on the revoke and rotate routes).

- [ ] **Step 3: Write `app/server.ts`**

Replace the whole file with:

```ts
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
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
import { sha256, newInferestKey, type SecretBox } from "./crypto.ts";
import { syncAll, syncVault, reportAll, settleVault, markRegistered, isSettling, type KeeperDeps } from "./keeper.ts";

export { sha256 } from "./crypto.ts";

export type AppDeps = {
  store: Store; or: OpenRouter; chain: Chain; gateway: ToolGateway; params: Params;
  adminToken: string; publicConfig: Record<string, unknown>; keeper: KeeperDeps;
  /** Encrypts each vault's OpenRouter key at rest. */
  secrets: SecretBox;
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

/** Mints the vault's single OpenRouter key (limit 0 until the keeper syncs) unless it already has one. */
async function ensureCompanyKey(d: AppDeps, vault: string): Promise<void> {
  if (d.store.openRouterKeyFor(vault)) return;
  const { key, hash } = await d.or.createKey(`inferest:vault:${vault.slice(2, 10)}`, 0);
  d.store.setVaultOpenRouterKey(vault, hash, d.secrets.encrypt(key));
}

async function route(d: AppDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

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
      d.store.addVault(vault, customer, String(body.label ?? "customer"));
      markRegistered(d.store, vault); // a vault added mid-month is first settled next month
      await ensureCompanyKey(d, vault);
      return send(res, 201, { vault, customer: customer.toLowerCase() });
    }
    if (url.pathname === "/api/keys") {
      const vault = String(body.vault ?? "").toLowerCase();
      if (!d.store.vault(vault)) return send(res, 404, { error: "unknown vault" });
      const weight = Number(body.weight ?? 1);
      if (!(weight >= 0)) return send(res, 400, { error: "weight must be >= 0" });
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
        if (!(weight >= 0)) return send(res, 400, { error: "weight must be >= 0" });
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
```

- [ ] **Step 4: Pass `secrets` from `app/cli.ts`**

In the `serve` case, add `secrets: box,` to the object passed to `createApp` (the `box` from Task 4's Step 3):

```ts
    const app = createApp({
      store, or, chain, gateway, params: cfg.params, adminToken: cfg.adminToken, keeper, secrets: box,
      publicConfig: { chainId: cfg.chainId, factory: cfg.factory, splitter: cfg.splitter, usdc: cfg.usdc, target: cfg.target },
    });
```

- [ ] **Step 5: Run the whole suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: every test passes; tsc prints nothing. If `MCP rejects a revoked key` sees 401 before the revoke, the bearer is not reaching `keyBySecret` unchanged: check that the test posts the exact secret returned by `/api/keys`.

- [ ] **Step 6: Commit, then merge the shared branch**

```bash
git add app/server.ts app/test/server.test.ts app/cli.ts
git commit -m "Server: Inferest keys with revoke and rotate; one OpenRouter key minted per vault at registration"
```

After the Task 5 review is clean, from `main`: `git merge --no-ff proxy-key-model`, run `npm test && npm run typecheck` on the merged tree, and delete the branch.

---

### Task 6: Proxy core: auth, budget check, non-streaming relay, metering, error rewrites, body cap

**Branch:** `proxy-core`

**Files:**
- Create: `app/proxy.ts`
- Create: `app/test/proxy.test.ts`
- Modify: `app/server.ts` (`AppDeps.proxy`, one line in `route`, the listen banner is in cli)
- Modify: `app/test/server.test.ts:16-40` (fixture gains `proxy`)
- Modify: `app/cli.ts` (build the proxy, hand `drain` to the keeper)

**Interfaces:**
- Consumes: store (Task 3), `computeLimits` (Task 3), `sha256` (Task 1), `KeeperDeps.drain` (Task 4), `AppDeps` (Task 5).
- Produces: `ProxyDeps { store, params, decrypt, fetchFn, upstream?, dashboardUrl, log }`; `Proxy { handle(req, res): Promise<boolean>; drain(vault, ms): Promise<void>; inFlight(vault): number }`; `createProxy(d): Proxy`; `MAX_BODY_BYTES = 4 * 1024 * 1024`; `DEFAULT_UPSTREAM = "https://openrouter.ai/api/v1"`; `fail(res, status, type, message, headers?)`; `checkBudget(store, params, key, dashboardUrl)`. `AppDeps.proxy: Proxy`. In this task `stream: true` is refused with 400; Task 7 replaces that branch with the SSE relay. Log line format: `proxy key <id> model <model> gen <generationId> cost $<n> <ms>ms <status>` (or `cost pending`).

- [ ] **Step 1: Write the failing proxy tests**

Create `app/test/proxy.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp, sha256, type AppDeps } from "../server.ts";
import { createProxy, MAX_BODY_BYTES } from "../proxy.ts";
import { openStore } from "../store.ts";
import { HACKATHON_PARAMS } from "../../engine/ledger.ts";
import type { ToolGateway } from "../tools.ts";

const V = "0x00000000000000000000000000000000000000aa";
const SECRET = "sk-inf-test-key";
const COMPANY = "sk-or-v1-company";

type Upstream = (url: string, init: RequestInit) => Response | Promise<Response>;

/** A real server whose proxy talks to a scripted upstream instead of OpenRouter. Yield defaults to $100. */
async function start(upstream: Upstream, opts: { yieldUsd?: number; frozen?: boolean } = {}) {
  const store = openStore(":memory:");
  store.addVault(V, "0x00000000000000000000000000000000000000cc", "T");
  store.setVaultOpenRouterKey(V, "orhash", `enc:${COMPANY}`);
  store.setVaultState(V, { yieldUsd: opts.yieldUsd ?? 100, frozen: opts.frozen ?? false });
  store.addKey({ id: "k1", vault: V, name: "dev-1", weight: 1, secretSha256: sha256(SECRET) });
  const calls: { url: string; init: RequestInit }[] = [];
  const logs: string[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return upstream(url, init);
  }) as unknown as typeof fetch;
  const decrypt = (e: string) => e.replace(/^enc:/, "");
  const proxy = createProxy({
    store, params: HACKATHON_PARAMS, decrypt, fetchFn, upstream: "https://up.test/api/v1/", dashboardUrl: "https://dash.test", log: (m) => logs.push(m),
  });
  const d: AppDeps = {
    store,
    or: {
      createKey: async () => ({ key: "k", hash: "h" }), getKey: async (h) => ({ hash: h, usage: 0, limit: 0, disabled: false }),
      setLimit: async () => {}, deleteKey: async () => {}, getGeneration: async () => undefined,
    },
    chain: {
      yieldOf: async () => 0n, lossPending: async () => false, report: async () => "0x", settle: async () => "0x",
      totalAssets: async () => 0n, prepareSettle: async () => ({ hash: "0x", send: async () => {} }), sendSettle: async () => "0x",
      settleStatus: async () => "success" as const, transactionKnown: async () => true, customerOf: async () => "0x",
    },
    gateway: {} as unknown as ToolGateway,
    params: HACKATHON_PARAMS, adminToken: "admin", publicConfig: {},
    secrets: { encrypt: (p) => `enc:${p}`, decrypt },
    proxy,
    keeper: undefined as unknown as AppDeps["keeper"],
  };
  d.keeper = { chain: d.chain, store, or: d.or, params: HACKATHON_PARAMS, log: () => {}, decrypt, drain: proxy.drain };
  const server = createApp(d);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, server, store, calls, logs, proxy };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-openrouter-trace": "leak", ...headers } });

const completion = (id: string, cost: number) =>
  json({ id, model: "openai/gpt-4o-mini", choices: [{ message: { role: "assistant", content: "hi" } }], usage: { prompt_tokens: 5, completion_tokens: 2, cost } });

const chat = (base: string, body: unknown, key = SECRET) =>
  fetch(base + "/v1/chat/completions", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const MSG = { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }] };

test("a request on a fresh key is answered through the proxy and metered in the same request", async () => {
  const { base, server, store, calls } = await start(() => completion("gen-1", 0.0123));
  const r = await chat(base, MSG);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/json");
  assert.equal(r.headers.get("x-openrouter-trace"), null); // provider headers are dropped
  const body: any = await r.json();
  assert.equal(body.choices[0].message.content, "hi");
  assert.equal(body.usage.cost, 0.0123);
  const call = store.modelCall("gen-1")!;
  assert.deepEqual([call.keyId, call.model, call.costUsd, call.status], ["k1", "openai/gpt-4o-mini", 0.0123, "recorded"]);
  assert.equal(store.keyById("k1")!.modelSpent, 0.0123);
  assert.equal(calls[0].url, "https://up.test/api/v1/chat/completions");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${COMPANY}`);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { ...MSG, usage: { include: true } });
  server.close();
});

test("usage.include is forced on even when the client sets it false", async () => {
  const { base, server, calls } = await start(() => completion("gen-2", 0));
  await chat(base, { ...MSG, usage: { include: false, other: 1 } });
  assert.deepEqual(JSON.parse(String(calls[0].init.body)).usage, { other: 1, include: true });
  server.close();
});

test("missing, unknown and revoked keys get 401 in the OpenAI error shape", async () => {
  const { base, server, store, calls } = await start(() => completion("g", 0));
  for (const key of ["", "nope"]) {
    const r = await chat(base, MSG, key);
    assert.equal(r.status, 401);
    const e: any = await r.json();
    assert.deepEqual([e.error.type, e.error.code, typeof e.error.message], ["authentication_error", 401, "string"]);
  }
  store.revokeKey("k1");
  assert.equal((await chat(base, MSG)).status, 401);
  assert.equal((await fetch(base + "/v1/models")).status, 401);
  assert.equal(calls.length, 0);
  server.close();
});

test("a key with no budget left gets 402 with the remaining amount and the dashboard URL, before forwarding", async () => {
  const { base, server, store, calls } = await start(() => completion("g", 0), { yieldUsd: 1 });
  store.recordModelCall({ keyId: "k1", model: "m", costUsd: 1, generationId: "earlier" });
  const r = await chat(base, MSG);
  assert.equal(r.status, 402);
  const e: any = await r.json();
  assert.equal(e.error.type, "insufficient_quota");
  assert.equal(e.error.code, 402);
  assert.match(e.error.message, /\$0\.00/);
  assert.match(e.error.message, /https:\/\/dash\.test/);
  assert.equal(calls.length, 0);
  server.close();
});

test("a frozen vault refuses every key with 402", async () => {
  const { base, server, calls } = await start(() => completion("g", 0), { frozen: true });
  const r = await chat(base, MSG);
  assert.equal(r.status, 402);
  const e: any = await r.json();
  assert.equal(e.error.type, "insufficient_quota");
  assert.match(e.error.message, /frozen/);
  assert.equal(calls.length, 0);
  server.close();
});

test("a settling vault answers 503 with Retry-After", async () => {
  const { base, server, store, calls } = await start(() => completion("g", 0));
  store.setSettling(V, true);
  const r = await chat(base, MSG);
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("retry-after"), "15");
  assert.equal(((await r.json()) as any).error.type, "server_error");
  assert.equal(calls.length, 0);
  server.close();
});

test("two requests that both pass the check both meter, and the third is refused", async () => {
  // $1 of yield, $0.60 per call: both concurrent calls pass the check (it happens before the call), the third finds nothing left
  let n = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { base, server, store } = await start(async () => {
    const id = `gen-${++n}`;
    if (n === 2) release();
    await gate; // neither answers until both are in flight
    return completion(id, 0.6);
  }, { yieldUsd: 1 });
  const [a, b] = await Promise.all([chat(base, MSG), chat(base, MSG)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal(store.keyById("k1")!.modelSpent, 1.2);
  assert.equal((await chat(base, MSG)).status, 402);
  server.close();
});

test("an upstream error is relayed with its status and body", async () => {
  const { base, server, store } = await start(() => json({ error: { message: "bad model", code: 400 } }, 400));
  const r = await chat(base, MSG);
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: { message: "bad model", code: 400 } });
  assert.equal(store.listPendingModelCalls().length, 0);
  server.close();
});

test("the provider's key limit becomes our 402", async () => {
  const { base, server } = await start(() => json({ error: { message: "Key limit exceeded", code: 403 } }, 403));
  const r = await chat(base, MSG);
  assert.equal(r.status, 402);
  const e: any = await r.json();
  assert.equal(e.error.type, "insufficient_quota");
  assert.match(e.error.message, /https:\/\/dash\.test/);
  server.close();
});

test("a network failure to the provider is a 502 that names no host", async () => {
  const { base, server } = await start(() => { throw new TypeError("fetch failed: up.test refused"); });
  const r = await chat(base, MSG);
  assert.equal(r.status, 502);
  const e: any = await r.json();
  assert.equal(e.error.type, "upstream_error");
  assert.ok(!e.error.message.includes("up.test"));
  server.close();
});

test("a non-JSON body is refused with 400 before forwarding", async () => {
  const { base, server, calls } = await start(() => completion("g", 0));
  for (const body of ["{not json", "[1,2]", "\"str\""]) {
    const r = await chat(base, body);
    assert.equal(r.status, 400, body);
    assert.equal(((await r.json()) as any).error.type, "invalid_request_error");
  }
  assert.equal(calls.length, 0);
  server.close();
});

test("a body over 4 MB is refused with 413 before forwarding", async () => {
  const { base, server, calls } = await start(() => completion("g", 0));
  const big = JSON.stringify({ ...MSG, messages: [{ role: "user", content: "x".repeat(MAX_BODY_BYTES) }] });
  const r = await chat(base, big);
  assert.equal(r.status, 413);
  assert.equal(((await r.json()) as any).error.type, "invalid_request_error");
  // the same without a content-length header (a chunked upload)
  const r2 = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } }),
    duplex: "half",
  } as RequestInit);
  assert.equal(r2.status, 413);
  assert.equal(calls.length, 0);
  server.close();
});

test("a response without a cost leaves a pending row", async () => {
  const { base, server, store } = await start(() => json({ id: "gen-nc", model: "m", choices: [], usage: { prompt_tokens: 1 } }));
  assert.equal((await chat(base, MSG)).status, 200);
  assert.equal(store.modelCall("gen-nc")!.status, "pending");
  assert.equal(store.keyById("k1")!.modelSpent, 0);
  assert.equal(store.listPendingModelCalls().length, 1);
  server.close();
});

test("GET /v1/models is relayed and provider headers are dropped", async () => {
  const { base, server, calls } = await start(() => json({ data: [{ id: "openai/gpt-4o-mini" }] }, 200, { "cache-control": "max-age=60" }));
  const r = await fetch(base + "/v1/models", { headers: { Authorization: `Bearer ${SECRET}` } });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as any).data[0].id, "openai/gpt-4o-mini");
  assert.equal(r.headers.get("x-openrouter-trace"), null);
  assert.equal(r.headers.get("cache-control"), "max-age=60");
  assert.equal(calls[0].url, "https://up.test/api/v1/models");
  server.close();
});

test("other /v1 paths are 404 in the error shape", async () => {
  const { base, server, calls } = await start(() => completion("g", 0));
  const r = await fetch(base + "/v1/embeddings", { method: "POST", headers: { Authorization: `Bearer ${SECRET}` }, body: "{}" });
  assert.equal(r.status, 404);
  assert.equal(((await r.json()) as any).error.type, "invalid_request_error");
  assert.equal(calls.length, 0);
  server.close();
});

test("streaming is refused until the stream relay lands", async () => {
  const { base, server, calls } = await start(() => completion("g", 0));
  const r = await chat(base, { ...MSG, stream: true });
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0);
  server.close();
});

test("drain waits for in-flight metering and returns at once when nothing is in flight", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { base, server, store, proxy } = await start(async () => { await gate; return completion("gen-d", 0.01); });
  const pending = chat(base, MSG);
  for (let i = 0; i < 100 && proxy.inFlight(V) === 0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(proxy.inFlight(V), 1);
  const t0 = Date.now();
  const drained = proxy.drain(V, 5_000);
  release();
  await drained;
  assert.ok(Date.now() - t0 < 4_000);
  assert.equal(proxy.inFlight(V), 0);
  assert.equal(store.modelCall("gen-d")!.costUsd, 0.01);
  assert.equal((await pending).status, 200);
  const t1 = Date.now();
  await proxy.drain(V, 5_000);
  assert.ok(Date.now() - t1 < 100);
  server.close();
});

test("drain gives up after its timeout", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { base, server, proxy } = await start(async () => { await gate; return completion("gen-t", 0.01); });
  const pending = chat(base, MSG);
  for (let i = 0; i < 100 && proxy.inFlight(V) === 0; i++) await new Promise((r) => setTimeout(r, 5));
  const t0 = Date.now();
  await proxy.drain(V, 50);
  const took = Date.now() - t0;
  assert.ok(took >= 45 && took < 1_000, String(took));
  assert.equal(proxy.inFlight(V), 1);
  release();
  await pending;
  server.close();
});

test("the log line names key, model, cost and status, never the prompt or a secret", async () => {
  const { base, server, logs } = await start(() => completion("gen-l", 0.02));
  await chat(base, { ...MSG, messages: [{ role: "user", content: "TOP SECRET PROMPT" }] });
  const line = logs.find((m) => m.includes("gen-l"))!;
  assert.match(line, /^proxy key k1 model openai\/gpt-4o-mini gen gen-l cost \$0\.02 \d+ms 200$/);
  const all = logs.join("\n");
  assert.ok(!all.includes("TOP SECRET"));
  assert.ok(!all.includes(COMPANY));
  assert.ok(!all.includes(SECRET));
  server.close();
});
```

- [ ] **Step 2: Run the proxy tests to verify they fail**

Run: `node --test app/test/proxy.test.ts`
Expected: `Cannot find module '../proxy.ts'`.

- [ ] **Step 3: Write `app/proxy.ts`**

```ts
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
  if (vault.settling) {
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

  /** Forwards a checked request with the company key and relays the answer. Runs tracked, so drain() can wait on it. */
  async function forward(res: ServerResponse, body: any, key: KeyRow, apiKey: string): Promise<void> {
    const model = String(body.model ?? "");
    const started = Date.now();
    let up: Response;
    try {
      up = await d.fetchFn(`${upstream}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      d.log(`proxy key ${key.id} model ${model} upstream unreachable: ${(e as Error).message}`);
      return fail(res, 502, "upstream_error", "could not reach the model provider");
    }
    if (!up.ok) return relayError(res, up, key, model, started);
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
    if (body.stream === true) return fail(res, 400, "invalid_request_error", "streaming is not served yet; send stream: false");
    body.usage = { ...(body.usage && typeof body.usage === "object" ? body.usage : {}), include: true };
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
      if (url.pathname === "/v1/models" && req.method === "GET") await relayModels(res);
      else if (url.pathname === "/v1/chat/completions" && req.method === "POST") await completions(req, res, key);
      else fail(res, 404, "invalid_request_error", "only POST /v1/chat/completions and GET /v1/models are served");
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
```

- [ ] **Step 4: Mount the proxy in `app/server.ts`**

Add the import `import type { Proxy } from "./proxy.ts";` after the `ToolGateway` import. Add `proxy: Proxy;` to `AppDeps` (after `secrets: SecretBox;`). At the top of `route`, right after `const url = ...;`, add:

```ts
  if (await d.proxy.handle(req, res)) return;
```

- [ ] **Step 5: Give the server fixture a proxy in `app/test/server.test.ts`**

Add `import { createProxy } from "../proxy.ts";` and, in `start()`, after the `secrets` line:

```ts
    proxy: createProxy({
      store, params: HACKATHON_PARAMS, decrypt: (e) => e.replace(/^enc:/, ""), dashboardUrl: "http://localhost", log: () => {},
      fetchFn: (async () => { throw new Error("no upstream in this test"); }) as unknown as typeof fetch,
    }),
```

- [ ] **Step 6: Wire the proxy in `app/cli.ts`**

Add `import { createProxy } from "./proxy.ts";`. After the `gateway` block add:

```ts
const proxy = createProxy({
  store, params: cfg.params, decrypt: box.decrypt, fetchFn: fetch, dashboardUrl: cfg.publicUrl, log: keeper.log,
});
keeper.drain = proxy.drain; // settlement waits for in-flight metering
```

Pass `proxy` in the `createApp` call (add `proxy,` after `secrets: box,`) and change the listen banner to:

```ts
    app.listen(cfg.port, () => console.log(`Inferest on http://localhost:${cfg.port} (chat at /v1/chat/completions, MCP at /mcp)`));
```

- [ ] **Step 7: Run the whole suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass; tsc prints nothing. If the 413 chunked test hangs, the client is waiting on a response the server never sent: confirm `readBody` rejects on the first chunk past the cap and that `completions` answers before the body finishes.

- [ ] **Step 8: Commit**

```bash
git add app/proxy.ts app/test/proxy.test.ts app/server.ts app/test/server.test.ts app/cli.ts
git commit -m "Inference proxy: Inferest keys on /v1/chat/completions with budget check, metering and error rewrites"
```

---

### Task 7: Proxy streaming: SSE relay, cost from the final event, client disconnect, pending rows

**Branch:** `proxy-streaming`

**Files:**
- Modify: `app/proxy.ts` (`forward` and `completions`; new `relayStream`)
- Modify: `app/test/proxy.test.ts` (replace the `streaming is refused` test with the streaming tests below)

**Interfaces:**
- Consumes: `createProxy` internals from Task 6; `resolvePendingModelCalls` from Task 4.
- Produces: no new exports. Behavior: `stream: true` requests are forwarded with `Accept: text/event-stream`; every SSE event is relayed byte for byte; the generation id is taken from the first event that carries one and the cost from the last event that carries `usage.cost`; the upstream stream is read to the end even after the client disconnects; a stream that breaks before a cost arrives leaves a pending row when a generation id was seen. Relayed stream headers: `content-type`, `cache-control: no-cache`, `x-accel-buffering: no`.

- [ ] **Step 1: Write the failing streaming tests**

In `app/test/proxy.test.ts`, delete the test `streaming is refused until the stream relay lands`. Change the `import` of the keeper and the fixture's return so the tests can reach the keeper deps: add `import { resolvePendingModelCalls } from "../keeper.ts";` and make `start()` return `{ base, server, store, calls, logs, proxy, d }`. Then append:

```ts
/** An SSE body that emits the given events, waiting for `gate` (if given) before the last one, or erroring at `breakAt`. */
function sse(events: unknown[], opts: { gate?: Promise<void>; breakAt?: number } = {}) {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      c.enqueue(enc.encode(": OPENROUTER PROCESSING\n\n"));
      for (const [i, e] of events.entries()) {
        if (opts.breakAt === i) { c.error(new Error("upstream reset")); return; }
        if (i === events.length - 1 && opts.gate) await opts.gate;
        c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      }
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "x-openrouter-trace": "leak" } });
}
const chunk = (id: string, content: string) => ({ id, model: "openai/gpt-4o-mini", choices: [{ delta: { content } }] });
const usageEvent = (id: string, cost: number) => ({ id, model: "openai/gpt-4o-mini", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, cost } });
const STREAM = { ...MSG, stream: true };

test("a streamed answer is relayed event by event and metered from the final usage event", async () => {
  const { base, server, store, calls } = await start(() => sse([chunk("gen-s", "Hel"), chunk("gen-s", "lo"), usageEvent("gen-s", 0.005)]));
  const r = await chat(base, STREAM);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "text/event-stream");
  assert.equal(r.headers.get("x-openrouter-trace"), null);
  const text = await r.text();
  assert.ok(text.startsWith(": OPENROUTER PROCESSING\n\n")); // byte for byte, comments included
  const datas = text.split("\n\n").filter((e) => e.startsWith("data:")).map((e) => e.slice(5).trim());
  assert.equal(datas.length, 4);
  assert.equal(JSON.parse(datas[0]).choices[0].delta.content, "Hel");
  assert.equal(JSON.parse(datas[1]).choices[0].delta.content, "lo");
  assert.equal(JSON.parse(datas[2]).usage.cost, 0.005);
  assert.equal(datas[3], "[DONE]");
  assert.deepEqual([store.modelCall("gen-s")!.costUsd, store.modelCall("gen-s")!.status], [0.005, "recorded"]);
  const sent = JSON.parse(String(calls[0].init.body));
  assert.equal(sent.stream, true);
  assert.deepEqual(sent.usage, { include: true });
  assert.equal((calls[0].init.headers as Record<string, string>).Accept, "text/event-stream");
  server.close();
});

test("a client that disconnects mid-stream is still metered once the upstream finishes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { base, server, store, proxy } = await start(() => sse([chunk("gen-c", "a"), chunk("gen-c", "b"), usageEvent("gen-c", 0.007)], { gate }));
  const ac = new AbortController();
  const r = await fetch(base + "/v1/chat/completions", {
    method: "POST", headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify(STREAM), signal: ac.signal,
  });
  assert.equal(r.status, 200);
  await r.body!.getReader().read(); // the first bytes arrived
  ac.abort(); // the developer's client goes away
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(proxy.inFlight(V), 1); // the proxy is still reading the upstream
  assert.equal(store.modelCall("gen-c"), undefined);
  release();
  await proxy.drain(V, 5_000);
  assert.equal(proxy.inFlight(V), 0);
  assert.deepEqual([store.modelCall("gen-c")!.costUsd, store.modelCall("gen-c")!.status], [0.007, "recorded"]);
  server.close();
});

test("an upstream stream that breaks before usage leaves a pending row that the keeper resolves", async () => {
  const { base, server, store, logs, d } = await start(() => sse([chunk("gen-b", "a"), chunk("gen-b", "b")], { breakAt: 1 }));
  const r = await chat(base, STREAM);
  assert.equal(r.status, 200);
  await r.text().catch(() => {});
  assert.equal(store.modelCall("gen-b")!.status, "pending");
  assert.ok(logs.some((m) => m.includes("gen-b") && m.includes("cost pending")));
  d.or.getGeneration = async (id, apiKey) => (apiKey === COMPANY ? { id, model: "openai/gpt-4o-mini", totalCost: 0.009 } : undefined);
  await resolvePendingModelCalls(d.keeper);
  assert.deepEqual([store.modelCall("gen-b")!.costUsd, store.modelCall("gen-b")!.status], [0.009, "recorded"]);
  assert.equal(store.keyById("k1")!.modelSpent, 0.009);
  server.close();
});

test("a stream without a generation id meters nothing and says so", async () => {
  const { base, server, store, logs } = await start(() => sse([{ choices: [{ delta: { content: "?" } }] }]));
  await (await chat(base, STREAM)).text();
  assert.equal(store.listPendingModelCalls().length, 0);
  assert.ok(logs.some((m) => m.includes("without a generation id")));
  server.close();
});

test("a streaming request whose upstream answers with a JSON error relays the error", async () => {
  const { base, server } = await start(() => json({ error: { message: "no such model", code: 404 } }, 404));
  const r = await chat(base, STREAM);
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: { message: "no such model", code: 404 } });
  server.close();
});

test("a streaming request answered with plain JSON is metered like a non-streaming one", async () => {
  const { base, server, store } = await start(() => completion("gen-j", 0.01));
  const r = await chat(base, STREAM);
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as any).usage.cost, 0.01);
  assert.equal(store.modelCall("gen-j")!.costUsd, 0.01);
  server.close();
});
```

- [ ] **Step 2: Run the proxy tests to verify the new ones fail**

Run: `node --test app/test/proxy.test.ts`
Expected: the six streaming tests fail with status 400 from the `stream: true` refusal.

- [ ] **Step 3: Add the stream relay to `app/proxy.ts`**

Delete this line from `completions`:

```ts
    if (body.stream === true) return fail(res, 400, "invalid_request_error", "streaming is not served yet; send stream: false");
```

Replace the whole `forward` function with:

```ts
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
```

Add this function right after `relayJson`:

```ts
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
```

- [ ] **Step 4: Run the whole suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass; tsc prints nothing. If the disconnect test reports `inFlight` 0 after the abort, the handler stopped reading when the client left: check that nothing in `relayStream` awaits the response (`res`) and that the read loop has no `clientGone` early return.

- [ ] **Step 5: Try it against OpenRouter for real (manual, not committed)**

With the anvil stack running (`.env.anvil`, `node --env-file=.env.anvil app/cli.ts serve`), register a vault and create a key through the dashboard or `demo/lib.ts`'s `api()`, then:

```bash
curl -N http://localhost:8787/v1/chat/completions -H "Authorization: Bearer sk-inf-..." -H "Content-Type: application/json" \
  -d '{"model":"moonshotai/kimi-k2.6","messages":[{"role":"user","content":"Say hi"}],"stream":true}'
```

Expected: SSE events end with a usage event and `[DONE]`; the server log shows `proxy key ... cost $...`; `GET /api/state` shows the key's `modelSpent` moved. Delete the probe key afterwards. Record what you saw in the report; nothing from this step is committed.

- [ ] **Step 6: Commit**

```bash
git add app/proxy.ts app/test/proxy.test.ts
git commit -m "Proxy streaming: relay SSE byte for byte, meter from the usage event, keep reading after a client disconnect"
```

---

### Task 8: Dashboard: setup panel, revoke and rotate, backstop figure, GET /setup

**Branch:** `proxy-dashboard`

**Files:**
- Create: `app/dashboard/snippets.js`
- Create: `app/dashboard/setup.html`
- Modify: `app/dashboard/index.html`
- Modify: `app/dashboard/app.js`
- Modify: `app/server.ts` (`serveStatic`: `/setup` maps to `setup.html`; `/api/state` carries `publicUrl`)
- Modify: `app/cli.ts` (`publicConfig.publicUrl`)
- Modify: `app/test/server.test.ts` (two tests)

**Interfaces:**
- Consumes: state fields from Task 5 (`keys[].id`, `revoked`, `orLimit`, `orUsage`, `settling`); routes `POST /api/keys/:id/revoke` and `/rotate` from Task 5.
- Produces: `GET /setup` (HTML, 200); `publicConfig.publicUrl` in `GET /api/state` `config`; `snippets.js` exports `snippets(baseUrl, key): { name: string; text: string }[]` used by both pages.

- [ ] **Step 1: Write the failing server tests**

Append to `app/test/server.test.ts`:

```ts
test("serves the setup page with the base URL filled in", async () => {
  const { base, server, d } = await start();
  d.publicConfig.publicUrl = "https://inferest.example";
  const r = await fetch(base + "/setup");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/html/);
  const html = await r.text();
  assert.match(html, /snippets\.js/);
  assert.match(html, /sk-inf-/);
  const state: any = await (await fetch(base + "/api/state")).json();
  assert.equal(state.config.publicUrl, "https://inferest.example");
  server.close();
});

test("the dashboard scripts are served as JavaScript", async () => {
  const { base, server } = await start();
  const r = await fetch(base + "/snippets.js");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /javascript/);
  assert.match(await r.text(), /export function snippets/);
  server.close();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test app/test/server.test.ts`
Expected: `/setup` returns 404 (no such file), `/snippets.js` 404.

- [ ] **Step 3: Write `app/dashboard/snippets.js`**

```js
/** Ready-to-paste client setups for an Inferest key. `key` may be a placeholder. */
export function snippets(baseUrl, key) {
  const base = baseUrl.replace(/\/+$/, "");
  return [
    { name: "curl", text: `curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"moonshotai/kimi-k2.6","messages":[{"role":"user","content":"Say hi"}]}'` },
    { name: "OpenAI SDK (Python)", text: `from openai import OpenAI

client = OpenAI(base_url="${base}/v1", api_key="${key}")
r = client.chat.completions.create(model="moonshotai/kimi-k2.6", messages=[{"role": "user", "content": "Say hi"}])
print(r.choices[0].message.content)` },
    { name: "OpenAI SDK (Node)", text: `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${base}/v1", apiKey: "${key}" });
const r = await client.chat.completions.create({ model: "moonshotai/kimi-k2.6", messages: [{ role: "user", content: "Say hi" }] });
console.log(r.choices[0].message.content);` },
    { name: "Vercel AI SDK", text: `import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

const inferest = createOpenAI({ baseURL: "${base}/v1", apiKey: "${key}" });
const { text } = await generateText({ model: inferest.chat("moonshotai/kimi-k2.6"), prompt: "Say hi" });
console.log(text);` },
    { name: "Agent config (OpenClaw, Hermes, any OpenRouter-compatible agent)", text: `# The proxy speaks OpenRouter's chat completions API, so point the agent's OpenRouter settings at Inferest:
OPENROUTER_API_KEY=${key}
OPENROUTER_BASE_URL=${base}/v1` },
    { name: "MCP tools (same key)", text: `# Streamable HTTP MCP server with paid web tools, billed from the same yield budget
URL:    ${base}/mcp
Header: Authorization: Bearer ${key}` },
  ];
}

export const NOTES = [
  "Base URL: the Inferest server above, path /v1. Only POST /v1/chat/completions and GET /v1/models are served.",
  "Model ids are OpenRouter's (for example moonshotai/kimi-k2.6, openai/gpt-4o-mini). Streaming works.",
  "A 402 insufficient_quota means this key's yield budget for the period is used up or its vault is frozen; it is not retryable.",
  "A 401 means the key is unknown or revoked. Keys are shown once; rotate to get a new secret on the same budget.",
];
```

- [ ] **Step 4: Write `app/dashboard/setup.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Inferest setup</title>
  <style>
    body { font: 15px/1.5 system-ui, sans-serif; max-width: 880px; margin: 0 auto; padding: 16px; color: #111; background: #fff; }
    h1 { margin: 0 0 4px; } .muted { color: #666; } .card { border: 1px solid #ddd; border-radius: 8px; padding: 12px 16px; margin: 12px 0; }
    pre { background: #f6f6f6; padding: 8px; overflow-x: auto; white-space: pre-wrap; } button { padding: 4px 10px; cursor: pointer; }
    .tabs button.on { font-weight: bold; }
  </style>
</head>
<body>
  <h1>Inferest setup</h1>
  <p class="muted">Use your Inferest key (<code>sk-inf-...</code>) in place of an OpenRouter key. Replace the placeholder below with the key your admin gave you.</p>
  <div class="card">
    <div class="tabs" id="tabs"></div>
    <pre id="snippet"></pre>
    <button id="copy">Copy</button>
  </div>
  <div class="card"><ul id="notes"></ul></div>
  <script type="module">
    import { snippets, NOTES } from "/snippets.js";
    const PLACEHOLDER = "sk-inf-YOUR-KEY";
    const state = await (await fetch("/api/state")).json();
    const list = snippets(state.config.publicUrl ?? location.origin, PLACEHOLDER);
    const tabs = document.getElementById("tabs");
    const pre = document.getElementById("snippet");
    let current = 0;
    const show = (i) => {
      current = i;
      pre.textContent = list[i].text;
      for (const [j, b] of [...tabs.children].entries()) b.classList.toggle("on", j === i);
    };
    for (const [i, s] of list.entries()) {
      const b = document.createElement("button");
      b.textContent = s.name;
      b.onclick = () => show(i);
      tabs.appendChild(b);
    }
    show(0);
    document.getElementById("copy").onclick = () => navigator.clipboard.writeText(list[current].text);
    for (const n of NOTES) {
      const li = document.createElement("li");
      li.textContent = n;
      document.getElementById("notes").appendChild(li);
    }
  </script>
</body>
</html>
```

- [ ] **Step 5: Serve `/setup` and expose the public URL**

In `app/server.ts`, `serveStatic`, change the first line to:

```ts
  const file = pathname === "/" ? "index.html" : pathname === "/setup" ? "setup.html" : pathname.slice(1);
```

In `app/cli.ts`, add `publicUrl: cfg.publicUrl` to the `publicConfig` object passed to `createApp`.

- [ ] **Step 6: Update `app/dashboard/index.html`**

Add these style rules inside `<style>`:

```css
    tr.revoked td { color: #999; text-decoration: line-through; }
    #panel { display: none; border: 2px solid #111; }
    #panel.open { display: block; }
    .tabs button.on { font-weight: bold; }
    #secret { font-family: ui-monospace, monospace; word-break: break-all; background: #fff7d6; padding: 8px; }
```

Replace the Admin card's key line so the card reads:

```html
  <div class="card">
    <h3>Admin</h3>
    <input id="token" type="password" placeholder="admin token" />
    <button id="sync">Sync limits</button><button id="report">Report yield</button>
    <div><input id="keyname" placeholder="key name" value="dev-1" /> weight <input id="weight" type="number" value="1" style="width:60px" />
      <button id="addkey">Create key</button> <a href="/setup" class="muted">setup page for developers</a></div>
  </div>

  <div id="panel" class="card">
    <h3 id="paneltitle">Your new key</h3>
    <p>Copy it now. It is shown once and stored only as a hash.</p>
    <div id="secret"></div>
    <button id="copysecret">Copy key</button>
    <p class="muted">Base URL <code id="baseurl"></code>, path <code>/v1</code>. Model ids are OpenRouter's. A 402 means the key's yield budget is used up.</p>
    <div class="tabs" id="tabs"></div>
    <pre id="snippet"></pre>
    <button id="copysnippet">Copy snippet</button> <button id="closepanel">Close</button>
  </div>
```

- [ ] **Step 7: Update `app/dashboard/app.js`**

Add after the viem import: `import { snippets } from "/snippets.js";`

Replace the `$("addkey").onclick` handler with:

```js
$("addkey").onclick = async () => {
  const vault = myVault ?? (await api("/api/state")).vaults[0]?.vault;
  const r = await api("/api/keys", { vault, name: $("keyname").value, weight: Number($("weight").value) });
  showKey(`New key: ${$("keyname").value}`, r.key);
  await render();
};

let panelList = [];
let panelIndex = 0;
/** Opens the setup panel with a secret that is shown once. */
function showKey(title, secret) {
  const base = cfg.publicUrl ?? location.origin;
  panelList = snippets(base, secret);
  $("paneltitle").textContent = title;
  $("secret").textContent = secret;
  $("baseurl").textContent = base;
  $("tabs").innerHTML = "";
  for (const [i, s] of panelList.entries()) {
    const b = document.createElement("button");
    b.textContent = s.name;
    b.onclick = () => showTab(i);
    $("tabs").appendChild(b);
  }
  showTab(0);
  $("panel").classList.add("open");
  $("panel").scrollIntoView({ behavior: "smooth" });
}
function showTab(i) {
  panelIndex = i;
  $("snippet").textContent = panelList[i].text;
  for (const [j, b] of [...$("tabs").children].entries()) b.classList.toggle("on", j === i);
}
$("copysecret").onclick = () => navigator.clipboard.writeText($("secret").textContent);
$("copysnippet").onclick = () => navigator.clipboard.writeText(panelList[panelIndex].text);
$("closepanel").onclick = () => { $("panel").classList.remove("open"); $("secret").textContent = ""; };
```

Replace the `render` function and the delegated click listener with:

```js
async function render() {
  const s = await api("/api/state");
  cfg = s.config;
  $("vaults").innerHTML = s.vaults.map((v) => `
    <div class="card">
      <h3>${esc(v.label)} <span class="muted">${esc(v.vault)}</span></h3>
      <p>Yield in Splitter: <b>$${v.yieldUsd.toFixed(2)}</b>
        ${v.frozen ? "<b>(frozen: loss pending)</b>" : ""} ${v.settling ? "<b>(settling)</b>" : ""}
        &middot; period ${v.period}
        &middot; provider backstop: limit $${v.orLimit.toFixed(2)}, used $${v.orUsage.toFixed(2)}${v.hasOpenRouterKey ? "" : " (no provider key yet)"}</p>
      <table><tr><th>Key</th><th>Weight</th><th>Budget</th><th>Models</th><th>Tools</th><th>Left</th><th></th></tr>
      ${v.keys.map((k) => `<tr class="${k.revoked ? "revoked" : ""}"><td>${esc(k.name)}${k.revoked ? " (revoked)" : ""}</td><td>${k.weight}</td>
        <td>$${k.budget.toFixed(2)}</td><td>$${k.modelSpent.toFixed(4)}</td><td>$${k.toolSpent.toFixed(4)}</td><td>$${k.remaining.toFixed(2)}</td>
        <td>${k.revoked ? "" : `<button class="rotate" data-id="${esc(k.id)}" data-name="${esc(k.name)}">Rotate</button>
          <button class="revoke" data-id="${esc(k.id)}" data-name="${esc(k.name)}">Revoke</button>`}</td></tr>`).join("")}
      </table>
      <button class="settle" data-vault="${esc(v.vault)}">Settle now</button>
    </div>`).join("");
}
$("vaults").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  try {
    if (b.classList.contains("settle")) {
      const r = await api("/api/admin/settle", { vault: b.dataset.vault });
      log(`settle: ${JSON.stringify(r)}`);
    } else if (b.classList.contains("revoke")) {
      if (!confirm(`Revoke key ${b.dataset.name}? Its next request gets 401.`)) return;
      await api(`/api/keys/${b.dataset.id}/revoke`, {});
      log(`revoked ${b.dataset.name}`);
    } else if (b.classList.contains("rotate")) {
      const r = await api(`/api/keys/${b.dataset.id}/rotate`, {});
      showKey(`Rotated key: ${b.dataset.name}`, r.key);
    } else {
      return;
    }
    await render();
  } catch (err) {
    log(String(err));
  }
});
```

- [ ] **Step 8: Run the suite, the typecheck, and look at the page**

Run: `npm test && npm run typecheck`
Expected: all pass. Then start the server on the anvil overlay (`node --env-file=.env.anvil app/cli.ts serve`), open `http://localhost:8787/`, create a key, and check: the panel opens with the secret, the copy buttons work, each tab shows a snippet with the secret filled in, Rotate opens the panel again, Revoke greys the row, and `http://localhost:8787/setup` shows the same tabs with the placeholder. Note anything off in the report.

- [ ] **Step 9: Commit**

```bash
git add app/dashboard/snippets.js app/dashboard/setup.html app/dashboard/index.html app/dashboard/app.js app/server.ts app/cli.ts app/test/server.test.ts
git commit -m "Dashboard: key setup panel with snippets, revoke and rotate, provider backstop figure, /setup page"
```

---

### Task 9: Demos and docs on Inferest keys

**Branch:** `proxy-demos-docs`

**Files:**
- Modify: `demo/lib.ts:98-107` (`chat()` targets the Inferest server)
- Modify: `demo/treasury.ts:9-27`
- Modify: `README.md` (diagram line, scope, decision 5, run section)
- Modify: `docs/06-workflow.md` (sections 2 and 3, plus every sentence that still says a developer key is an OpenRouter key)
- Modify: `deck/outline.md` (speaker note)

**Interfaces:**
- Consumes: `POST /api/keys` returning `{ key, id }` (Task 5); `/v1/chat/completions` (Task 6).
- Produces: nothing new in code. Both demo scripts run against the proxy.

- [ ] **Step 1: Point the demo chat helper at the proxy**

In `demo/lib.ts`, replace the `chat` function with:

```ts
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
```

In `demo/treasury.ts`, change step 2's line to carry the id and step 4's wording, and drop the wait for OpenRouter (metering is immediate now):

```ts
step(2, "Admin creates three developer keys at equal weight. They are Inferest keys, not provider keys.");
const keys: { name: string; key: string; id: string }[] = [];
for (const name of ["dev-1", "dev-2", "dev-3"]) keys.push({ name, ...(await api("/api/keys", { vault: c.vault, name, weight: 1 })) });
```

```ts
step(4, "Developers call real models on their own keys, through the Inferest proxy. Each call is metered as it returns.");
for (const k of keys) {
  const r = await chat(k.key, [{ role: "user", content: "In one sentence, why do treasuries hold stablecoins?" }]);
  console.log(`   ${k.name}: ${r.choices[0].message.content.trim().slice(0, 90)}  (cost $${r.usage?.cost ?? "?"})`);
}
await api("/api/admin/sync", {}); // refreshes the provider backstop; spend is already on the keys
await printState(c.vault);
```

Remove the `sleep` import from `demo/treasury.ts` if it is now unused (`demo/agent.ts` still uses it). Then run `npm run typecheck`.

- [ ] **Step 2: Update the README**

Replace the diagram line

```
          OpenRouter keys under our account, limits synced per key ──▶ IDE, agent, OpenClaw
```

with

```
          Inferest keys (sk-inf-…) on our proxy, metered per call ──▶ IDE, agent, OpenClaw
          one OpenRouter key per vault behind it, its limit synced as the backstop
```

In **Scope**, change the build bullet `Ledger plus a worker that syncs OpenRouter key limits to accrued yield and settles each period` to `Ledger, a proxy that meters every model call against the key's yield budget, and a worker that keeps the provider backstop in step and settles each period`, and delete the bullet `Our own inference proxy. OpenRouter keys do the metering until supply moves off OpenRouter` from **Do not build (yet)**.

In the **Decisions** table, replace row 5 with:

```
| 5 | Keys | **Inferest keys in front of one OpenRouter key per vault.** A small proxy checks the key's budget before the call and meters the cost after; the provider key's limit is a backstop | Decided 2026-09-25. Per-developer budgets, instant revoke and rotate, and the same key for models and MCP tools; the base URL is the only thing a client changes. See [`docs/superpowers/specs/2026-09-25-inference-proxy-design.md`](docs/superpowers/specs/2026-09-25-inference-proxy-design.md) |
```

In the run block, change the comment on the serve line to `# dashboard, API, chat at /v1, MCP at /mcp`. In the repository layout table at the end, change `app/          keeper, OpenRouter keys, Orthogonal tools over MCP, HTTP API, dashboard` to `app/          keeper, inference proxy, Orthogonal tools over MCP, HTTP API, dashboard`.

After the run block in the README, add:

```
**Use a key.** Point any OpenAI-compatible client at `http://localhost:8787/v1` with an Inferest key as the API key (model ids are OpenRouter's); `http://localhost:8787/setup` has copyable snippets. The same key authenticates to the MCP tools server at `/mcp`. Set `KEY_ENCRYPTION_KEY` (`openssl rand -hex 32`) before the first start.
```

- [ ] **Step 3: Update the workflow doc**

In `docs/06-workflow.md` replace section 2 with:

```
### 2. Keys

In the dashboard the admin creates keys and sets a weight per key (default 1). A key is an Inferest secret (`sk-inf-...`) shown once and stored as a hash; the admin can rotate it (new secret, same budget and history) or revoke it (next request gets 401). Developers use it as the API key of any OpenAI-compatible client with the base URL set to the Inferest server, and as the bearer for the MCP tools server.

Behind every vault sits one OpenRouter key, minted when the vault is registered and stored encrypted. The proxy forwards each call with that key; the keeper holds its limit at the vault's open credit as a backstop, so a proxy bug cannot spend past yield.
```

Replace section 3 with:

```
### 3. Report, meter and sync

**Daily**, the keeper calls `report()` on each customer vault. Profit since the last report is minted to the Splitter as vault shares.

**Per call**, the proxy reads the key's remaining budget from the store, refuses with 402 when nothing is left, forwards the request with the vault's OpenRouter key, and records the cost from the response (the usage event of a stream, the usage object otherwise) as one `model_calls` row. A call whose cost never arrives is filed pending and resolved by the keeper through OpenRouter's generation lookup.

**Every minute**, per customer:

```
credit_i     = yieldInSplitter × (1 − railFee) × weight_i / Σ weights        (a revoked key weighs 0)
spent_i      = modelCost_i + toolSpend_i × (1 − railFee)                       (this period's rows)
remaining_i  = max(credit_i − spent_i, 0), scaled down if Σ remaining would exceed credit − Σ spent
companyLimit = usage_OR + Σ remaining_i                                          (OpenRouter limits are cumulative)
```

A key's credit is fixed by its weight, so what one key leaves unused does not flow to the others. The proxy enforces `remaining_i` before every call; one in-flight request may overshoot by its own cost. The company limit is the backstop, one keeper tick behind. Once a day the keeper logs the drift between OpenRouter's cumulative usage and the recorded model cost.

**Loss pending:** if the yield source is worth less than the vault last reported, the proxy refuses the vault's keys with 402 and the keeper pins the company key's limit at its usage, until the next `report()` books the loss.
```

Then make these exact edits elsewhere in `docs/06-workflow.md` (old text on the left of each arrow is the current line or fragment; replace it with the right):

- Summary item 3: `Our keeper keeps each OpenRouter key's limit at its weight's share of the yield **already in the Splitter**, so every dollar of credit is backed before it is spent.` becomes `Our proxy lets each Inferest key spend its weight's share of the yield **already in the Splitter**, and our keeper holds the vault's single OpenRouter key at that same total as a backstop, so every dollar of credit is backed before it is spent.`
- Actors, Key holders row: `Call models with their key over OpenRouter, call paid tools with the same key over our MCP server.` becomes `Call models with their Inferest key through our proxy, call paid tools with the same key over our MCP server.`
- Actors, Keeper row: `syncs OpenRouter limits.` becomes `holds each vault's OpenRouter key limit at its open credit.`
- Actors, OpenRouter row: `| **OpenRouter** | Our account, prefunded float | Serves model requests, enforces per-key limits |` becomes `| **OpenRouter** | Our account, prefunded float, one key per vault | Serves the model requests our proxy forwards; its per-vault limit is the backstop |`
- Lifecycle diagram (keep every other line, never put a semicolon in a message):
  - `C->>W: create keys and set weights` becomes `C->>W: register the vault, create Inferest keys and set weights`
  - `W->>O: create keys with limit 0` becomes `W->>O: create one key per vault with limit 0`
  - `W->>O: read usage per key, set each limit` becomes `W->>O: read the vault key's usage, set its limit to usage plus open credit`
  - `K->>O: model calls within the limit` becomes two lines: `K->>W: model call on the Inferest key, budget checked` and `W->>O: forwarded with the vault key, cost metered from the response`
  - `W->>O: freeze every key at its usage, then re-read usage` becomes `W->>O: close the vault, pin its key at usage, drain in-flight metering`
- Section 4, last sentence: `LLM calls do not go through us; they still go straight to OpenRouter on the same key.` becomes `LLM calls go through the same server on the same key, at `/v1/chat/completions`.`
- Section 5, steps 1 and 2 become:
  `1. Marks the vault as settling, so the proxy answers its keys with 503 (retry later), and pins the vault's OpenRouter key limit at its current usage, so nothing new can land either way.`
  `2. Waits up to ten seconds for requests already past the budget check to finish metering, then reads this period's rows: `usage = Σ modelCost / (1 − railFee) + Σ toolSpend`.`
- Section 5, step 3: `each key's usage snapshot` becomes `each key's spend snapshot`.
- Section 5, step 4: `starts the new period with the snapshot as each key's baseline, marks the month, and re-syncs limits` becomes `starts the new period (spend is per period, so this is a bump), clears the settling flag, marks the month, and re-syncs the backstop`; `reopens the keys` becomes `reopens the vault`.
- Section 5, step 5: `the vault's keys stay frozen` becomes `the vault stays closed`.
- "What the contracts enforce", not-enforced row: `Usage is off-chain OpenRouter and Orthogonal data.` becomes `Usage is our own metering of OpenRouter responses and Orthogonal payments.`
- Decisions, item 8: `**Keys:** OpenRouter Management API keys under our account, not our own proxy. LLM calls never pass through us.` becomes `**Keys:** Inferest keys on our own proxy, in front of one OpenRouter Management API key per vault. LLM calls pass through us for the budget check and the metering; the provider key's limit is the backstop.`
- Agent demo, item 2: `The agent runs with its Inferest key as its OpenRouter key, plus the Inferest MCP server for tools.` becomes `The agent runs with its Inferest key and the Inferest base URL in place of OpenRouter's, plus the Inferest MCP server for tools.`
- Known gaps: `Every customer's keys live under our account.` becomes `Every vault's key lives under our account.`

Validate the diagram the way the earlier docs task did: `npx -y @mermaid-js/mermaid-cli -i docs/06-workflow.md -o /tmp/workflow-check.md` from the scratchpad, or paste the block into the Mermaid live editor; it must render.

Finally `grep -n -i "openrouter key" docs/06-workflow.md README.md` must show no sentence left that says a developer's key is an OpenRouter key or that OpenRouter meters per developer. The two facts to preserve everywhere: developers hold Inferest keys; OpenRouter holds one key per vault as the backstop.

- [ ] **Step 4: Update the deck note**

In `deck/outline.md`, after the float top-up speaker note, add:

```
Keys, speaker note for slides 6 and 7: developers get Inferest keys, not provider keys. Our proxy checks the key's yield budget before each call and meters the cost after; one OpenRouter key per vault sits behind it with its limit held at the vault's open credit as a backstop. A client changes only its base URL, and the same key opens the paid tools over MCP.
```

- [ ] **Step 5: Run the treasury demo end to end**

With anvil forked and the server on `.env.anvil` running (the procedure from the earlier build: `anvil --fork-url ... --state anvil-state.json`, deploy if needed, `node --env-file=.env.anvil app/cli.ts serve`), run `node --env-file=.env.anvil demo/treasury.ts`. Expected: step 4 prints three answers with costs; `printState` shows each key's `modelSpent` moved; step 5's settlement `usageMicro` equals the sum of the three recorded costs (times 1e6, rounded) plus zero tool spend. Then `node --env-file=.env.anvil demo/agent.ts` and confirm the agent's chat calls go through the proxy (server log lines `proxy key ...`) while the MCP tool calls still settle. Paste the relevant output lines in the report. Delete the probe keys' OpenRouter company keys afterwards only if the vaults are throwaway demo vaults (the demo re-registers them).

- [ ] **Step 6: Typecheck, test, and check the prose rules**

Run: `npm test && npm run typecheck && grep -rn "—" README.md docs/06-workflow.md deck/outline.md demo/*.ts | grep -v "^Binary" ; git diff --name-only`
Expected: tests pass, tsc silent, the grep for em dashes prints nothing, and the diff touches only the files listed for this task.

- [ ] **Step 7: Commit**

```bash
git add demo/lib.ts demo/treasury.ts README.md docs/06-workflow.md deck/outline.md
git commit -m "Demos and docs: developers hold Inferest keys; one OpenRouter key per vault is the backstop"
```

---

## After the last task

1. Final review: a fresh reviewer on the most capable model reads the whole feature diff (`git diff 5cff607..main` after Task 9 merges) against the spec, with the five Review Focus items and the Acceptance list as the checklist. One fix dispatch, one scoped re-review.
2. Pre-push secret scan (`git log -p 5cff607..HEAD | grep -n -i -E "sk-or-v1|sk-inf-[A-Za-z0-9_-]{32}|0x[0-9a-f]{64}|KEY_ENCRYPTION_KEY=[0-9a-f]"` must print nothing but test fixtures and placeholders), then push `main`.
3. Update the memory index note on the project state (the proxy is in; keys are Inferest keys; `KEY_ENCRYPTION_KEY` is required).
