import { test } from "node:test";
import assert from "node:assert/strict";
import { openRouter } from "../openrouter.ts";

function fakeFetch(responses: unknown[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("createKey posts name and limit and returns the key once", async () => {
  const f = fakeFetch([{ data: { hash: "h1", usage: 0, limit: 0 }, key: "sk-or-v1-abc" }]);
  const or = openRouter("mgmt", f.fn);
  assert.deepEqual(await or.createKey("inferest:dev-1", 0), { key: "sk-or-v1-abc", hash: "h1" });
  assert.equal(f.calls[0].url, "https://openrouter.ai/api/v1/keys");
  assert.equal(f.calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { name: "inferest:dev-1", limit: 0, include_byok_in_limit: true });
  assert.equal((f.calls[0].init.headers as Record<string, string>).Authorization, "Bearer mgmt");
});

test("getKey maps usage and limit", async () => {
  const f = fakeFetch([{ data: { hash: "h1", usage: 25.5, limit: 100, disabled: false } }]);
  assert.deepEqual(await openRouter("m", f.fn).getKey("h1"), { hash: "h1", usage: 25.5, limit: 100, disabled: false });
});

test("setLimit patches the key", async () => {
  const f = fakeFetch([{ data: {} }]);
  await openRouter("m", f.fn).setLimit("h1", 12.34);
  assert.equal(f.calls[0].url, "https://openrouter.ai/api/v1/keys/h1");
  assert.equal(f.calls[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { limit: 12.34 });
});

test("errors carry the status", async () => {
  const fn = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(openRouter("m", fn).getKey("h1"), /401/);
});

test("deleteKey deletes the key", async () => {
  const f = fakeFetch([{ data: {} }]);
  await openRouter("m", f.fn).deleteKey("h1");
  assert.equal(f.calls[0].url, "https://openrouter.ai/api/v1/keys/h1");
  assert.equal(f.calls[0].init.method, "DELETE");
});

test("getGeneration reads the cost with the company key as bearer", async () => {
  const f = fakeFetch([{ data: { id: "gen-1", model: "openai/gpt-4o-mini", total_cost: 0.00123, tokens_prompt: 10 } }]);
  const g = await openRouter("m", f.fn).getGeneration("gen-1", "sk-or-v1-company");
  assert.deepEqual(g, { id: "gen-1", model: "openai/gpt-4o-mini", totalCost: 0.00123 });
  assert.equal(f.calls[0].url, "https://openrouter.ai/api/v1/generation?id=gen-1");
  assert.equal(f.calls[0].init.method, "GET");
  assert.equal((f.calls[0].init.headers as Record<string, string>).Authorization, "Bearer sk-or-v1-company");
});

test("getGeneration returns undefined when OpenRouter does not know the id yet", async () => {
  const fn = (async () => new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 })) as unknown as typeof fetch;
  assert.equal(await openRouter("m", fn).getGeneration("gen-x", "k"), undefined);
});

test("getGeneration throws on other failures", async () => {
  const fn = (async () => new Response("down", { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(openRouter("m", fn).getGeneration("gen-x", "k"), /500/);
});

test("getGeneration treats a missing cost as not ready", async () => {
  const f = fakeFetch([{ data: { id: "gen-1", model: "m" } }]);
  assert.equal(await openRouter("m", f.fn).getGeneration("gen-1", "k"), undefined);
});
