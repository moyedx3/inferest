import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuth, jwksUrlFor } from "../auth.ts";
import { makeSigner, jwksFetch, claims } from "./testjwt.ts";

const NOW = 1_800_000_000_000; // ms; this is iat (1_800_000_000 s) converted to ms, not 60 s after it
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

test("a failed jwks fetch is not retried within a minute", async () => {
  const s = makeSigner();
  let count = 0;
  let t = NOW;
  const fn = (async () => {
    count++;
    return new Response("down", { status: 503 });
  }) as unknown as typeof fetch;
  const a = auth(fn, { now: () => t });
  await assert.rejects(a.verify(s.sign(claims())), /invalid token: jwks unavailable/);
  await assert.rejects(a.verify(s.sign(claims())), /invalid token: jwks unavailable/);
  assert.equal(count, 1); // the outage itself is throttled, not retried on every request
  t += 61_000;
  await assert.rejects(a.verify(s.sign(claims())), /invalid token: jwks unavailable/);
  assert.equal(count, 2);
});

test("concurrent first logins share one jwks fetch", async () => {
  const s = makeSigner();
  const { fn, calls } = jwksFetch(s);
  const a = auth(fn);
  const sessions = await Promise.all([
    a.verify(s.sign(claims({ sub: "user-1" }))),
    a.verify(s.sign(claims({ sub: "user-2" }))),
    a.verify(s.sign(claims({ sub: "user-3" }))),
  ]);
  assert.deepEqual(sessions.map((session) => session.userId), ["user-1", "user-2", "user-3"]);
  assert.equal(calls.count, 1);
});

test("a jwks body of null yields no usable keys; the fetch itself succeeded, so the token's kid is unknown", async () => {
  const s = makeSigner();
  const fn = (async () => new Response("null", { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(auth(fn).verify(s.sign(claims())), /invalid token: unknown key/);
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
  // exp equal to the current second is refused too: the comparison is <=, not <
  await assert.rejects(auth(fn).verify(s.sign(claims({ exp: 1_800_000_000 }))), /invalid token: expired/);
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

test("a validly signed payload that is not an object is refused as malformed", async () => {
  const s = makeSigner();
  const { fn } = jwksFetch(s);
  // testjwt's sign() types payload as Record<string, unknown>, but it JSON-serializes whatever it is given.
  await assert.rejects(auth(fn).verify(s.sign(null as any)), /invalid token: malformed/);
});

test("a hung jwks fetch is cut off", async () => {
  const s = makeSigner();
  let aborted = false;
  const fn = ((_url: string, init: RequestInit) =>
    new Promise((_, reject) => init.signal!.addEventListener("abort", () => { aborted = true; reject(init.signal!.reason); }))) as unknown as typeof fetch;
  const started = Date.now();
  await assert.rejects(auth(fn, { jwksTimeoutMs: 50 }).verify(s.sign(claims())), /invalid token: jwks unavailable/);
  assert.ok(aborted, "the fetch was cut off by its signal");
  assert.ok(Date.now() - started < 1000);
});

test("a refetch that returns no keys keeps the cached ones", async () => {
  const s1 = makeSigner("k1");
  const s2 = makeSigner("k2");
  let body: unknown = { keys: [s1.jwk] };
  let count = 0;
  let t = NOW;
  const fn = (async () => { count++; return new Response(JSON.stringify(body), { status: 200 }); }) as unknown as typeof fetch;
  const a = auth(fn, { now: () => t });
  await a.verify(s1.sign(claims()));
  body = { keys: [] };
  t += 61_000;
  await assert.rejects(a.verify(s2.sign(claims())), /invalid token: unknown key/); // the empty refetch happens here
  assert.equal(count, 2);
  const session = await a.verify(s1.sign(claims()));
  assert.equal(session.userId, "user-1");
});
