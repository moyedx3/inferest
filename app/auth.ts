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
