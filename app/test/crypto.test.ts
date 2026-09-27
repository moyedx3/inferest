import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256, encryptSecret, decryptSecret, newInferestKey, secretBox, sameSecret } from "../crypto.ts";

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

test("sameSecret matches equal strings only, and a missing header never", () => {
  assert.equal(sameSecret("admin-token", "admin-token"), true);
  assert.equal(sameSecret("admin-tokeX", "admin-token"), false);
  assert.equal(sameSecret("admin", "admin-token"), false);
  assert.equal(sameSecret(undefined, "admin-token"), false);
});
