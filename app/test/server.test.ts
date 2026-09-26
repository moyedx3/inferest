import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp, sha256, type AppDeps } from "../server.ts";
import { createProxy } from "../proxy.ts";
import { openStore } from "../store.ts";
import { HACKATHON_PARAMS } from "../../engine/ledger.ts";
import type { ToolGateway } from "../tools.ts";

const V = "0x00000000000000000000000000000000000000aa";
const ZERO = "0x0000000000000000000000000000000000000000";

async function start(customer = "0x00000000000000000000000000000000000000cc") {
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
  const state = await (await fetch(base + "/api/state")).text();
  assert.ok(!state.includes("sk-or-v1-company"));
  assert.ok(!state.includes("enc:"));
  assert.equal(JSON.parse(state).vaults[0].hasOpenRouterKey, true);
  server.close();
});

test("state reports a vault without a provider key", async () => {
  const { base, server, store } = await start();
  store.addVault(V, "0x00000000000000000000000000000000000000cc", "T");
  const state: any = await (await fetch(base + "/api/state")).json();
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
  const state: any = await (await fetch(base + "/api/state")).json();
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
  const state: any = await (await fetch(base + "/api/state")).json();
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
  const state: any = await (await fetch(base + "/api/state")).json();
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
