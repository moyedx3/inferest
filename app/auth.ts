import { createPublicKey, createVerify, type KeyObject } from "node:crypto";

/**
 * What a verified Dynamic login tells us: who, and which EVM wallets they have proven. `walletsError` says why the
 * wallets could not be looked up, when the token was valid but Dynamic's user endpoint did not answer.
 */
export type Session = { userId: string; email?: string; wallets: string[]; walletsError?: string };

export type AuthDeps = {
  environmentId: string;
  fetchFn?: typeof fetch;
  /** Milliseconds since the epoch (default Date.now). */
  now?: () => number;
  /** Overrides the JWKS URL (tests). */
  jwksUrl?: string;
  /** How long a JWKS fetch may take before it is abandoned (default DEFAULT_JWKS_TIMEOUT_MS). */
  jwksTimeoutMs?: number;
  /** Overrides the SDK users URL the wallets are looked up from (default usersUrlFor(environmentId)). */
  usersUrl?: string;
  /** How long a wallet lookup may take before it is abandoned (default DEFAULT_LOOKUP_TIMEOUT_MS). */
  lookupTimeoutMs?: number;
  /** How long a looked-up wallet list is reused for the same user and credential hash (default DEFAULT_WALLET_CACHE_MS). */
  walletCacheMs?: number;
};

export type Auth = { verify(token: string): Promise<Session> };

export const jwksUrlFor = (environmentId: string): string =>
  `https://app.dynamicauth.com/api/v0/sdk/${encodeURIComponent(environmentId)}/.well-known/jwks`;

/** Dynamic's SDK user endpoint, which answers with the bearer's verified credentials. */
export const usersUrlFor = (environmentId: string): string =>
  `https://app.dynamicauth.com/api/v0/sdk/${encodeURIComponent(environmentId)}/users`;

const REFETCH_MIN_MS = 60_000;
export const DEFAULT_JWKS_TIMEOUT_MS = 10_000;
export const DEFAULT_LOOKUP_TIMEOUT_MS = 10_000;
export const DEFAULT_WALLET_CACHE_MS = 10 * 60_000;
const WALLET_CACHE_MAX = 1000;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i;
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
 * and refetched at most once a minute when a token names a key we do not hold. Concurrent callers that arrive
 * before the first fetch resolves share it, and a fetch that fails (or returns no usable keys) is itself
 * throttled to once a minute rather than attempted on every request. A fetch that hangs is abandoned after
 * `jwksTimeoutMs`, and a refetch that yields no usable keys keeps the keys already held. Only the signature, the expiry and the
 * environment are checked; authorization is the caller's job.
 *
 * Wallets come from the token's `verified_credentials` claim when it has entries. Current Dynamic environments issue
 * tokens with only credential hashes (`verifiedCredentialsHashes`), so otherwise the wallets are looked up from the
 * SDK users endpoint with the same bearer, cached per user and blockchain-credential hash for `walletCacheMs`. A
 * failed lookup falls back to the user's most recent cached answer, else to no wallets with `walletsError` set; it
 * never fails the verification, since the token itself was valid.
 */
export function createAuth(d: AuthDeps): Auth {
  const fetchFn = d.fetchFn ?? fetch;
  const now = d.now ?? Date.now;
  const url = d.jwksUrl ?? jwksUrlFor(d.environmentId);
  const timeout = d.jwksTimeoutMs ?? DEFAULT_JWKS_TIMEOUT_MS;
  let keys = new Map<string, KeyObject>();
  let fetchedAt = 0;
  let attempted = false;
  let lastFetchError: Error | null = null;
  let inFlight: Promise<void> | null = null;
  const usersUrl = d.usersUrl ?? usersUrlFor(d.environmentId);
  const lookupTimeout = d.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
  const walletCacheMs = d.walletCacheMs ?? DEFAULT_WALLET_CACHE_MS;
  /** `${sub}:${blockchain hash}` to the wallets looked up for it; insertion order is age order, so the first entry is the oldest. */
  const walletCache = new Map<string, { sub: string; wallets: string[]; at: number }>();

  async function fetchJwks(): Promise<void> {
    try {
      let res: Response;
      try {
        res = await fetchFn(url, { signal: AbortSignal.timeout(timeout) });
      } catch {
        throw invalid("jwks unavailable");
      }
      if (!res.ok) throw invalid("jwks unavailable");
      const body: any = await res.json().catch(() => null);
      const next = new Map<string, KeyObject>();
      for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
        if (jwk?.kty !== "RSA" || typeof jwk.kid !== "string") continue;
        try {
          next.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
        } catch {
          // an unusable key is skipped; a token naming it fails as unknown
        }
      }
      if (next.size > 0) keys = next; // an empty answer never wipes keys we hold
      lastFetchError = null;
    } catch (err) {
      lastFetchError = err instanceof Error ? err : invalid("jwks unavailable");
      throw err;
    } finally {
      attempted = true;
      fetchedAt = now();
    }
  }

  /** Runs at most one JWKS fetch at a time; concurrent callers await the same in-flight attempt. */
  function refresh(): Promise<void> {
    if (inFlight) return inFlight;
    const attempt = fetchJwks().finally(() => {
      inFlight = null;
    });
    inFlight = attempt;
    return attempt;
  }

  async function keyFor(kid: string): Promise<KeyObject> {
    const stale = !attempted || now() - fetchedAt >= REFETCH_MIN_MS;
    if (!keys.has(kid) && stale) await refresh();
    const key = keys.get(kid);
    if (!key) throw lastFetchError ?? invalid("unknown key");
    return key;
  }

  function remember(key: string, sub: string, wallets: string[]): void {
    walletCache.delete(key); // re-inserted at the end, so it is the newest
    if (walletCache.size >= WALLET_CACHE_MAX) walletCache.delete(walletCache.keys().next().value!);
    walletCache.set(key, { sub, wallets, at: now() });
  }

  /** The user's most recently stored wallets under any credential hash, if any. */
  function lastKnown(sub: string): string[] | undefined {
    let found: { wallets: string[]; at: number } | undefined;
    for (const e of walletCache.values()) if (e.sub === sub && (!found || e.at >= found.at)) found = e;
    return found?.wallets;
  }

  async function lookUpWallets(token: string, sub: string, hash: string): Promise<{ wallets: string[]; error?: string }> {
    const key = `${sub}:${hash}`;
    const hit = walletCache.get(key);
    if (hit && now() - hit.at < walletCacheMs) return { wallets: hit.wallets };
    try {
      let res: Response;
      try {
        res = await fetchFn(usersUrl, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(lookupTimeout) });
      } catch (e) {
        throw new Error(`user lookup failed: ${e instanceof Error ? `${e.name}: ${e.message}` : "network error"}`);
      }
      if (res.status !== 200) throw new Error(`user lookup answered ${res.status}`);
      let body: any;
      try {
        body = await res.json();
      } catch {
        throw new Error("user lookup answered with a body that is not JSON");
      }
      const wallets = new Set<string>();
      for (const vc of Array.isArray(body?.verifiedCredentials) ? body.verifiedCredentials : []) {
        if (vc?.format === "blockchain" && vc.chain === "eip155" && typeof vc.address === "string" && EVM_ADDRESS.test(vc.address)) wallets.add(vc.address.toLowerCase());
      }
      const list = [...wallets];
      remember(key, sub, list);
      return { wallets: list };
    } catch (e) {
      const known = lastKnown(sub);
      if (known) return { wallets: known };
      return { wallets: [], error: (e as Error).message };
    }
  }

  return {
    async verify(token) {
      if (typeof token !== "string" || token.length > 8192) throw invalid("malformed");
      const parts = token.split(".");
      if (parts.length !== 3 || parts.some((p) => p.length === 0)) throw invalid("malformed");
      const header = decodePart(parts[0]);
      const payload = decodePart(parts[1]);
      if (payload === null || typeof payload !== "object") throw invalid("malformed");
      if (header?.alg !== "RS256") throw invalid("unsupported algorithm");
      if (typeof header.kid !== "string") throw invalid("malformed");
      const key = await keyFor(header.kid);
      const ok = createVerify("RSA-SHA256").update(`${parts[0]}.${parts[1]}`).verify(key, Buffer.from(parts[2], "base64url"));
      if (!ok) throw invalid("bad signature");
      if (typeof payload.exp !== "number" || payload.exp * 1000 <= now()) throw invalid("expired");
      if (payload.environment_id !== d.environmentId) throw invalid("wrong environment");
      if (typeof payload.sub !== "string" || !payload.sub) throw invalid("malformed");
      const session: Session = { userId: payload.sub, wallets: [] };
      if (typeof payload.email === "string" && payload.email) session.email = payload.email;
      const claimed = Array.isArray(payload.verified_credentials) ? payload.verified_credentials : [];
      if (claimed.length > 0) {
        const wallets = new Set<string>();
        for (const vc of claimed) {
          if (vc?.chain === "eip155" && typeof vc.address === "string" && EVM_ADDRESS.test(vc.address)) wallets.add(vc.address.toLowerCase());
        }
        session.wallets = [...wallets];
      } else {
        const hash = payload.verifiedCredentialsHashes?.blockchain;
        const found = await lookUpWallets(token, payload.sub, typeof hash === "string" && hash ? hash : "none");
        session.wallets = found.wallets;
        if (found.error) session.walletsError = found.error;
      }
      return session;
    },
  };
}
