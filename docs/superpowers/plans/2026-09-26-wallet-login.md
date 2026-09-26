# Wallet Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A finance lead signs in through Dynamic (email code with an embedded wallet, or their treasury wallet through Dynamic's connectors) and manages the vault their wallet created; the operator token keeps working; state is scoped per caller; a demo faucet funds a session's wallet on a demo chain.

**Architecture:** Login and wallets come from Dynamic's headless JavaScript SDK, bundled once with esbuild into the plain dashboard. The server verifies Dynamic's RS256 JWT itself against the environment's JWKS (`app/auth.ts`, `node:crypto` only) and resolves every `/api` request into operator, session or nobody; one rule authorizes a session on a vault: a verified wallet in the token equals the vault's customer address. No schema change. A shared `app/faucet.ts` moves the chain cheat calls out of the demo helpers so a flag-gated route can fund a session's own wallet.

**Tech Stack:** Node 26 native TypeScript (erasable syntax only, `.ts` imports), `node:test`, `node:crypto` (RSA-SHA256 verify from JWK), `node:http`; `@dynamic-labs-sdk/client` and `@dynamic-labs-sdk/evm` 1.34.x, `viem` 2.56.x, `esbuild` (dev) for one browser bundle.

**Spec:** [`docs/superpowers/specs/2026-09-26-wallet-login-design.md`](../specs/2026-09-26-wallet-login-design.md). The spec is the authority; this plan is its argument. Read both.

## Global Constraints

- Node >= 22.6 (development machine runs 26.4). TypeScript must be **erasable syntax only**: no `enum`, no `namespace`, no constructor parameter properties. Relative imports carry the `.ts` extension. Type-only imports use `import type` or inline `type`. Dashboard files under `app/dashboard/` are plain browser JavaScript (ES modules).
- Verification for every task: `npm test` (node:test over `engine/*.test.ts app/test/*.test.ts`) and `npm run typecheck` (`tsc --noEmit`, must print nothing). The test run must print no stray output and exit on its own.
- **No hackathon or event names** in any committed file, commit message or branch name. The generic word "hackathon" and the identifier `HACKATHON_PARAMS` are allowed. Vendor names (Dynamic, OpenRouter) are fine.
- English prose: no em dashes, American spelling.
- Never read `.env`. Never commit `.env.anvil`, `inferest.db`, `.obsidian/workspace.json`, `contracts/deployments/42161.json` or the built bundle `app/dashboard/dynamic.bundle.js`. Stage files by name, never `git add -A`.
- Secrets: a JWT is never logged. The keeper's `RPC_URL` is never sent to the browser; only `PUBLIC_RPC_URL` is. The admin token stays server-side and in the operator's browser field only.
- Authorization answers, verbatim: 401 `{ "error": "sign in or send the admin token" }` with no usable credentials; 403 `{ "error": "not your vault" }` for a session that does not own the vault; 404 `{ "error": "unknown vault" }` / `{ "error": "unknown key" }` as today.
- Config: `DYNAMIC_ENVIRONMENT_ID` (optional), `PUBLIC_RPC_URL` (optional), `DEMO_FAUCET` (`1` enables). With no environment id, bearer tokens are treated as absent and everything behaves as today.
- Faucet amounts: 1 unit of the native currency (`10n ** 18n` wei) and 100,000 USDC (`100_000_000_000n` base units).
- Dynamic SDK facts (verified against version 1.34.2): main exports from `@dynamic-labs-sdk/client`: `createDynamicClient`, `initializeClient`, `sendEmailOTP({ email })` (returns an `otpVerification` object), `verifyOTP({ otpVerification, verificationToken })`, `getAvailableWalletProvidersData()` (each `{ key, groupKey, chain, walletProviderType, metadata: { displayName, icon } }`), `connectAndVerifyWithWalletProvider({ walletProviderKey })`, `getWalletAccounts()`, `getPrimaryWalletAccount()` (`{ address, chain, walletProviderKey, verifiedCredentialId, id }` or null), `logout()`; the client object has `token: string | null` (the JWT) and `initStatus`. Embedded wallets from the subpath `@dynamic-labs-sdk/client/waas`: `getChainsMissingWaasWalletAccounts()` and `createWaasWalletAccounts({ chains })`; the EVM chain name is `"EVM"`. From `@dynamic-labs-sdk/evm`: `addEvmExtension()`; from `@dynamic-labs-sdk/evm/wallet-connect`: `addWalletConnectEvmExtension()`; from `@dynamic-labs-sdk/evm/viem`: `createWalletClientForWalletAccount({ walletAccount })` (a viem `WalletClient` on the active network) and `createPublicClientFromNetworkData({ networkData })`. Networks are supplied through `createDynamicClient({ transformers: { networksData: (list) => NetworkData[] } })`; a `NetworkData` has `blockExplorerUrls: string[]`, `chain: "EVM"`, `displayName`, `iconUrl`, `name` (`evm-<chainId>`), `nativeCurrency: { name, symbol, decimals }`, `networkId: "<chainId>"`, `rpcUrls: { http: string[] }`; the first network of a chain is the default. The SDK needs a bundler (it builds a hidden iframe for MPC); a trial esbuild bundle of the wrapper is 1.9 MB minified and pulls in no React.
- Dynamic JWT facts (from the tokens documentation): RS256; JWKS at `https://app.dynamicauth.com/api/v0/sdk/<environmentId>/.well-known/jwks`; claims `sub`, `environment_id`, `email`, `exp`, `verified_credentials[]` with `address`, `chain` (`"eip155"` for EVM), `id`, `wallet_name`.
- Branch per task: `login-<slug>` off `main`, reviewed by a fresh subagent, merged with `git merge --no-ff` only when the review is clean, then pushed after the usual secret scan.
- End every commit message with:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_017pfxD343MHfruJDutYH1Qy`
- If `git` prints `xcrun: error ... SDK "macosx" cannot be located`, run `/usr/bin/git` instead.

## Before Task 4 (the dashboard): what the user sets up on Dynamic's side

Nothing in Tasks 1 to 3 needs a Dynamic account (the tests sign their own tokens). Before Task 4's browser check, the user creates a free environment at `app.dynamic.xyz` and, in its dashboard: enables **Email** login (one-time code); enables **Embedded wallets** for **EVM**; adds the dashboard's origins to the allowed origins (`http://localhost:8787` now, the public URL later); optionally enables **WalletConnect** (needs a WalletConnect project id in Dynamic's settings) and social providers. The environment id goes into `.env` as `DYNAMIC_ENVIRONMENT_ID`. The controller asks for it when Task 4 is reached.

## Review Focus

1. **A token from another Dynamic environment.** The signature verifies against its own environment's keys only if we fetched them; the guard is the `environment_id` claim against the configured id. Test: Task 1 `a token for another environment is refused`.
2. **A session whose wallet created the vault but the vault was registered by the operator.** Ownership is the on-chain customer, not who registered, so the session must be able to manage it. Test: Task 2 `a session manages a vault the operator registered`.
3. **A vault with several sessions.** Two different logins holding the same wallet address (an email login that connected the treasury wallet, and the treasury wallet logging in on its own) are the same owner. Test: Task 2 `two sessions with the same wallet both own the vault`.
4. **The faucet on a real chain.** With the flag off the route must not exist, and even with it on it must fund only the session's own wallet. Tests: Task 3 `the faucet is absent when disabled` and `the faucet funds a session's own wallet and refuses a foreign address`.
5. **A bearer that is not a JWT at all** (an Inferest key pasted into the wrong field, or garbage). It must be 401 without a stack trace or a log of the value. Test: Task 2 `garbage bearers are 401 and never logged`.

---

## File Structure

```
app/auth.ts                     NEW   verifyDynamicJwt, jwks cache, Session type
app/faucet.ts                   NEW   createFaucet: gas and USDC through the chain's cheat methods (anvil, Tenderly)
app/config.ts                   MOD   dynamicEnvironmentId, publicRpcUrl, demoFaucet, chain name/nativeCurrency/explorer
app/server.ts                   MOD   caller resolution, authorization per route, scoped state, faucet route
app/cli.ts                      MOD   wires auth, faucet and the new public config
app/dashboard/src/dynamic.js    NEW   the SDK wrapper (bundled)
app/dashboard/dynamic.bundle.js BUILT git-ignored, produced by npm run build:dashboard
app/dashboard/index.html        MOD   sign-in card, deposit, operator section
app/dashboard/app.js            MOD   session-aware calls, deposit through Dynamic
app/test/auth.test.ts           NEW
app/test/faucet.test.ts         NEW
app/test/testjwt.ts             NEW   test helper: RSA keypair, JWKS, signed tokens
app/test/config.test.ts         MOD
app/test/server.test.ts         MOD
config/arbitrum-one.json        MOD   nativeCurrency, explorer
demo/lib.ts                     MOD   uses app/faucet.ts; sends the operator token on reads
package.json                    MOD   dependencies, build:dashboard, serve
.gitignore, .env.example        MOD
README.md, docs/06-workflow.md, docs/07-walkthrough.md (NEW), deck/outline.md   MOD
```

Every task below runs from the repository root `~/inferest`.

---

### Task 1: Token verification and config

**Branch:** `login-auth`

**Files:**
- Create: `app/auth.ts`, `app/test/auth.test.ts`, `app/test/testjwt.ts`
- Modify: `app/config.ts`, `app/test/config.test.ts`, `config/arbitrum-one.json`, `.env.example`

**Interfaces:**
- Produces: `type Session = { userId: string; email?: string; wallets: string[] }`; `type AuthDeps = { environmentId: string; fetchFn?: typeof fetch; now?: () => number; jwksUrl?: string }`; `createAuth(deps): { verify(token: string): Promise<Session> }` (rejects with an `Error` whose message starts with `invalid token:`); `jwksUrlFor(environmentId)`. Test helper `app/test/testjwt.ts`: `makeSigner(kid?)` returning `{ jwk, sign(payload, opts?) }` and `jwksFetch(...signers)`. `Config` gains `dynamicEnvironmentId?: string`, `publicRpcUrl?: string`, `demoFaucet: boolean`, `chainName: string`, `nativeCurrency: { name, symbol, decimals }`, `explorer?: string`.

- [ ] **Step 1: Write the test helper**

Create `app/test/testjwt.ts`:

```ts
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";

export type Signer = { kid: string; jwk: Record<string, unknown>; privateKey: KeyObject; sign(payload: Record<string, unknown>, header?: Record<string, unknown>): string };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** A throwaway RSA key that signs RS256 tokens the way Dynamic does, plus its public JWK for a fake JWKS. */
export function makeSigner(kid = "k1"): Signer {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  return {
    kid, jwk, privateKey,
    sign(payload, header = {}) {
      const signing = `${b64({ alg: "RS256", typ: "JWT", kid, ...header })}.${b64(payload)}`;
      const sig = createSign("RSA-SHA256").update(signing).sign(privateKey).toString("base64url");
      return `${signing}.${sig}`;
    },
  };
}

/** A fetch that serves the given signers' public keys as a JWKS document and counts its calls. */
export function jwksFetch(...signers: Signer[]) {
  const calls = { count: 0 };
  const fn = (async () => {
    calls.count++;
    return new Response(JSON.stringify({ keys: signers.map((s) => s.jwk) }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** The claims Dynamic puts in an access token, with sensible defaults; override what a test needs. */
export function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: "user-1", environment_id: "env-1", email: "cfo@example.com",
    iat: 1_800_000_000, exp: 1_800_000_000 + 3600,
    verified_credentials: [{ id: "vc-1", address: "0x00000000000000000000000000000000000000CC", chain: "eip155", wallet_name: "dynamicwaas" }],
    ...over,
  };
}
```

- [ ] **Step 2: Write the failing auth tests**

Create `app/test/auth.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuth, jwksUrlFor } from "../auth.ts";
import { makeSigner, jwksFetch, claims } from "./testjwt.ts";

const NOW = 1_800_000_000_000; // ms, 60 s after iat
const auth = (fetchFn: typeof fetch, over: Partial<Parameters<typeof createAuth>[0]> = {}) =>
  createAuth({ environmentId: "env-1", fetchFn, now: () => NOW, ...over });

test("the jwks url names the environment", () => {
  assert.equal(jwksUrlFor("env-1"), "https://app.dynamicauth.com/api/v0/sdk/env-1/.well-known/jwks");
});

test("a valid token yields the user, email and lowercased eip155 wallets", async () => {
  const s = makeSigner();
  const { fn, calls } = jwksFetch(s);
  const session = await auth(fn).verify(s.sign(claims()));
  assert.deepEqual(session, { userId: "user-1", email: "cfo@example.com", wallets: ["0x00000000000000000000000000000000000000cc"] });
  assert.equal(calls.count, 1);
});

test("the jwks is fetched once and reused", async () => {
  const s = makeSigner();
  const { fn, calls } = jwksFetch(s);
  const a = auth(fn);
  await a.verify(s.sign(claims()));
  await a.verify(s.sign(claims({ sub: "user-2" })));
  assert.equal(calls.count, 1);
});

test("an unknown key id triggers a refetch once the last fetch is a minute old, then verifies", async () => {
  const s1 = makeSigner("k1");
  const s2 = makeSigner("k2");
  let served = [s1];
  let count = 0;
  let t = NOW;
  const fn = (async () => { count++; return new Response(JSON.stringify({ keys: served.map((x) => x.jwk) }), { status: 200 }); }) as unknown as typeof fetch;
  const a = auth(fn, { now: () => t });
  await a.verify(s1.sign(claims()));
  served = [s1, s2];
  t += 61_000;
  await a.verify(s2.sign(claims()));
  assert.equal(count, 2);
});

test("an unknown key id does not refetch within a minute of the last fetch", async () => {
  const s1 = makeSigner("k1");
  const s2 = makeSigner("k2");
  const { fn, calls } = jwksFetch(s1);
  const a = auth(fn);
  await a.verify(s1.sign(claims()));
  await assert.rejects(a.verify(s2.sign(claims())), /invalid token: unknown key/);
  await assert.rejects(a.verify(s2.sign(claims())), /invalid token: unknown key/);
  assert.equal(calls.count, 1); // a rotated key is picked up a minute later, not on every miss
});

test("a bad signature is refused", async () => {
  const s = makeSigner();
  const other = makeSigner("k1"); // same kid, different key
  const { fn } = jwksFetch(s);
  await assert.rejects(auth(fn).verify(other.sign(claims())), /invalid token: bad signature/);
});

test("an expired token is refused", async () => {
  const s = makeSigner();
  const { fn } = jwksFetch(s);
  await assert.rejects(auth(fn).verify(s.sign(claims({ exp: 1_800_000_000 - 1 }))), /invalid token: expired/);
});

test("a token for another environment is refused", async () => {
  const s = makeSigner();
  const { fn } = jwksFetch(s);
  await assert.rejects(auth(fn).verify(s.sign(claims({ environment_id: "env-2" }))), /invalid token: wrong environment/);
});

test("a token without eip155 credentials yields no wallets", async () => {
  const s = makeSigner();
  const { fn } = jwksFetch(s);
  const session = await auth(fn).verify(s.sign(claims({ verified_credentials: [{ id: "x", address: "abc", chain: "solana" }, { id: "y", email: "a@b.c", format: "email" }] })));
  assert.deepEqual(session.wallets, []);
});

test("duplicate wallets collapse and case does not matter", async () => {
  const s = makeSigner();
  const { fn } = jwksFetch(s);
  const session = await auth(fn).verify(s.sign(claims({ verified_credentials: [
    { id: "a", address: "0xABCDEF0000000000000000000000000000000001", chain: "eip155" },
    { id: "b", address: "0xabcdef0000000000000000000000000000000001", chain: "eip155" },
  ] })));
  assert.deepEqual(session.wallets, ["0xabcdef0000000000000000000000000000000001"]);
});

test("malformed tokens and other algorithms are refused without a fetch", async () => {
  const s = makeSigner();
  const { fn, calls } = jwksFetch(s);
  const a = auth(fn);
  for (const bad of ["", "nope", "a.b", "sk-inf-abcdefghijklmnopqrstuvwxyz012345", "a.b.c.d"]) {
    await assert.rejects(a.verify(bad), /invalid token: malformed/);
  }
  await assert.rejects(a.verify(s.sign(claims(), { alg: "HS256" })), /invalid token: unsupported algorithm/);
  assert.equal(calls.count, 0);
});

test("a jwks fetch failure is reported, not thrown as a raw error", async () => {
  const s = makeSigner();
  const fn = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(auth(fn).verify(s.sign(claims())), /invalid token: jwks unavailable/);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test app/test/auth.test.ts`
Expected: `Cannot find module '../auth.ts'`.

- [ ] **Step 4: Write `app/auth.ts`**

```ts
import { createPublicKey, createVerify, type KeyObject } from "node:crypto";

/** What a verified Dynamic login tells us: who, and which EVM wallets they have proven. */
export type Session = { userId: string; email?: string; wallets: string[] };

export type AuthDeps = {
  environmentId: string;
  fetchFn?: typeof fetch;
  /** Milliseconds since the epoch (default Date.now). */
  now?: () => number;
  /** Overrides the JWKS URL (tests). */
  jwksUrl?: string;
};

export type Auth = { verify(token: string): Promise<Session> };

export const jwksUrlFor = (environmentId: string): string =>
  `https://app.dynamicauth.com/api/v0/sdk/${encodeURIComponent(environmentId)}/.well-known/jwks`;

const REFETCH_MIN_MS = 60_000;
const invalid = (why: string) => new Error(`invalid token: ${why}`);

function decodePart(part: string): any {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw invalid("malformed");
  }
}

/**
 * Verifies Dynamic's RS256 access tokens against the environment's JWKS, which is fetched once, cached by key id,
 * and refetched at most once a minute when a token names a key we do not hold. Only the signature, the expiry
 * and the environment are checked; authorization is the caller's job.
 */
export function createAuth(d: AuthDeps): Auth {
  const fetchFn = d.fetchFn ?? fetch;
  const now = d.now ?? Date.now;
  const url = d.jwksUrl ?? jwksUrlFor(d.environmentId);
  let keys = new Map<string, KeyObject>();
  let fetchedAt = 0;

  async function refresh(): Promise<void> {
    let res: Response;
    try {
      res = await fetchFn(url);
    } catch {
      throw invalid("jwks unavailable");
    }
    if (!res.ok) throw invalid("jwks unavailable");
    const body: any = await res.json().catch(() => ({}));
    const next = new Map<string, KeyObject>();
    for (const jwk of Array.isArray(body.keys) ? body.keys : []) {
      if (jwk?.kty !== "RSA" || typeof jwk.kid !== "string") continue;
      try {
        next.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
      } catch {
        // an unusable key is skipped; a token naming it fails as unknown
      }
    }
    keys = next;
    fetchedAt = now();
  }

  async function keyFor(kid: string): Promise<KeyObject> {
    if (keys.size === 0) await refresh();
    let key = keys.get(kid);
    if (!key && now() - fetchedAt >= REFETCH_MIN_MS) {
      await refresh();
      key = keys.get(kid);
    }
    if (!key) throw invalid("unknown key");
    return key;
  }

  return {
    async verify(token) {
      if (typeof token !== "string" || token.length > 8192) throw invalid("malformed");
      const parts = token.split(".");
      if (parts.length !== 3 || parts.some((p) => p.length === 0)) throw invalid("malformed");
      const header = decodePart(parts[0]);
      const payload = decodePart(parts[1]);
      if (header?.alg !== "RS256") throw invalid("unsupported algorithm");
      if (typeof header.kid !== "string") throw invalid("malformed");
      const key = await keyFor(header.kid);
      const ok = createVerify("RSA-SHA256").update(`${parts[0]}.${parts[1]}`).verify(key, Buffer.from(parts[2], "base64url"));
      if (!ok) throw invalid("bad signature");
      if (typeof payload.exp !== "number" || payload.exp * 1000 <= now()) throw invalid("expired");
      if (payload.environment_id !== d.environmentId) throw invalid("wrong environment");
      if (typeof payload.sub !== "string" || !payload.sub) throw invalid("malformed");
      const wallets = new Set<string>();
      for (const vc of Array.isArray(payload.verified_credentials) ? payload.verified_credentials : []) {
        if (vc?.chain === "eip155" && typeof vc.address === "string" && /^0x[0-9a-f]{40}$/i.test(vc.address)) wallets.add(vc.address.toLowerCase());
      }
      const session: Session = { userId: payload.sub, wallets: [...wallets] };
      if (typeof payload.email === "string" && payload.email) session.email = payload.email;
      return session;
    },
  };
}
```

- [ ] **Step 5: Run the auth tests**

Run: `node --test app/test/auth.test.ts`
Expected: 12 tests pass. If "unknown key id triggers one refetch" fails, check that the first `verify` populates `keys` (so `keys.size === 0` no longer forces a refresh) and that the miss path compares `now() - fetchedAt` with the minute.

- [ ] **Step 6: Config**

In `app/config.ts` extend `Config`:

```ts
export type Config = {
  rpcUrl: string; chainId: number; usdc: Hex; target: Hex; factory: Hex; splitter: Hex;
  keeperKey: Hex; openRouterKey: string; orthogonalKey: string; toolWalletKey?: Hex;
  adminToken: string; keyEncryptionKey: string; publicUrl: string; dbPath: string; port: number; params: Params;
  /** Dynamic environment whose logins the server accepts; login is off when unset. */
  dynamicEnvironmentId?: string;
  /** Browser-facing RPC for the dashboard's wallet; never the keeper's rpcUrl. */
  publicRpcUrl?: string;
  /** Whether POST /api/demo/fund exists (DEMO_FAUCET=1). */
  demoFaucet: boolean;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  explorer?: string;
};
```

and add to the returned object, after `params`:

```ts
    dynamicEnvironmentId: env.DYNAMIC_ENVIRONMENT_ID || undefined,
    publicRpcUrl: env.PUBLIC_RPC_URL ? env.PUBLIC_RPC_URL.replace(/\/+$/, "") : undefined,
    demoFaucet: env.DEMO_FAUCET === "1",
    chainName: String(chain.name ?? `chain ${dep.chainId}`),
    nativeCurrency: chain.nativeCurrency ?? { name: "Ether", symbol: "ETH", decimals: 18 },
    explorer: chain.explorer ? String(chain.explorer) : undefined,
```

`config/arbitrum-one.json` becomes:

```json
{
  "chainId": 42161,
  "name": "Arbitrum One",
  "nativeCurrency": { "name": "Ether", "symbol": "ETH", "decimals": 18 },
  "explorer": "https://arbiscan.io",
  "usdc": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  "target": "0x1A996cb54bb95462040408C06122D45D6Cdb6096",
  "targetName": "Fluid USDC"
}
```

Append to `app/test/config.test.ts`:

```ts
test("login, public rpc and faucet are off unless configured", () => {
  const cfg = loadConfig(envFor(42161, 42161));
  assert.equal(cfg.dynamicEnvironmentId, undefined);
  assert.equal(cfg.publicRpcUrl, undefined);
  assert.equal(cfg.demoFaucet, false);
  assert.equal(cfg.chainName, "chain 42161");
  assert.deepEqual(cfg.nativeCurrency, { name: "Ether", symbol: "ETH", decimals: 18 });
});

test("login, public rpc and faucet come from the environment", () => {
  const cfg = loadConfig({ ...envFor(42161, 42161), DYNAMIC_ENVIRONMENT_ID: "env-1", PUBLIC_RPC_URL: "http://127.0.0.1:8545/", DEMO_FAUCET: "1" });
  assert.equal(cfg.dynamicEnvironmentId, "env-1");
  assert.equal(cfg.publicRpcUrl, "http://127.0.0.1:8545");
  assert.equal(cfg.demoFaucet, true);
  assert.equal(loadConfig({ ...envFor(42161, 42161), DEMO_FAUCET: "true" }).demoFaucet, false);
});
```

(`envFor` writes a chain config with only `chainId`, `usdc` and `target`, so the name falls back and the currency defaults.)

Append to `.env.example` after the `PUBLIC_URL` line:

```
# Dynamic environment id (app.dynamic.xyz); finance leads sign in through it. Unset = operator token only
DYNAMIC_ENVIRONMENT_ID=
# browser-facing RPC for the dashboard's wallet (a public endpoint, never the keeper's RPC_URL)
PUBLIC_RPC_URL=
# 1 exposes POST /api/demo/fund, which funds a signed-in wallet through the fork's cheat methods; never on a real chain
DEMO_FAUCET=
```

- [ ] **Step 7: Run everything and commit**

Run: `npm test && npm run typecheck`
Expected: all pass (previous count plus 14); tsc prints nothing.

```bash
git add app/auth.ts app/test/auth.test.ts app/test/testjwt.ts app/config.ts app/test/config.test.ts config/arbitrum-one.json .env.example
git commit -m "Verify Dynamic login tokens against the environment's JWKS; login, public RPC and faucet config"
```

---

### Task 2: Sessions on the server: caller resolution, authorization, scoped state

**Branch:** `login-server`

**Files:**
- Modify: `app/server.ts` (whole file), `app/keeper.ts` (extract `reportVault`), `app/cli.ts` (wire `auth` and the public config), `demo/lib.ts` (`api()` sends the operator token on reads)
- Modify: `app/test/server.test.ts` (fixture and new tests), `app/test/keeper.test.ts` (one test)

**Interfaces:**
- Consumes: `createAuth`, `Auth`, `Session` from Task 1.
- Produces: `AppDeps.auth?: Auth`; `type Caller = { kind: "operator" } | { kind: "session"; session: Session } | { kind: "none" }`; `resolveCaller(d, req)`; `reportVault(d: KeeperDeps, vault: string): Promise<void>` exported from `app/keeper.ts`; `GET /api/state` scoped; `POST /api/admin/sync` and `/report` accept `{ vault }`; 401/403 bodies as in Global Constraints. `demo/lib.ts` `api()` sends `x-admin-token` on every call.

- [ ] **Step 1: Extract `reportVault` in the keeper**

In `app/keeper.ts`, replace `reportAll` with:

```ts
/** Calls report() on one vault unless it holds only dust. Throws on a chain failure. */
export async function reportVault(d: KeeperDeps, vault: string): Promise<void> {
  const assets = await d.chain.totalAssets(vault);
  if (assets <= MIN_REPORTABLE_ASSETS) {
    d.log(`report ${vault} skipped: vault is empty`);
    return;
  }
  await d.chain.report(vault);
}

export async function reportAll(d: KeeperDeps, now: number = Date.now()): Promise<void> {
  for (const v of d.store.listVaults()) {
    try {
      await reportVault(d, v.vault);
    } catch (e) {
      d.log(`report ${v.vault} failed: ${(e as Error).message}`);
    }
  }
  d.store.setMeta("lastReport", String(now));
}
```

Add to `app/test/keeper.test.ts` (import `reportVault`):

```ts
test("reportVault reports one vault and skips an empty one", async () => {
  const empty = "0x00000000000000000000000000000000000000bb";
  const { d, store, events } = setup();
  store.addVault(empty, "0x1", "U");
  d.chain.totalAssets = async (v) => (v === empty ? 1_000n : 1_000_000_000n);
  await reportVault(d, V);
  await reportVault(d, empty);
  assert.deepEqual(events.filter((e) => e.startsWith("report:")), [`report:${V}`]);
  assert.equal(store.getMeta("lastReport"), undefined); // only reportAll stamps the day
});
```

- [ ] **Step 2: Write the failing server tests**

In `app/test/server.test.ts`, change the imports and the fixture. Add imports:

```ts
import { createAuth } from "../auth.ts";
import { makeSigner, jwksFetch, claims } from "./testjwt.ts";
```

Add above `start()`:

```ts
const SIGNER = makeSigner();
const NOW = 1_800_000_000_000;
const OWNER = "0x00000000000000000000000000000000000000cc";
const OTHER = "0x00000000000000000000000000000000000000dd";
/** A signed Dynamic token whose eip155 credentials are the given wallets. */
const tokenFor = (wallets: string[], over: Record<string, unknown> = {}) =>
  SIGNER.sign(claims({ verified_credentials: wallets.map((address, i) => ({ id: `vc-${i}`, address, chain: "eip155" })), ...over }));
```

In `start()`, add a parameter `opts: { login?: boolean } = {}` after `customer`, and inside the `AppDeps` literal add:

```ts
    auth: opts.login === false ? undefined : createAuth({ environmentId: "env-1", fetchFn: jwksFetch(SIGNER).fn, now: () => NOW }),
```

Add these helpers after `post`:

```ts
const postAs = (base: string, path: string, body: unknown, bearer: string) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
const stateAs = async (base: string, headers: Record<string, string>) => (await fetch(base + "/api/state", { headers })).json() as Promise<any>;
```

Update the existing test `mutating routes require the admin token` to also assert the body: `assert.deepEqual(await (await post(base, "/api/admin/sync", {}, "")).json(), { error: "sign in or send the admin token" });`.

Append these tests:

```ts
test("state is scoped: the operator sees every vault, a session its own, nobody none", async () => {
  const { base, server, store } = await start();
  await post(base, "/api/vaults", { vault: V, label: "Treasury" });
  const W = "0x00000000000000000000000000000000000000bb";
  store.addVault(W, OTHER, "Other");
  store.recordSettlement(W, 5n, "0xw");
  const all = await stateAs(base, { "x-admin-token": "admin" });
  assert.deepEqual(all.vaults.map((v: any) => v.vault).sort(), [V, W]);
  assert.equal(all.settlements.length, 1);
  const own = await stateAs(base, { Authorization: `Bearer ${tokenFor([OWNER])}` });
  assert.deepEqual(own.vaults.map((v: any) => v.vault), [V]);
  assert.equal(own.settlements.length, 0);
  assert.equal(own.config.chainId, 42161);
  const none = await stateAs(base, {});
  assert.deepEqual(none.vaults, []);
  assert.deepEqual(none.settlements, []);
  assert.deepEqual(none.pendingSettlements, []);
  assert.equal(none.config.chainId, 42161);
  server.close();
});

test("a session registers only a vault its wallet created", async () => {
  const { base, server, store, created } = await start();
  const r = await postAs(base, "/api/vaults", { vault: V, label: "Treasury" }, tokenFor([OTHER]));
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: "not your vault" });
  assert.equal(store.vault(V), undefined);
  assert.equal(created.length, 0);
  const ok = await postAs(base, "/api/vaults", { vault: V, label: "Treasury" }, tokenFor([OTHER, OWNER]));
  assert.equal(ok.status, 201);
  assert.equal(store.vault(V)!.customer, OWNER);
  server.close();
});

test("a session manages a vault the operator registered", async () => {
  const { base, server, store } = await start();
  await post(base, "/api/vaults", { vault: V, label: "Treasury" });
  const t = tokenFor([OWNER]);
  const k = await postAs(base, "/api/keys", { vault: V, name: "dev-1", weight: 1 }, t);
  assert.equal(k.status, 201);
  const { id } = await k.json();
  assert.equal((await postAs(base, `/api/keys/${id}/weight`, { weight: 2 }, t)).status, 200);
  assert.equal(store.keyById(id)!.weight, 2);
  assert.equal((await postAs(base, `/api/keys/${id}/rotate`, {}, t)).status, 200);
  assert.equal((await postAs(base, `/api/keys/${id}/revoke`, {}, t)).status, 200);
  const s = await postAs(base, "/api/admin/settle", { vault: V }, t);
  assert.equal(s.status, 200);
  assert.equal((await s.json()).pending, false);
  server.close();
});

test("a session cannot touch another owner's vault", async () => {
  const { base, server } = await start();
  await post(base, "/api/vaults", { vault: V, label: "Treasury" });
  const { id } = await (await post(base, "/api/keys", { vault: V, name: "dev-1", weight: 1 })).json();
  const t = tokenFor([OTHER]);
  for (const [path, body] of [
    ["/api/keys", { vault: V, name: "x", weight: 1 }],
    [`/api/keys/${id}/weight`, { weight: 2 }],
    [`/api/keys/${id}/rotate`, {}],
    [`/api/keys/${id}/revoke`, {}],
    ["/api/admin/settle", { vault: V }],
    ["/api/admin/sync", { vault: V }],
    ["/api/admin/report", { vault: V }],
  ] as const) {
    const r = await postAs(base, path, body, t);
    assert.equal(r.status, 403, path);
    assert.deepEqual(await r.json(), { error: "not your vault" });
  }
  assert.equal((await postAs(base, "/api/keys/deadbeefdeadbeef/weight", { weight: 1 }, t)).status, 404);
  assert.equal((await postAs(base, "/api/admin/settle", { vault: "0x00000000000000000000000000000000000000ee" }, t)).status, 404);
  server.close();
});

test("two sessions with the same wallet both own the vault", async () => {
  const { base, server } = await start();
  await post(base, "/api/vaults", { vault: V });
  const byEmail = tokenFor([OWNER], { sub: "user-email", email: "cfo@example.com" });
  const byWallet = tokenFor([OWNER], { sub: "user-wallet", email: undefined });
  assert.equal((await postAs(base, "/api/keys", { vault: V, name: "a", weight: 1 }, byEmail)).status, 201);
  assert.equal((await postAs(base, "/api/keys", { vault: V, name: "b", weight: 1 }, byWallet)).status, 201);
  server.close();
});

test("sync and report with a session are scoped to its vault", async () => {
  const { base, server, store, d } = await start();
  await post(base, "/api/vaults", { vault: V });
  const W = "0x00000000000000000000000000000000000000bb";
  store.addVault(W, OTHER, "Other");
  const synced: string[] = [];
  const reported: string[] = [];
  d.chain.yieldOf = async (v) => { synced.push(v); return 0n; };
  d.chain.report = async (v) => { reported.push(v); return "0x"; };
  const t = tokenFor([OWNER]);
  assert.equal((await postAs(base, "/api/admin/sync", { vault: V }, t)).status, 200);
  assert.deepEqual(synced, [V]);
  assert.equal((await postAs(base, "/api/admin/report", { vault: V }, t)).status, 200);
  assert.deepEqual(reported, [V]);
  assert.equal((await postAs(base, "/api/admin/sync", {}, t)).status, 404); // a session must name its vault
  synced.length = 0;
  assert.equal((await post(base, "/api/admin/sync", {})).status, 200); // the operator still syncs everything
  assert.deepEqual(synced.sort(), [V, W]);
  server.close();
});

test("operator-only routes refuse a session", async () => {
  const { base, server, store } = await start();
  await post(base, "/api/vaults", { vault: V });
  store.setPendingSettlement(V, { usageMicro: 5n, baselines: [], tx: "0xtx" });
  const r = await postAs(base, "/api/admin/pending/clear", { vault: V, tx: "0xtx" }, tokenFor([OWNER]));
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: "operator only" });
  assert.equal(store.pendingSettlement(V)!.tx, "0xtx");
  server.close();
});

test("garbage bearers are 401 and never logged", async () => {
  const logs: string[] = [];
  const { base, server, d } = await start();
  d.keeper.log = (m) => logs.push(m);
  for (const bad of ["sk-inf-abcdefghijklmnopqrstuvwxyz012345", "nope", "a.b.c"]) {
    const r = await postAs(base, "/api/keys", { vault: V, name: "x", weight: 1 }, bad);
    assert.equal(r.status, 401, bad);
    assert.deepEqual(await r.json(), { error: "sign in or send the admin token" });
    assert.ok(!logs.some((m) => m.includes(bad)), `token leaked into a log line for ${bad}`);
  }
  assert.ok(logs.some((m) => m.startsWith("login refused: invalid token")));
  server.close();
});

test("an expired session is 401", async () => {
  const { base, server } = await start();
  const r = await postAs(base, "/api/keys", { vault: V, name: "x", weight: 1 }, tokenFor([OWNER], { exp: 1_800_000_000 - 10 }));
  assert.equal(r.status, 401);
  server.close();
});

test("bearers are ignored when login is not configured", async () => {
  const { base, server } = await start(undefined, { login: false });
  await post(base, "/api/vaults", { vault: V });
  assert.equal((await postAs(base, "/api/keys", { vault: V, name: "x", weight: 1 }, tokenFor([OWNER]))).status, 401);
  const own = await stateAs(base, { Authorization: `Bearer ${tokenFor([OWNER])}` });
  assert.deepEqual(own.vaults, []);
  server.close();
});
```

- [ ] **Step 3: Run the server tests to verify they fail**

Run: `node --test app/test/server.test.ts`
Expected: the new tests fail (bearers get 401 everywhere, state is unscoped, `auth` is not an `AppDeps` field).

- [ ] **Step 4: Rewrite `app/server.ts`**

Replace the whole file with:

```ts
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Params } from "../engine/ledger.ts";
import type { Chain } from "./chain.ts";
import type { OpenRouter } from "./openrouter.ts";
import type { Store, VaultRow } from "./store.ts";
import type { ToolGateway } from "./tools.ts";
import type { Proxy } from "./proxy.ts";
import type { Auth, Session } from "./auth.ts";
import { buildMcpServer } from "./mcp.ts";
import { computeLimits } from "./limits.ts";
import { sha256, newInferestKey, type SecretBox } from "./crypto.ts";
import { syncAll, syncVault, reportAll, reportVault, settleVault, markRegistered, isSettling, type KeeperDeps } from "./keeper.ts";

export { sha256 } from "./crypto.ts";

export type AppDeps = {
  store: Store; or: OpenRouter; chain: Chain; gateway: ToolGateway; params: Params;
  adminToken: string; publicConfig: Record<string, unknown>; keeper: KeeperDeps;
  /** Encrypts each vault's OpenRouter key at rest. */
  secrets: SecretBox;
  proxy: Proxy;
  /** Verifies finance-lead logins; unset means the operator token is the only credential. */
  auth?: Auth;
  /** Logs an uncaught error from a route (default console.error). */
  logError?: (msg: string) => void;
};

/** Who is asking: the operator (admin token), a signed-in finance lead, or nobody. */
export type Caller = { kind: "operator" } | { kind: "session"; session: Session } | { kind: "none" };

const DASHBOARD = fileURLToPath(new URL("./dashboard/", import.meta.url));
const ZERO = /^0x0{40}$/i;
const KEY_ROUTE = /^\/api\/keys\/([0-9a-f]{16})\/(weight|revoke|rotate)$/;
const NEED_LOGIN = { error: "sign in or send the admin token" };
const NOT_YOURS = { error: "not your vault" };
const OPERATOR_ONLY = { error: "operator only" };

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

/** Resolves the request's credentials once. A bearer that fails verification counts as nobody and is logged by reason only. */
export async function resolveCaller(d: AppDeps, req: IncomingMessage): Promise<Caller> {
  if (req.headers["x-admin-token"] === d.adminToken) return { kind: "operator" };
  const token = bearer(req);
  if (!token || !d.auth) return { kind: "none" };
  try {
    return { kind: "session", session: await d.auth.verify(token) };
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

/** The public state for one caller: field by field, never a spread of a store row, so a new secret column can never leak. */
function state(d: AppDeps, caller: Caller) {
  const vaults = d.store.listVaults().filter((v) => owns(caller, v.customer));
  const mine = new Set(vaults.map((v) => v.vault));
  return {
    config: d.publicConfig,
    vaults: vaults.map((v: VaultRow) => {
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
    settlements: d.store.listSettlements().filter((s) => mine.has(s.vault)),
    pendingSettlements: d.store.listPendingSettlements().filter((p) => mine.has(p.vault)).map((p) => ({
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

async function route(d: AppDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
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
        d.store.addVault(vault, customer, String(body.label ?? "customer"));
        markRegistered(d.store, vault); // a vault added mid-month is first settled next month
        d.store.setVaultOpenRouterKey(vault, minted.hash, minted.encrypted);
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
    if (url.pathname === "/api/admin/sync" || url.pathname === "/api/admin/report") {
      const report = url.pathname.endsWith("/report");
      if (caller.kind === "operator" && body.vault === undefined) {
        if (report) await reportAll(d.keeper); else await syncAll(d.keeper);
        return send(res, 200, { ok: true });
      }
      const vault = String(body.vault ?? "").toLowerCase();
      if (!vaultFor(d, res, caller, vault)) return;
      if (report) await reportVault(d.keeper, vault);
      await syncVault(d.keeper, vault);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/admin/settle") {
      const vault = String(body.vault ?? "").toLowerCase();
      if (!vaultFor(d, res, caller, vault)) return;
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

  return serveStatic(res, url.pathname);
}

function sanitizeError(message: string): string {
  return message.replace(/https?:\/\/\S+/gi, "[url]").slice(0, 300);
}

export function createApp(d: AppDeps): Server {
  return createServer((req, res) => {
    route(d, req, res).catch((e) => {
      const err = e as Error;
      (d.logError ?? console.error)(err.stack ?? err.message);
      if (res.headersSent) { res.end(); return; }
      send(res, 500, { error: sanitizeError(err.message) });
    });
  });
}
```

Two existing tests change meaning and must be updated, not deleted: `settle rejects an unknown vault with 404` keeps its assertions (the operator gets 404 for an unknown vault); `the admin route clears a specific pending settlement` keeps its assertions (its 401 check for a wrong token still holds, since a wrong admin token with no bearer is nobody).

- [ ] **Step 5: Wire the CLI and the demo helpers**

In `app/cli.ts`: import `createAuth` from `./auth.ts`; build `const auth = cfg.dynamicEnvironmentId ? createAuth({ environmentId: cfg.dynamicEnvironmentId }) : undefined;` before the `serve` case; pass `auth` in the `createApp` call; extend `publicConfig` with `dynamicEnvironmentId: cfg.dynamicEnvironmentId ?? null, publicRpcUrl: cfg.publicRpcUrl ?? null, chainName: cfg.chainName, nativeCurrency: cfg.nativeCurrency, explorer: cfg.explorer ?? null, demoFaucet: cfg.demoFaucet`; and in the listen banner append `, login ${auth ? "on" : "off"}`.

In `demo/lib.ts`, `api()` sends the operator token on every call:

```ts
export async function api(path: string, body?: unknown): Promise<any> {
  const headers = { "Content-Type": "application/json", "x-admin-token": env("ADMIN_TOKEN") };
  const r = await fetch(API + path, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${j.error ?? r.status}`);
  return j;
}
```

- [ ] **Step 6: Run everything**

Run: `npm test && npm run typecheck`
Expected: all pass (previous count plus 11); tsc prints nothing; no stray output. If `two sessions with the same wallet` fails on the second key, check that `owns()` lowercases the customer and that `tokenFor` passes the address unchanged (the verifier lowercases).

- [ ] **Step 7: Commit**

```bash
git add app/server.ts app/keeper.ts app/cli.ts demo/lib.ts app/test/server.test.ts app/test/keeper.test.ts
git commit -m "Sessions on the server: a finance lead's login manages the vault its wallet created; state is scoped per caller"
```

---

### Task 3: Demo faucet

**Branch:** `login-faucet`

**Files:**
- Create: `app/faucet.ts`, `app/test/faucet.test.ts`
- Modify: `app/server.ts` (`AppDeps.faucet`, one route), `app/cli.ts`, `demo/lib.ts` (uses the shared module), `app/test/server.test.ts`

**Interfaces:**
- Consumes: `Caller`, `owns` semantics from Task 2 (the route uses `resolveCaller` and the session's wallets).
- Produces: `FAUCET_NATIVE = 10n ** 18n`, `FAUCET_USDC = 100_000_000_000n`; `type Faucet = { fund(address: string): Promise<{ native: bigint; usdc: bigint }> }`; `createFaucet({ rpcUrl, usdc, fetchFn? })`; `AppDeps.faucet?: Faucet`; `POST /api/demo/fund { address }` answering `{ ok: true, native: "<wei>", usdc: "<micro>" }`, 404 `{ error: "not found" }` when no faucet is configured, 400 `{ error: "address must be 0x plus 40 hex characters" }`, 403 `{ error: "not your wallet" }` for a session whose wallets do not include the address.

- [ ] **Step 1: Write the failing faucet tests**

Create `app/test/faucet.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFaucet, FAUCET_NATIVE, FAUCET_USDC } from "../faucet.ts";

const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const TO = "0x00000000000000000000000000000000000000cc";

/** A JSON-RPC fake: `unknown` methods answer -32601 the way anvil does for Tenderly's names, the rest answer null. */
function rpcFake(unknown: string[]) {
  const calls: { method: string; params: unknown[] }[] = [];
  const fn = (async (_url: string, init: RequestInit) => {
    const { method, params, id } = JSON.parse(String(init.body));
    calls.push({ method, params });
    const body = unknown.includes(method)
      ? { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } }
      : { jsonrpc: "2.0", id, result: null };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("funds through Tenderly's methods when the node knows them", async () => {
  const { fn, calls } = rpcFake([]);
  const r = await createFaucet({ rpcUrl: "http://rpc", usdc: USDC, fetchFn: fn }).fund(TO);
  assert.deepEqual(r, { native: FAUCET_NATIVE, usdc: FAUCET_USDC });
  assert.deepEqual(calls.map((c) => c.method), ["tenderly_setBalance", "tenderly_setErc20Balance"]);
  assert.deepEqual(calls[0].params, [[TO], "0xde0b6b3a7640000"]);
  assert.deepEqual(calls[1].params, [USDC, TO, "0x174876e800"]);
});

test("falls through anvil's methods down to the storage slot for native USDC", async () => {
  const { fn, calls } = rpcFake(["tenderly_setBalance", "tenderly_setErc20Balance", "anvil_dealERC20", "anvil_setERC20Balance"]);
  await createFaucet({ rpcUrl: "http://rpc", usdc: USDC, fetchFn: fn }).fund(TO);
  assert.deepEqual(calls.map((c) => c.method), [
    "tenderly_setBalance", "anvil_setBalance",
    "tenderly_setErc20Balance", "anvil_dealERC20", "anvil_setERC20Balance", "anvil_setStorageAt",
  ]);
  const slot = calls[5].params;
  assert.equal(slot[0], USDC);
  assert.match(String(slot[1]), /^0x[0-9a-f]{64}$/); // keccak(address, 9)
  assert.equal(slot[2], "0x000000000000000000000000000000000000000000000000000000174876e800");
});

test("a node that refuses every method reports the last error", async () => {
  const { fn } = rpcFake(["tenderly_setBalance", "anvil_setBalance"]);
  await assert.rejects(createFaucet({ rpcUrl: "http://rpc", usdc: USDC, fetchFn: fn }).fund(TO), /anvil_setBalance/);
});

test("a real error (not an unknown method) is not skipped", async () => {
  const fn = (async (_u: string, init: RequestInit) => {
    const { id } = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "insufficient permissions" } }), { status: 200 });
  }) as unknown as typeof fetch;
  await assert.rejects(createFaucet({ rpcUrl: "http://rpc", usdc: USDC, fetchFn: fn }).fund(TO), /tenderly_setBalance: insufficient permissions/);
});
```

- [ ] **Step 2: Write `app/faucet.ts`**

```ts
import { encodeAbiParameters, keccak256, pad, toHex, type Hex } from "viem";

/** What a demo wallet gets: one unit of the native currency and 100,000 USDC. */
export const FAUCET_NATIVE = 10n ** 18n;
export const FAUCET_USDC = 100_000_000_000n;

export type Faucet = { fund(address: string): Promise<{ native: bigint; usdc: bigint }> };

/**
 * Funds a wallet on a forked chain through the node's cheat methods, trying Tenderly's names first and anvil's
 * after. Native USDC (FiatToken v2.2) defeats anvil's slot search, so the last resort writes the balance mapping
 * at slot 9 directly. Useless on a real chain by construction: every method is refused there.
 */
export function createFaucet(d: { rpcUrl: string; usdc: string; fetchFn?: typeof fetch }): Faucet {
  const fetchFn = d.fetchFn ?? fetch;

  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    const r = await fetchFn(d.rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j: any = await r.json();
    if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { code: j.error.code });
    return j.result;
  }

  /** Tries each call in turn, moving on when the node does not know the method or takes it under another shape. */
  async function cheat(calls: [string, unknown[]][]): Promise<void> {
    for (const [i, [method, params]] of calls.entries()) {
      try {
        await rpc(method, params);
        return;
      } catch (e: any) {
        const unknown = e.code === -32601 || e.code === -32602 || /not found|not supported|does not exist|no slot found/i.test(e.message);
        if (!unknown || i === calls.length - 1) throw e;
      }
    }
  }

  return {
    async fund(address) {
      const to = address as Hex;
      await cheat([["tenderly_setBalance", [[to], toHex(FAUCET_NATIVE)]], ["anvil_setBalance", [to, toHex(FAUCET_NATIVE)]]]);
      await cheat([
        ["tenderly_setErc20Balance", [d.usdc, to, toHex(FAUCET_USDC)]],
        ["anvil_dealERC20", [d.usdc, to, toHex(FAUCET_USDC)]],
        ["anvil_setERC20Balance", [d.usdc, to, toHex(FAUCET_USDC)]],
        ["anvil_setStorageAt", [d.usdc, keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [to, 9n])), pad(toHex(FAUCET_USDC))]],
      ]);
      return { native: FAUCET_NATIVE, usdc: FAUCET_USDC };
    },
  };
}
```

Run: `node --test app/test/faucet.test.ts`
Expected: 4 pass. (`toHex(10n ** 18n)` is `0xde0b6b3a7640000` and `toHex(100_000_000_000n)` is `0x174876e800`; `pad` left-pads to 32 bytes.)

- [ ] **Step 3: The route, the wiring and the demo helpers**

`app/server.ts`: add `import type { Faucet } from "./faucet.ts";` and `faucet?: Faucet;` to `AppDeps` (comment: `/** Funds a signed-in wallet on a demo chain; unset on real chains. */`). Add the route inside the `/api/` POST block, before the `/api/admin/sync` branch:

```ts
    if (url.pathname === "/api/demo/fund") {
      if (!d.faucet) return send(res, 404, { error: "not found" });
      const address = String(body.address ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address)) return send(res, 400, { error: "address must be 0x plus 40 hex characters" });
      if (caller.kind === "session" && !caller.session.wallets.includes(address)) return send(res, 403, { error: "not your wallet" });
      const funded = await d.faucet.fund(address);
      d.keeper.log(`faucet funded ${address}`);
      return send(res, 200, { ok: true, native: funded.native.toString(), usdc: funded.usdc.toString() });
    }
```

`app/cli.ts`: `import { createFaucet } from "./faucet.ts";` and pass `faucet: cfg.demoFaucet ? createFaucet({ rpcUrl: cfg.rpcUrl, usdc: cfg.usdc }) : undefined` to `createApp`.

`demo/lib.ts`: delete the local `cheat`, `fundEth` and `fundUsdc` (keep `rpc`, which `warp` uses) and drop the imports that only they used (`encodeAbiParameters`, `keccak256`, `pad`; `toHex` stays for `warp`). Add:

```ts
import { createFaucet } from "../app/faucet.ts";
const faucet = createFaucet({ rpcUrl: RPC, usdc: chainCfg.usdc });
/** Gas plus 100,000 USDC from the fork's cheat methods, the same code the dashboard's faucet route runs. */
export const fundDemoWallet = async (to: string) => { await faucet.fund(to); };
```

In `customerWithVault`, replace the two funding lines with `await fundDemoWallet(account.address);` (the faucet's 100,000 USDC covers the treasury demo's deposit exactly and the agent demo's 20,000). `grep -n "fundEth\|fundUsdc" demo/` must then print nothing.

Append to `app/test/server.test.ts` (the fixture gains `faucet` when `opts.faucet` is true; record funded addresses):

```ts
test("the faucet is absent when disabled", async () => {
  const { base, server } = await start();
  await post(base, "/api/vaults", { vault: V });
  assert.equal((await post(base, "/api/demo/fund", { address: OWNER })).status, 404);
  assert.equal((await postAs(base, "/api/demo/fund", { address: OWNER }, tokenFor([OWNER]))).status, 404);
  server.close();
});

test("the faucet funds a session's own wallet and refuses a foreign address", async () => {
  const funded: string[] = [];
  const { base, server } = await start(undefined, { faucet: (a) => { funded.push(a); } });
  const own = await postAs(base, "/api/demo/fund", { address: OWNER.toUpperCase().replace("0X", "0x") }, tokenFor([OWNER]));
  assert.equal(own.status, 200);
  assert.deepEqual(await own.json(), { ok: true, native: "1000000000000000000", usdc: "100000000000" });
  assert.deepEqual(funded, [OWNER]);
  const foreign = await postAs(base, "/api/demo/fund", { address: OTHER }, tokenFor([OWNER]));
  assert.equal(foreign.status, 403);
  assert.deepEqual(await foreign.json(), { error: "not your wallet" });
  assert.equal((await postAs(base, "/api/demo/fund", { address: "nope" }, tokenFor([OWNER]))).status, 400);
  assert.equal((await post(base, "/api/demo/fund", { address: OTHER })).status, 200); // the operator may fund anyone
  assert.equal((await fetch(base + "/api/demo/fund", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: OWNER }) })).status, 401);
  server.close();
});
```

In `start()`, the option type becomes `opts: { login?: boolean; faucet?: (address: string) => void } = {}` and the `AppDeps` literal gains:

```ts
    faucet: opts.faucet ? { fund: async (a) => { opts.faucet!(a); return { native: 10n ** 18n, usdc: 100_000_000_000n }; } } : undefined,
```

- [ ] **Step 4: Run everything and commit**

Run: `npm test && npm run typecheck`
Expected: all pass (previous count plus 6); tsc prints nothing. Then run the treasury demo helper's fund path by hand only if an anvil fork is up (optional; the controller runs the demos after the merge).

```bash
git add app/faucet.ts app/test/faucet.test.ts app/server.ts app/cli.ts demo/lib.ts app/test/server.test.ts
git commit -m "Demo faucet: fund a signed-in wallet on a forked chain through a flag-gated route"
```

---

### Task 4: Dashboard: sign in through Dynamic, deposit with its wallet, scoped vaults

**Branch:** `login-dashboard`

**Files:**
- Create: `app/dashboard/src/dynamic.js`
- Modify: `app/dashboard/index.html`, `app/dashboard/app.js`, `package.json`, `.gitignore`

**Interfaces:**
- Consumes: `GET /api/state` `config` fields from Task 2 (`dynamicEnvironmentId`, `publicRpcUrl`, `chainName`, `nativeCurrency`, `explorer`, `demoFaucet`, plus the existing `chainId`, `factory`, `usdc`, `target`, `publicUrl`); `POST /api/demo/fund` from Task 3; bearer authorization from Task 2.
- Produces: the bundle `app/dashboard/dynamic.bundle.js` exporting `initDynamic(cfg)`, `sendEmailCode(email)`, `verifyEmailCode(code)`, `listWalletProviders()`, `connectWallet(key)`, `currentSession()`, `walletClient()`, `publicClient()`, `signOut()`; `npm run build:dashboard`; `npm run serve` builds first.

- [ ] **Step 1: Dependencies and scripts**

Run: `npm i @dynamic-labs-sdk/client@^1.34.2 @dynamic-labs-sdk/evm@^1.34.2 && npm i -D esbuild` (viem is already a dependency). In `package.json` `scripts` add:

```json
    "build:dashboard": "esbuild app/dashboard/src/dynamic.js --bundle --format=esm --platform=browser --target=es2022 --minify --outfile=app/dashboard/dynamic.bundle.js --log-level=warning",
    "serve": "npm run build:dashboard && node app/cli.ts serve"
```

(`serve` replaces the existing line.) Append to `.gitignore` under `# app`:

```
app/dashboard/dynamic.bundle.js
```

- [ ] **Step 2: The SDK wrapper**

Create `app/dashboard/src/dynamic.js`:

```js
// The only file that touches Dynamic's SDK. Bundled by `npm run build:dashboard`; the dashboard imports the bundle.
import { createDynamicClient, initializeClient, sendEmailOTP, verifyOTP, getAvailableWalletProvidersData, connectAndVerifyWithWalletProvider, getPrimaryWalletAccount, getWalletAccounts, switchActiveNetwork, logout } from "@dynamic-labs-sdk/client";
import { createWaasWalletAccounts, getChainsMissingWaasWalletAccounts } from "@dynamic-labs-sdk/client/waas";
import { addEvmExtension } from "@dynamic-labs-sdk/evm";
import { addWalletConnectEvmExtension } from "@dynamic-labs-sdk/evm/wallet-connect";
import { createWalletClientForWalletAccount, createPublicClientFromNetworkData } from "@dynamic-labs-sdk/evm/viem";

let client = null;
let network = null;
let otp = null;

/** Our chain as Dynamic describes a network; placed first so it is the default for every wallet. */
function networkFor(cfg) {
  return {
    chain: "EVM",
    networkId: String(cfg.chainId),
    name: `evm-${cfg.chainId}`,
    displayName: cfg.chainName,
    iconUrl: cfg.explorer ? `${cfg.explorer}/favicon.ico` : "",
    nativeCurrency: cfg.nativeCurrency,
    rpcUrls: { http: [cfg.publicRpcUrl] },
    blockExplorerUrls: cfg.explorer ? [cfg.explorer] : [],
  };
}

/**
 * Creates and initializes the client for this environment. `cfg` is the dashboard's /api/state config. When
 * `publicRpcUrl` is set, our network replaces Dynamic's own entry for the chain id (a fork needs its own RPC).
 */
export async function initDynamic(cfg) {
  network = cfg.publicRpcUrl ? networkFor(cfg) : null;
  client = createDynamicClient({
    environmentId: cfg.dynamicEnvironmentId,
    autoInitialize: false,
    metadata: { name: "Inferest", universalLink: location.origin },
    transformers: network ? { networksData: (list) => [network, ...list.filter((n) => n.networkId !== network.networkId)] } : undefined,
  });
  addEvmExtension();
  await addWalletConnectEvmExtension().catch(() => {}); // no WalletConnect project id configured: extensions stay browser-only
  await initializeClient();
  return currentSession();
}

export async function sendEmailCode(email) {
  otp = await sendEmailOTP({ email });
}

/** Verifies the code, then makes sure the login has an EVM embedded wallet. */
export async function verifyEmailCode(code) {
  if (!otp) throw new Error("send a code first");
  await verifyOTP({ otpVerification: otp, verificationToken: code });
  otp = null;
  const missing = getChainsMissingWaasWalletAccounts();
  if (missing.includes("EVM")) await createWaasWalletAccounts({ chains: ["EVM"] });
  return currentSession();
}

/** Installed extensions and WalletConnect, EVM only, as buttons: { key, name, icon }. */
export function listWalletProviders() {
  return getAvailableWalletProvidersData()
    .filter((p) => p.chain === "EVM")
    .map((p) => ({ key: p.key, name: p.metadata.displayName, icon: p.metadata.icon }));
}

/** Connects a treasury wallet and signs Dynamic's login message; inside an existing session it links the wallet. */
export async function connectWallet(key) {
  await connectAndVerifyWithWalletProvider({ walletProviderKey: key });
  return currentSession();
}

/** The token's claims, read without verification: the browser only shows them, the server verifies. */
function payloadOf(token) {
  try { return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return {}; }
}

/** What the dashboard needs about the login: the bearer, who, and the wallet that signs. */
export function currentSession() {
  if (!client || !client.token) return null;
  const primary = getPrimaryWalletAccount();
  return {
    token: client.token,
    email: payloadOf(client.token).email ?? null,
    address: primary ? primary.address : null,
    wallets: getWalletAccounts().filter((w) => w.chain === "EVM").map((w) => w.address),
  };
}

/** A viem WalletClient for the primary wallet on our chain. */
export async function walletClient() {
  const primary = getPrimaryWalletAccount();
  if (!primary) throw new Error("no wallet in this session");
  if (network) await switchActiveNetwork({ networkId: network.networkId, walletAccount: primary }).catch(() => {});
  return createWalletClientForWalletAccount({ walletAccount: primary });
}

/** A viem PublicClient for our chain (reads and receipts). */
export function publicClient() {
  if (!network) throw new Error("PUBLIC_RPC_URL is not configured");
  return createPublicClientFromNetworkData({ networkData: network });
}

export async function signOut() {
  await logout();
  otp = null;
}
```

When `publicRpcUrl` is unset, `publicClient()` throws a clear message and the deposit card stays hidden; sign-in and key management still work.

Run: `npm run build:dashboard`
Expected: `app/dashboard/dynamic.bundle.js` exists (about 2 MB) and `git status` does not list it.

- [ ] **Step 3: The page**

Replace the two cards in `app/dashboard/index.html` (the Wallet card and the Admin card) with:

```html
  <div class="card" id="signin">
    <h3>Sign in</h3>
    <div id="loggedout">
      <div><input id="email" type="email" placeholder="finance lead's email" /> <button id="sendcode">Send code</button></div>
      <div id="codebox" style="display:none"><input id="code" placeholder="6-digit code" /> <button id="verify">Verify</button></div>
      <p class="muted">or</p>
      <button id="connectwallet">Connect treasury wallet</button>
      <div id="providers"></div>
    </div>
    <div id="loggedin" style="display:none">
      <p>Signed in as <b id="who"></b> &middot; wallet <code id="address"></code> <button id="signout">Sign out</button></p>
      <p id="nologin" class="muted"></p>
    </div>
    <p id="operatorhint" class="muted" style="display:none">Login is off on this server (no Dynamic environment). Use the operator token below.</p>
  </div>

  <div class="card" id="depositcard" style="display:none">
    <h3>Treasury</h3>
    <button id="fund" style="display:none">Get demo funds</button>
    <div>
      <input id="amount" type="number" value="100000" /> USDC
      <button id="open">Create vault and deposit</button>
      <button id="withdraw">Withdraw everything</button>
    </div>
    <pre id="log"></pre>
  </div>

  <div class="card">
    <h3>Keys</h3>
    <div><input id="keyname" placeholder="key name" value="dev-1" /> weight <input id="weight" type="number" value="1" style="width:60px" />
      <button id="addkey">Create key</button> <a href="/setup" class="muted">setup page for developers</a></div>
    <button id="sync">Sync limits</button><button id="report">Report yield</button>
  </div>
```

and add, just before `<div id="vaults"></div>`:

```html
  <details class="card" id="operator">
    <summary>Operator</summary>
    <input id="token" type="password" placeholder="admin token" /> <span class="muted">used by the keeper's owner and the scripted demos</span>
  </details>
```

Add `details summary { cursor: pointer; }` to the style block.

- [ ] **Step 4: The script**

Replace `app/dashboard/app.js` with:

```js
import { parseAbi, parseEventLogs, parseUnits } from "https://esm.sh/viem@2.56.9";
import { snippets } from "/snippets.js";

const factoryAbi = parseAbi([
  "function createVault(address target, string name, string symbol) returns (address)",
  "event VaultCreated(address indexed customer, address indexed vault, address indexed target)",
]);
const vaultAbi = parseAbi([
  "function acceptManagement()",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const erc20Abi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

const $ = (id) => document.getElementById(id);
const log = (m) => { $("log").textContent += m + "\n"; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const show = (id, on) => { $(id).style.display = on ? "" : "none"; };
let cfg, dyn = null, session = null, myVault;

/** Every API call carries the session's bearer, or the operator token when one is typed in. */
function headers() {
  const h = { "Content-Type": "application/json" };
  if (session) h.Authorization = `Bearer ${session.token}`;
  const token = $("token").value;
  if (token) h["x-admin-token"] = token;
  return h;
}
async function api(path, body) {
  const r = await fetch(path, body === undefined ? { headers: headers() } : { method: "POST", headers: headers(), body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.status);
  return j;
}

async function loadConfig() {
  cfg = (await api("/api/state")).config;
}

/** Loads the Dynamic bundle when the server has a login environment; says so when the bundle was not built. */
async function loadDynamic() {
  if (!cfg.dynamicEnvironmentId) { show("operatorhint", true); return; }
  try {
    dyn = await import("/dynamic.bundle.js");
  } catch {
    $("nologin").textContent = "dashboard bundle missing: run npm run build:dashboard";
    show("loggedin", true); show("loggedout", false);
    return;
  }
  session = await dyn.initDynamic(cfg);
  renderSession();
}

function renderSession() {
  const on = session !== null;
  show("loggedout", !on);
  show("loggedin", on);
  show("depositcard", on && Boolean(cfg.publicRpcUrl));
  show("fund", on && cfg.demoFaucet);
  if (on) {
    $("who").textContent = session.email ?? session.address ?? "";
    $("address").textContent = session.address ?? "(no wallet yet)";
  }
}

$("sendcode").onclick = async () => {
  try { await dyn.sendEmailCode($("email").value.trim()); show("codebox", true); } catch (e) { alert(String(e.message ?? e)); }
};
$("verify").onclick = async () => {
  try { session = await dyn.verifyEmailCode($("code").value.trim()); renderSession(); await render(); } catch (e) { alert(String(e.message ?? e)); }
};
$("connectwallet").onclick = () => {
  $("providers").innerHTML = "";
  for (const p of dyn.listWalletProviders()) {
    const b = document.createElement("button");
    b.textContent = p.name;
    b.onclick = async () => {
      try { session = await dyn.connectWallet(p.key); renderSession(); await render(); } catch (e) { alert(String(e.message ?? e)); }
    };
    $("providers").appendChild(b);
  }
  if (!$("providers").children.length) $("providers").textContent = "no wallet found in this browser";
};
$("signout").onclick = async () => { await dyn.signOut(); session = null; myVault = undefined; renderSession(); await render(); };

$("fund").onclick = async () => {
  try {
    const r = await api("/api/demo/fund", { address: session.address });
    log(`funded ${session.address}: ${r.usdc / 1e6} USDC and gas`);
  } catch (e) { log(String(e)); }
};

async function tx(wallet, pub, address, abi, functionName, args) {
  const hash = await wallet.writeContract({ address, abi, functionName, args });
  await pub.waitForTransactionReceipt({ hash });
  log(`${functionName}: ${hash}`);
  return hash;
}

$("open").onclick = async () => {
  try {
    const wallet = await dyn.walletClient();
    const pub = dyn.publicClient();
    const amount = parseUnits($("amount").value, 6);
    const hash = await wallet.writeContract({ address: cfg.factory, abi: factoryAbi, functionName: "createVault", args: [cfg.target, "Inferest Vault", "infVAULT"] });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    myVault = parseEventLogs({ abi: factoryAbi, logs: receipt.logs })[0].args.vault;
    log(`vault: ${myVault}`);
    await tx(wallet, pub, myVault, vaultAbi, "acceptManagement", []);
    await tx(wallet, pub, cfg.usdc, erc20Abi, "approve", [myVault, amount]);
    await tx(wallet, pub, myVault, vaultAbi, "deposit", [amount, session.address]);
    await api("/api/vaults", { vault: myVault, label: "Treasury" });
    await render();
  } catch (e) { log(String(e.message ?? e)); }
};

$("withdraw").onclick = async () => {
  try {
    const wallet = await dyn.walletClient();
    const pub = dyn.publicClient();
    const vault = myVault ?? (await api("/api/state")).vaults[0]?.vault;
    const shares = await pub.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [session.address] });
    await tx(wallet, pub, vault, vaultAbi, "redeem", [shares, session.address, session.address]);
  } catch (e) { log(String(e.message ?? e)); }
};

$("sync").onclick = async () => { await api("/api/admin/sync", myVault ? { vault: myVault } : {}); await render(); };
$("report").onclick = async () => { await api("/api/admin/report", myVault ? { vault: myVault } : {}); await render(); };
$("addkey").onclick = async () => {
  const vault = myVault ?? (await api("/api/state")).vaults[0]?.vault;
  if (!vault) { alert("no vault yet"); return; }
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
$("copysecret").onclick = () => { const s = $("secret").textContent; if (s) navigator.clipboard.writeText(s); };
$("copysnippet").onclick = () => { if (panelList[panelIndex]) navigator.clipboard.writeText(panelList[panelIndex].text); };
$("closepanel").onclick = () => {
  $("panel").classList.remove("open");
  $("secret").textContent = "";
  $("snippet").textContent = "";
  $("tabs").innerHTML = "";
  panelList = [];
  panelIndex = 0;
};

async function render() {
  const s = await api("/api/state");
  cfg = s.config;
  if (!myVault && s.vaults.length) myVault = s.vaults[0].vault;
  $("vaults").innerHTML = s.vaults.map((v) => `
    <div class="card">
      <h3>${esc(v.label)} <span class="muted">${esc(v.vault)}</span></h3>
      <p>Yield in Splitter: <b>$${v.yieldUsd.toFixed(2)}</b>
        ${v.frozen ? "<b>(frozen: loss pending)</b>" : ""} ${v.settling ? "<b>(settling)</b>" : ""}
        &middot; period ${esc(v.period)}
        &middot; provider backstop: limit $${v.orLimit.toFixed(2)}, used $${v.orUsage.toFixed(2)}${v.hasOpenRouterKey ? "" : " (no provider key yet)"}</p>
      <table><tr><th>Key</th><th>Weight</th><th>Budget</th><th>Models</th><th>Tools</th><th>Left</th><th></th></tr>
      ${v.keys.map((k) => `<tr class="${k.revoked ? "revoked" : ""}"><td>${esc(k.name)}${k.revoked ? " (revoked)" : ""}</td><td>${k.weight}</td>
        <td>$${k.budget.toFixed(2)}</td><td>$${k.modelSpent.toFixed(4)}</td><td>$${k.toolSpent.toFixed(4)}</td><td>$${k.remaining.toFixed(2)}</td>
        <td>${k.revoked ? "" : `<button class="rotate" data-id="${esc(k.id)}" data-name="${esc(k.name)}">Rotate</button>
          <button class="revoke" data-id="${esc(k.id)}" data-name="${esc(k.name)}">Revoke</button>`}</td></tr>`).join("")}
      </table>
      <button class="settle" data-vault="${esc(v.vault)}">Settle now</button>
    </div>`).join("") || `<p class="muted">${session || $("token").value ? "No vault yet." : "Sign in to see your vaults."}</p>`;
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
$("token").addEventListener("change", () => { render().catch((e) => log(String(e))); });

loadConfig().then(loadDynamic).then(render).catch((e) => log(String(e)));
```

Note `$("log")` lives inside the deposit card, which is hidden until a session exists; `log()` still appends, and the operator sees messages once the card shows. Move `<pre id="log"></pre>` out of the deposit card to just above `<div id="vaults">` if you prefer it always visible; either is acceptable, say which in the report.

- [ ] **Step 5: Run the suite, build, and check the page in a browser**

Run: `npm test && npm run typecheck && npm run build:dashboard`
Expected: tests unchanged and green; the bundle builds. Then, with the anvil stack and the server up on the anvil overlay (the controller provides `DYNAMIC_ENVIRONMENT_ID`, `PUBLIC_RPC_URL=http://127.0.0.1:8545` and `DEMO_FAUCET=1` in `.env.anvil`; the implementer does not read `.env`), open `http://localhost:8787/`: sign in with an email code, see the embedded wallet address, press "Get demo funds", deposit 100000, see the vault card appear, create a key, open the setup panel, rotate, revoke, settle; sign out and see the vault list empty; type the operator token and see every vault. If the SDK logs a network validation error in the console, fix the `networkFor` object's fields (the implementer reports the exact message). If the implementer cannot run a browser, say so in the report and the controller performs this check.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore app/dashboard/src/dynamic.js app/dashboard/index.html app/dashboard/app.js
git commit -m "Dashboard: sign in through Dynamic, deposit with its wallet, vaults scoped to the session"
```

---

### Task 5: Docs and the judge walkthrough

**Branch:** `login-docs`

**Files:**
- Create: `docs/07-walkthrough.md`
- Modify: `README.md`, `docs/06-workflow.md`, `deck/outline.md`

- [ ] **Step 1: README**

In the run block, replace the serve line with `npm run serve                             # builds the dashboard bundle, then dashboard, API, chat at /v1, MCP at /mcp` and add after the "Use a key." paragraph:

```
**Sign in.** With `DYNAMIC_ENVIRONMENT_ID` set (a free environment at app.dynamic.xyz with email login and EVM embedded wallets enabled, and the dashboard's origin allowed), a finance lead signs in on the dashboard with an email code or by connecting the treasury wallet, and manages the vault that wallet created. Without it, the operator token is the only credential. `PUBLIC_RPC_URL` is the browser-facing RPC the dashboard's wallet uses; `DEMO_FAUCET=1` adds a "Get demo funds" button on a forked chain. The judge path is in [`docs/07-walkthrough.md`](docs/07-walkthrough.md).
```

In the Decisions table add row 13: `| 13 | Admin identity | **Dynamic login; a vault's admin is the login whose verified wallet created it** | Decided 2026-09-26. Email code with an embedded wallet, or the treasury wallet through Dynamic's connectors; the operator token stays for us. See [`docs/superpowers/specs/2026-09-26-wallet-login-design.md`](docs/superpowers/specs/2026-09-26-wallet-login-design.md) |`. In the docs table add a row for `docs/07-walkthrough.md` ("the dashboard path a judge or a customer follows").

- [ ] **Step 2: Workflow doc**

`docs/06-workflow.md`: in the Actors table, the Customer row's "Can do" gains ", signs in on the dashboard through Dynamic (email code or the treasury wallet) and manages the vault their wallet created". Section 1 (Onboard) ends with: "The customer registers the vault from a dashboard session whose wallet created it, or we register it with the operator token; either way the vault's admin is the wallet that created it." Section 2 (Keys) starts: "In the dashboard the vault's admin (the login whose verified wallet created the vault, or the operator) creates keys ...". In "What the keeper enforces" add the row `| Every mutating API route needs a session that owns the vault or the operator token; state is scoped to the caller | \`resolveCaller\`, \`vaultFor\` in \`app/server.ts\`; \`app/auth.ts\` |` replacing the existing last row's wording about the admin token. In Decisions add `9. **Admin identity:** Dynamic login, verified server-side against the environment's JWKS; ownership is the vault's on-chain creator. Multiple admins and Safe treasuries are later.` `grep -c "$(printf '\xe2\x80\x94')" docs/06-workflow.md` must print 0 (that is the em dash as a byte sequence, so this plan carries none).

- [ ] **Step 3: The walkthrough**

Create `docs/07-walkthrough.md`:

```markdown
# Walkthrough: from an email address to a metered model call

_The path a customer or a reviewer follows on a running Inferest dashboard. Ten minutes, no wallet needed._

1. **Open the dashboard** at the server's public URL. Enter your email under "Sign in" and press "Send code", then the six-digit code and "Verify". Dynamic creates an embedded wallet for you; its address shows under "Signed in as". (A treasury that already lives in MetaMask, on a Ledger or in a custody console presses "Connect treasury wallet" instead.)
2. **Get demo funds** (demo chains only): one click funds your wallet with gas and 100,000 USDC on the fork.
3. **Create vault and deposit**: four transactions signed by your wallet: create the vault, accept management, approve, deposit. The vault card appears; the shares are in your wallet.
4. **Report yield** so the keeper books the yield (on a fork, time can be moved forward first), then **Sync limits**. The card shows yield in the Splitter and the provider backstop.
5. **Create key**: name it, keep weight 1. The panel shows the key once, with snippets for curl, the OpenAI SDKs, the Vercel AI SDK, agent configs and MCP. Copy the curl line and run it; the answer comes back through the proxy.
6. **Watch spend**: the key's Models column moves by the call's cost; Left shrinks by the same amount.
7. **Rotate or revoke** the key from its row; a revoked key gets 401 on its next call.
8. **Settle now**: usage goes to the float, 10% of the leftover to Inferest, the rest returns to your wallet as shares; the period increments.
9. **Sign out**: the vault list empties. Sign in again with the same email (or the same wallet) and it is back.

What you did not do: hand anyone a key, top up a card, or trust the operator with your principal.
```

- [ ] **Step 4: Deck note**

Append to `deck/outline.md` after the keys speaker note: `Login, speaker note for slide 7: the finance lead signs in with an email code or the treasury wallet through Dynamic; the vault's admin is whoever's wallet created it, verified from Dynamic's token on our server. No operator token in the demo path.`

- [ ] **Step 5: Verify and commit**

Run: `npm test && npm run typecheck && grep -c "$(printf '\xe2\x80\x94')" README.md docs/06-workflow.md docs/07-walkthrough.md deck/outline.md`
Expected: tests green, tsc silent, every grep count 0 (grep exits 1 on a zero count; that is fine).

```bash
git add README.md docs/06-workflow.md docs/07-walkthrough.md deck/outline.md
git commit -m "Docs: sign in through Dynamic, the admin rule, and the dashboard walkthrough"
```

---

## After the last task

1. The controller runs the live check with the user's `DYNAMIC_ENVIRONMENT_ID`: anvil fork, server on the anvil overlay with `PUBLIC_RPC_URL` and `DEMO_FAUCET=1`, the walkthrough end to end in a browser, then the scripted treasury and agent demos unchanged (acceptance 1, 4, 5 and the login part of 3).
2. Whole-feature review on the most capable model over the branch range, one fix wave, one scoped re-review.
3. Pre-push secret scan, then push `main`. Update the project memory.
