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

/** What the fake users endpoint answers: a JSON body with a status, or a request that hangs until its signal aborts. */
export type UsersReply = { body?: unknown; status?: number; hang?: boolean };

/**
 * A fetch that routes by URL like Dynamic does: the environment's JWKS URL serves the signers' keys, and its sibling
 * users URL answers with `users.reply` (mutable, so a test can change it between calls), recording each bearer it saw.
 */
export function dynamicFetch(signers: Signer[], reply: UsersReply = { body: { verifiedCredentials: [] } }, environmentId = "env-1") {
  const base = `https://app.dynamicauth.com/api/v0/sdk/${encodeURIComponent(environmentId)}`;
  const calls = { jwks: 0, users: 0, bearers: [] as string[] };
  const users = { reply };
  const fn = (async (url: string, init: RequestInit = {}) => {
    if (url === `${base}/.well-known/jwks`) {
      calls.jwks++;
      return new Response(JSON.stringify({ keys: signers.map((s) => s.jwk) }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === `${base}/users`) {
      calls.users++;
      calls.bearers.push(String(new Headers(init.headers).get("authorization") ?? ""));
      const r = users.reply;
      if (r.hang) {
        return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
      }
      return new Response(JSON.stringify(r.body ?? null), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fn, calls, users };
}

/** The claims a current Dynamic environment issues: credential hashes only, no `verified_credentials` list. */
export function hashedClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const { verified_credentials: _dropped, ...rest } = claims();
  return { ...rest, scope: "user:basic", verifiedCredentialsHashes: { blockchain: "aa", email: "bb" }, ...over };
}
