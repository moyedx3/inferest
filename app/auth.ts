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
  /** How long a JWKS fetch may take before it is abandoned (default DEFAULT_JWKS_TIMEOUT_MS). */
  jwksTimeoutMs?: number;
};

export type Auth = { verify(token: string): Promise<Session> };

export const jwksUrlFor = (environmentId: string): string =>
  `https://app.dynamicauth.com/api/v0/sdk/${encodeURIComponent(environmentId)}/.well-known/jwks`;

const REFETCH_MIN_MS = 60_000;
export const DEFAULT_JWKS_TIMEOUT_MS = 10_000;
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
