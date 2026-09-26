import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp, sha256, type AppDeps } from "../server.ts";
import { createProxy } from "../proxy.ts";
import { openStore } from "../store.ts";
import { HACKATHON_PARAMS } from "../../engine/ledger.ts";
import type { ToolGateway } from "../tools.ts";
import { createAuth } from "../auth.ts";
import { makeSigner, jwksFetch, claims } from "./testjwt.ts";

const V = "0x00000000000000000000000000000000000000aa";
const ZERO = "0x0000000000000000000000000000000000000000";

const SIGNER = makeSigner();
const NOW = 1_800_000_000_000;
const OWNER = "0x00000000000000000000000000000000000000cc";
const OTHER = "0x00000000000000000000000000000000000000dd";
/** A signed Dynamic token whose eip155 credentials are the given wallets. */
const tokenFor = (wallets: string[], over: Record<string, unknown> = {}) =>
  SIGNER.sign(claims({ verified_credentials: wallets.map((address, i) => ({ id: `vc-${i}`, address, chain: "eip155" })), ...over }));

async function start(customer = "0x00000000000000000000000000000000000000cc", opts: { login?: boolean } = {}) {
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
    proxy: createProxy({
      store, params: HACKATHON_PARAMS, decrypt: (e) => e.replace(/^enc:/, ""), dashboardUrl: "http://localhost", log: () => {},
      fetchFn: (async () => { throw new Error("no upstream in this test"); }) as unknown as typeof fetch,
    }),
    keeper: undefined as unknown as AppDeps["keeper"],
    auth: opts.login === false ? undefined : createAuth({ environmentId: "env-1", fetchFn: jwksFetch(SIGNER).fn, now: () => NOW }),
    logError: () => {},
  };
  d.keeper = { chain: d.chain, store, or: d.or, params: d.params, log: () => {}, sleep: async () => {}, decrypt: d.secrets.decrypt };
  const server = createApp(d);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, server, store, created, d };
}

const post = (base: string, path: string, body: unknown, token = "admin") =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", "x-admin-token": token }, body: JSON.stringify(body) });
const postAs = (base: string, path: string, body: unknown, bearer: string) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
const stateAs = async (base: string, headers: Record<string, string>) => (await fetch(base + "/api/state", { headers })).json() as Promise<any>;

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
  assert.deepEqual(await (await post(base, "/api/admin/sync", {}, "")).json(), { error: "sign in or send the admin token" });
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
  const state = await (await fetch(base + "/api/state", { headers: { "x-admin-token": "admin" } })).text();
  assert.ok(!state.includes("sk-or-v1-company"));
  assert.ok(!state.includes("enc:"));
  assert.equal(JSON.parse(state).vaults[0].hasOpenRouterKey, true);
  server.close();
});

test("state reports a vault without a provider key", async () => {
  const { base, server, store } = await start();
  store.addVault(V, "0x00000000000000000000000000000000000000cc", "T");
  const state: any = await (await fetch(base + "/api/state", { headers: { "x-admin-token": "admin" } })).json();
  assert.equal(state.vaults[0].hasOpenRouterKey, false);
  server.close();
});

test("a provider failure during registration leaves no half-registered vault", async () => {
  const { base, server, store, d } = await start();
  try {
    const createKey = d.or.createKey;
    d.or.createKey = async () => { throw new Error("openrouter down"); };
    const origError = console.error;
    console.error = () => {}; // the route's 500 logs the stack
    try {
      assert.equal((await post(base, "/api/vaults", { vault: V, label: "Treasury" })).status, 500);
    } finally {
      console.error = origError;
    }
    assert.equal(store.vault(V), undefined);
    assert.equal(store.getMeta("settledMonth:" + V), undefined);
    d.or.createKey = createKey;
    assert.equal((await post(base, "/api/vaults", { vault: V, label: "Treasury" })).status, 201);
    assert.deepEqual(store.openRouterKeyFor(V), { hash: "orhash", encryptedSecret: "enc:sk-or-v1-company" });
    assert.equal(store.vault(V)!.label, "Treasury");
  } finally {
    server.close();
  }
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
  const state: any = await (await fetch(base + "/api/state", { headers: { "x-admin-token": "admin" } })).json();
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
  // 1e999 parses to Infinity; it is sent as a raw string since JSON.stringify(Infinity) is null
  const raw = (path: string, body: string) =>
    fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", "x-admin-token": "admin" }, body });
  assert.equal((await raw("/api/keys", `{"vault":"${V}","name":"x","weight":1e999}`)).status, 400);
  const { id } = await (await post(base, "/api/keys", { vault: V, name: "y", weight: 1 })).json();
  assert.equal((await raw(`/api/keys/${id}/weight`, `{"weight":1e999}`)).status, 400);
  assert.equal((await raw(`/api/keys/${id}/weight`, `{"weight":-1}`)).status, 400);
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
  const state: any = await (await fetch(base + "/api/state", { headers: { "x-admin-token": "admin" } })).json();
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
  const state: any = await (await fetch(base + "/api/state", { headers: { "x-admin-token": "admin" } })).json();
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

test("serves the setup page and exposes the public URL in state", async () => {
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
