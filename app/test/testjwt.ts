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
