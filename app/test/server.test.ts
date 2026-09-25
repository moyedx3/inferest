import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp, sha256, type AppDeps } from "../server.ts";
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
      createKey: async (name) => { created.push(name); return { key: "sk-or-v1-secret", hash: "h1" }; },
      getKey: async (h) => ({ hash: h, usage: 0, limit: 0, disabled: false }),
      setLimit: async () => {},
    },
    chain: {
      yieldOf: async () => 0n, lossPending: async () => false,
      report: async () => "0x", settle: async () => "0x",
      customerOf: async (v) => (v === V ? customer : ZERO),
    },
    gateway: { search: async () => [], details: async () => ({}), run: async () => ({}) } as unknown as ToolGateway,
    params: HACKATHON_PARAMS,
    adminToken: "admin",
    publicConfig: { chainId: 42161 },
    keeper: undefined as unknown as AppDeps["keeper"],
  };
  d.keeper = { chain: d.chain, store, or: d.or, params: d.params, log: () => {} };
  const server = createApp(d);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, server, store, created, d };
}

const post = (base: string, path: string, body: unknown, token = "admin") =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", "x-admin-token": token }, body: JSON.stringify(body) });

test("mutating routes require the admin token", async () => {
  const { base, server } = await start();
  assert.equal((await post(base, "/api/vaults", { vault: V }, "wrong")).status, 401);
  assert.equal((await post(base, "/api/admin/sync", {}, "")).status, 401);
  server.close();
});

test("POST /api/vaults rejects a vault the factory does not know", async () => {
  const { base, server } = await start();
  const r = await post(base, "/api/vaults", { vault: "0x00000000000000000000000000000000000000bb" });
  assert.equal(r.status, 400);
  server.close();
});

test("registering a vault and a key returns the secret once and stores only its hash", async () => {
  const { base, server, store, created } = await start();
  assert.equal((await post(base, "/api/vaults", { vault: V, label: "Treasury" })).status, 201);
  const r = await post(base, "/api/keys", { vault: V, name: "dev-1", weight: 1 });
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { key: "sk-or-v1-secret", hash: "h1" });
  assert.equal(created[0], "inferest:dev-1");
  assert.equal(store.keyBySecret(sha256("sk-or-v1-secret"))!.hash, "h1");
  const state: any = await (await fetch(base + "/api/state")).json();
  assert.equal(state.vaults[0].keys[0].name, "dev-1");
  assert.ok(!JSON.stringify(state).includes("sk-or-v1-secret"));
  server.close();
});

test("negative weights are rejected", async () => {
  const { base, server } = await start();
  await post(base, "/api/vaults", { vault: V });
  assert.equal((await post(base, "/api/keys", { vault: V, name: "x", weight: -1 })).status, 400);
  server.close();
});

test("MCP rejects an unknown key", async () => {
  const { base, server } = await start();
  const r = await fetch(base + "/mcp", {
    method: "POST",
    headers: { Authorization: "Bearer nope", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(r.status, 401);
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
  d.chain.settle = async () => { throw new Error("boom https://secret-rpc.example/abc?key=1"); };
  const r = await post(base, "/api/admin/settle", { vault: V });
  assert.equal(r.status, 500);
  const body: any = await r.json();
  assert.ok(!body.error.includes("secret-rpc"));
  assert.ok(body.error.includes("[url]"));
  assert.equal(store.listSettlements().length, 0);
  server.close();
});

test("weight change on an unknown key returns 404", async () => {
  const { base, server } = await start();
  const r = await post(base, "/api/keys/deadbeef/weight", { weight: 2 });
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: "unknown key" });
  server.close();
});

test("weight change on a known key updates it", async () => {
  const { base, server, store } = await start();
  await post(base, "/api/vaults", { vault: V });
  await post(base, "/api/keys", { vault: V, name: "dev-1", weight: 1 });
  const r = await post(base, "/api/keys/h1/weight", { weight: 2 });
  assert.equal(r.status, 200);
  assert.equal(store.keyByHash("h1")!.weight, 2);
  server.close();
});
