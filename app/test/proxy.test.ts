import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp, sha256, type AppDeps } from "../server.ts";
import { createProxy, MAX_BODY_BYTES } from "../proxy.ts";
import { openStore } from "../store.ts";
import { HACKATHON_PARAMS } from "../../engine/ledger.ts";
import type { ToolGateway } from "../tools.ts";
import { resolvePendingModelCalls } from "../keeper.ts";

const V = "0x00000000000000000000000000000000000000aa";
const SECRET = "sk-inf-test-key";
const COMPANY = "sk-or-v1-company";

type Upstream = (url: string, init: RequestInit) => Response | Promise<Response>;

/** A real server whose proxy talks to a scripted upstream instead of OpenRouter. Yield defaults to $100. */
async function start(upstream: Upstream, opts: { yieldUsd?: number; frozen?: boolean } = {}) {
  const store = openStore(":memory:");
  store.addVault(V, "0x00000000000000000000000000000000000000cc", "T");
  store.setVaultOpenRouterKey(V, "orhash", `enc:${COMPANY}`);
  store.setVaultState(V, { yieldUsd: opts.yieldUsd ?? 100, frozen: opts.frozen ?? false });
  store.addKey({ id: "k1", vault: V, name: "dev-1", weight: 1, secretSha256: sha256(SECRET) });
  const calls: { url: string; init: RequestInit }[] = [];
  const logs: string[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return upstream(url, init);
  }) as unknown as typeof fetch;
  const decrypt = (e: string) => { if (!e.startsWith("enc:")) throw new Error("bad secret"); return e.slice(4); };
  const proxy = createProxy({
    store, params: HACKATHON_PARAMS, decrypt, fetchFn, upstream: "https://up.test/api/v1/", dashboardUrl: "https://dash.test", log: (m) => logs.push(m),
  });
  const d: AppDeps = {
    store,
    or: {
      createKey: async () => ({ key: "k", hash: "h" }), getKey: async (h) => ({ hash: h, usage: 0, limit: 0, disabled: false }),
      setLimit: async () => {}, deleteKey: async () => {}, getGeneration: async () => undefined,
    },
    chain: {
      yieldOf: async () => 0n, lossPending: async () => false, report: async () => "0x", settle: async () => "0x",
      totalAssets: async () => 0n, prepareSettle: async () => ({ hash: "0x", send: async () => {} }), sendSettle: async () => "0x",
      settleStatus: async () => "success" as const, transactionKnown: async () => true, customerOf: async () => "0x",
    },
    gateway: {} as unknown as ToolGateway,
    params: HACKATHON_PARAMS, adminToken: "admin", publicConfig: {},
    secrets: { encrypt: (p) => `enc:${p}`, decrypt },
    proxy,
    keeper: undefined as unknown as AppDeps["keeper"],
  };
  d.keeper = { chain: d.chain, store, or: d.or, params: HACKATHON_PARAMS, log: () => {}, decrypt, drain: proxy.drain };
  const server = createApp(d);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, server, store, calls, logs, proxy, d };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-openrouter-trace": "leak", ...headers } });

const completion = (id: string, cost: number) =>
  json({ id, model: "openai/gpt-4o-mini", choices: [{ message: { role: "assistant", content: "hi" } }], usage: { prompt_tokens: 5, completion_tokens: 2, cost } });

const chat = (base: string, body: unknown, key = SECRET) =>
  fetch(base + "/v1/chat/completions", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const MSG = { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }] };

test("a request on a fresh key is answered through the proxy and metered in the same request", async () => {
  const { base, server, store, calls } = await start(() => completion("gen-1", 0.0123));
  const r = await chat(base, MSG);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/json");
  assert.equal(r.headers.get("x-openrouter-trace"), null); // provider headers are dropped
  const body: any = await r.json();
  assert.equal(body.choices[0].message.content, "hi");
  assert.equal(body.usage.cost, 0.0123);
  const call = store.modelCall("gen-1")!;
  assert.deepEqual([call.keyId, call.model, call.costUsd, call.status], ["k1", "openai/gpt-4o-mini", 0.0123, "recorded"]);
  assert.equal(store.keyById("k1")!.modelSpent, 0.0123);
  assert.equal(calls[0].url, "https://up.test/api/v1/chat/completions");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${COMPANY}`);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { ...MSG, usage: { include: true } });
  server.close();
});

test("usage.include is forced on even when the client sets it false", async () => {
  const { base, server, calls } = await start(() => completion("gen-2", 0));
  await chat(base, { ...MSG, usage: { include: false, other: 1 } });
  assert.deepEqual(JSON.parse(String(calls[0].init.body)).usage, { other: 1, include: true });
  await chat(base, { ...MSG, usage: [1] });
  assert.deepEqual(JSON.parse(String(calls[1].init.body)).usage, { include: true });
  server.close();
});

test("missing, unknown and revoked keys get 401 in the OpenAI error shape", async () => {
  const { base, server, store, calls } = await start(() => completion("g", 0));
  for (const key of ["", "nope"]) {
    const r = await chat(base, MSG, key);
    assert.equal(r.status, 401);
    const e: any = await r.json();
    assert.deepEqual([e.error.type, e.error.code, typeof e.error.message], ["authentication_error", 401, "string"]);
  }
  store.revokeKey("k1");
  assert.equal((await chat(base, MSG)).status, 401);
  assert.equal((await fetch(base + "/v1/models")).status, 401);
  assert.equal(calls.length, 0);
  server.close();
});

test("a key with no budget left gets 402 with the remaining amount and the dashboard URL, before forwarding", async () => {
  const { base, server, store, calls } = await start(() => completion("g", 0), { yieldUsd: 1 });
  store.recordModelCall({ keyId: "k1", model: "m", costUsd: 1, generationId: "earlier" });
  const r = await chat(base, MSG);
  assert.equal(r.status, 402);
  const e: any = await r.json();
  assert.equal(e.error.type, "insufficient_quota");
  assert.equal(e.error.code, 402);
  assert.match(e.error.message, /\$0\.00/);
  assert.match(e.error.message, /https:\/\/dash\.test/);
  assert.equal(calls.length, 0);
  server.close();
});

test("a frozen vault refuses every key with 402", async () => {
  const { base, server, calls } = await start(() => completion("g", 0), { frozen: true });
  const r = await chat(base, MSG);
  assert.equal(r.status, 402);
  const e: any = await r.json();
  assert.equal(e.error.type, "insufficient_quota");
  assert.match(e.error.message, /frozen/);
  assert.equal(calls.length, 0);
  server.close();
});

test("a settling vault answers 503 with Retry-After", async () => {
  const { base, server, store, calls } = await start(() => completion("g", 0));
  store.setSettling(V, true);
  const r = await chat(base, MSG);
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("retry-after"), "15");
  assert.equal(((await r.json()) as any).error.type, "server_error");
  assert.equal(calls.length, 0);
  server.close();
});

test("a vault with a pending settlement answers 503", async () => {
  const { base, server, store, calls } = await start(() => completion("g", 0));
  store.setPendingSettlement(V, { usageMicro: 1n, baselines: [], tx: "0xtx" });
  const r = await chat(base, MSG);
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("retry-after"), "15");
  assert.equal(calls.length, 0);
  server.close();
});

test("two requests that both pass the check both meter, and the third is refused", async () => {
  // $1 of yield, $0.60 per call: both concurrent calls pass the check (it happens before the call), the third finds nothing left
  let n = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { base, server, store } = await start(async () => {
    const id = `gen-${++n}`;
    if (n === 2) release();
    await gate; // neither answers until both are in flight
    return completion(id, 0.6);
  }, { yieldUsd: 1 });
  const [a, b] = await Promise.all([chat(base, MSG), chat(base, MSG)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal(store.keyById("k1")!.modelSpent, 1.2);
  assert.equal((await chat(base, MSG)).status, 402);
  server.close();
});

test("an upstream error is relayed with its status and body", async () => {
  const { base, server, store } = await start(() => json({ error: { message: "bad model", code: 400 } }, 400));
  const r = await chat(base, MSG);
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: { message: "bad model", code: 400 } });
  assert.equal(store.listPendingModelCalls().length, 0);
  server.close();
});

test("the provider's key limit becomes our 402", async () => {
  const { base, server } = await start(() => json({ error: { message: "Key limit exceeded", code: 403 } }, 403));
  const r = await chat(base, MSG);
  assert.equal(r.status, 402);
  const e: any = await r.json();
  assert.equal(e.error.type, "insufficient_quota");
  assert.match(e.error.message, /https:\/\/dash\.test/);
  server.close();
});

test("a network failure to the provider is a 502 that names no host", async () => {
  const { base, server } = await start(() => { throw new TypeError("fetch failed: up.test refused"); });
  const r = await chat(base, MSG);
  assert.equal(r.status, 502);
  const e: any = await r.json();
  assert.equal(e.error.type, "upstream_error");
  assert.ok(!e.error.message.includes("up.test"));
  server.close();
});

test("a non-JSON body is refused with 400 before forwarding", async () => {
  const { base, server, calls } = await start(() => completion("g", 0));
  for (const body of ["{not json", "[1,2]", "\"str\""]) {
    const r = await chat(base, body);
    assert.equal(r.status, 400, body);
    assert.equal(((await r.json()) as any).error.type, "invalid_request_error");
  }
  assert.equal(calls.length, 0);
  server.close();
});

test("a body over 4 MB is refused with 413 before forwarding", async () => {
  const { base, server, calls } = await start(() => completion("g", 0));
  const big = JSON.stringify({ ...MSG, messages: [{ role: "user", content: "x".repeat(MAX_BODY_BYTES) }] });
  const r = await chat(base, big);
  assert.equal(r.status, 413);
  assert.equal(((await r.json()) as any).error.type, "invalid_request_error");
  // the same without a content-length header (a chunked upload)
  const r2 = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } }),
    duplex: "half",
  } as RequestInit);
  assert.equal(r2.status, 413);
  assert.equal(calls.length, 0);
  server.close();
});

test("a response without a cost leaves a pending row", async () => {
  const { base, server, store } = await start(() => json({ id: "gen-nc", model: "m", choices: [], usage: { prompt_tokens: 1 } }));
  assert.equal((await chat(base, MSG)).status, 200);
  assert.equal(store.modelCall("gen-nc")!.status, "pending");
  assert.equal(store.keyById("k1")!.modelSpent, 0);
  assert.equal(store.listPendingModelCalls().length, 1);
  server.close();
});

test("GET /v1/models is relayed and provider headers are dropped", async () => {
  const { base, server, calls } = await start(() => json({ data: [{ id: "openai/gpt-4o-mini" }] }, 200, { "cache-control": "max-age=60" }));
  const r = await fetch(base + "/v1/models", { headers: { Authorization: `Bearer ${SECRET}` } });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as any).data[0].id, "openai/gpt-4o-mini");
  assert.equal(r.headers.get("x-openrouter-trace"), null);
  assert.equal(r.headers.get("cache-control"), "max-age=60");
  assert.equal(calls[0].url, "https://up.test/api/v1/models");
  server.close();
});

test("other /v1 paths are 404 in the error shape", async () => {
  const { base, server, calls } = await start(() => completion("g", 0));
  const r = await fetch(base + "/v1/embeddings", { method: "POST", headers: { Authorization: `Bearer ${SECRET}` }, body: "{}" });
  assert.equal(r.status, 404);
  assert.equal(((await r.json()) as any).error.type, "invalid_request_error");
  assert.equal(calls.length, 0);
  server.close();
});

test("drain waits for in-flight metering and returns at once when nothing is in flight", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { base, server, store, proxy } = await start(async () => { await gate; return completion("gen-d", 0.01); });
  const pending = chat(base, MSG);
  for (let i = 0; i < 100 && proxy.inFlight(V) === 0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(proxy.inFlight(V), 1);
  const t0 = Date.now();
  const drained = proxy.drain(V, 5_000);
  release();
  await drained;
  assert.ok(Date.now() - t0 < 4_000);
  assert.equal(proxy.inFlight(V), 0);
  assert.equal(store.modelCall("gen-d")!.costUsd, 0.01);
  assert.equal((await pending).status, 200);
  const t1 = Date.now();
  await proxy.drain(V, 5_000);
  assert.ok(Date.now() - t1 < 100);
  server.close();
});

test("drain gives up after its timeout", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { base, server, proxy } = await start(async () => { await gate; return completion("gen-t", 0.01); });
  const pending = chat(base, MSG);
  for (let i = 0; i < 100 && proxy.inFlight(V) === 0; i++) await new Promise((r) => setTimeout(r, 5));
  const t0 = Date.now();
  await proxy.drain(V, 50);
  const took = Date.now() - t0;
  assert.ok(took >= 45 && took < 1_000, String(took));
  assert.equal(proxy.inFlight(V), 1);
  release();
  await pending;
  server.close();
});

test("the log line names key, model, cost and status, never the prompt or a secret", async () => {
  const { base, server, logs } = await start(() => completion("gen-l", 0.02));
  await chat(base, { ...MSG, messages: [{ role: "user", content: "TOP SECRET PROMPT" }] });
  const line = logs.find((m) => m.includes("gen-l"))!;
  assert.match(line, /^proxy key k1 model openai\/gpt-4o-mini gen gen-l cost \$0\.02 \d+ms 200$/);
  const all = logs.join("\n");
  assert.ok(!all.includes("TOP SECRET"));
  assert.ok(!all.includes(COMPANY));
  assert.ok(!all.includes(SECRET));
  server.close();
});

test("a failure inside the proxy answers 500 in the error shape", async () => {
  const { base, server, store, calls } = await start(() => completion("gen-f", 0));
  store.setVaultOpenRouterKey(V, "orhash", "garbage");
  const r = await chat(base, MSG);
  assert.equal(r.status, 500);
  assert.equal(((await r.json()) as any).error.type, "server_error");
  assert.equal(calls.length, 0);
  server.close();
});

/** An SSE body that emits the given events, waiting for `gate` (if given) before the last one, or erroring at `breakAt`. */
function sse(events: unknown[], opts: { gate?: Promise<void>; breakAt?: number } = {}) {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      c.enqueue(enc.encode(": OPENROUTER PROCESSING\n\n"));
      for (const [i, e] of events.entries()) {
        if (opts.breakAt === i) { c.error(new Error("upstream reset")); return; }
        if (i === events.length - 1 && opts.gate) await opts.gate;
        c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      }
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "x-openrouter-trace": "leak" } });
}
const chunk = (id: string, content: string) => ({ id, model: "openai/gpt-4o-mini", choices: [{ delta: { content } }] });
const usageEvent = (id: string, cost: number) => ({ id, model: "openai/gpt-4o-mini", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, cost } });
const STREAM = { ...MSG, stream: true };

test("a streamed answer is relayed event by event and metered from the final usage event", async () => {
  const { base, server, store, calls } = await start(() => sse([chunk("gen-s", "Hel"), chunk("gen-s", "lo"), usageEvent("gen-s", 0.005)]));
  const r = await chat(base, STREAM);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "text/event-stream");
  assert.equal(r.headers.get("x-openrouter-trace"), null);
  const text = await r.text();
  assert.ok(text.startsWith(": OPENROUTER PROCESSING\n\n")); // byte for byte, comments included
  const datas = text.split("\n\n").filter((e) => e.startsWith("data:")).map((e) => e.slice(5).trim());
  assert.equal(datas.length, 4);
  assert.equal(JSON.parse(datas[0]).choices[0].delta.content, "Hel");
  assert.equal(JSON.parse(datas[1]).choices[0].delta.content, "lo");
  assert.equal(JSON.parse(datas[2]).usage.cost, 0.005);
  assert.equal(datas[3], "[DONE]");
  assert.deepEqual([store.modelCall("gen-s")!.costUsd, store.modelCall("gen-s")!.status], [0.005, "recorded"]);
  const sent = JSON.parse(String(calls[0].init.body));
  assert.equal(sent.stream, true);
  assert.deepEqual(sent.usage, { include: true });
  assert.equal((calls[0].init.headers as Record<string, string>).Accept, "text/event-stream");
  server.close();
});

test("a client that disconnects mid-stream is still metered once the upstream finishes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { base, server, store, proxy } = await start(() => sse([chunk("gen-c", "a"), chunk("gen-c", "b"), usageEvent("gen-c", 0.007)], { gate }));
  const ac = new AbortController();
  const r = await fetch(base + "/v1/chat/completions", {
    method: "POST", headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify(STREAM), signal: ac.signal,
  });
  assert.equal(r.status, 200);
  await r.body!.getReader().read(); // the first bytes arrived
  ac.abort(); // the developer's client goes away
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(proxy.inFlight(V), 1); // the proxy is still reading the upstream
  assert.equal(store.modelCall("gen-c"), undefined);
  release();
  await proxy.drain(V, 5_000);
  assert.equal(proxy.inFlight(V), 0);
  assert.deepEqual([store.modelCall("gen-c")!.costUsd, store.modelCall("gen-c")!.status], [0.007, "recorded"]);
  server.close();
});

test("an upstream stream that breaks before usage leaves a pending row that the keeper resolves", async () => {
  const { base, server, store, logs, d } = await start(() => sse([chunk("gen-b", "a"), chunk("gen-b", "b")], { breakAt: 1 }));
  const r = await chat(base, STREAM);
  assert.equal(r.status, 200);
  await r.text().catch(() => {});
  assert.equal(store.modelCall("gen-b")!.status, "pending");
  assert.ok(logs.some((m) => m.includes("gen-b") && m.includes("cost pending")));
  d.or.getGeneration = async (id, apiKey) => (apiKey === COMPANY ? { id, model: "openai/gpt-4o-mini", totalCost: 0.009 } : undefined);
  await resolvePendingModelCalls(d.keeper);
  assert.deepEqual([store.modelCall("gen-b")!.costUsd, store.modelCall("gen-b")!.status], [0.009, "recorded"]);
  assert.equal(store.keyById("k1")!.modelSpent, 0.009);
  server.close();
});

test("a stream without a generation id meters nothing and says so", async () => {
  const { base, server, store, logs } = await start(() => sse([{ choices: [{ delta: { content: "?" } }] }]));
  await (await chat(base, STREAM)).text();
  assert.equal(store.listPendingModelCalls().length, 0);
  assert.ok(logs.some((m) => m.includes("without a generation id")));
  server.close();
});

test("a streaming request whose upstream answers with a JSON error relays the error", async () => {
  const { base, server } = await start(() => json({ error: { message: "no such model", code: 404 } }, 404));
  const r = await chat(base, STREAM);
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: { message: "no such model", code: 404 } });
  server.close();
});

test("a streaming request answered with plain JSON is metered like a non-streaming one", async () => {
  const { base, server, store } = await start(() => completion("gen-j", 0.01));
  const r = await chat(base, STREAM);
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as any).usage.cost, 0.01);
  assert.equal(store.modelCall("gen-j")!.costUsd, 0.01);
  server.close();
});
