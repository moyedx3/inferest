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
