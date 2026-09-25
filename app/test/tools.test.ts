import { test } from "node:test";
import assert from "node:assert/strict";
import { toolGateway, BudgetExhausted, ToolCallFailed, capResourceDescription, type PayingFetchFactory } from "../tools.ts";

const searchBody = {
  success: true,
  results: [{ slug: "olostep", endpoints: [
    { path: "/v1/scrapes", method: "POST", description: "Scrape a URL", price: "0.005", isPayable: true },
    { path: "/v1/private", method: "GET", description: "Not payable", price: "0.01", isPayable: false },
  ] }],
};

function gateway(budget: number, charge = 5_000n) {
  const recorded: unknown[][] = [];
  const paid: { url: string; max: bigint; init: RequestInit }[] = [];
  const makePayingFetch: PayingFetchFactory = (max, onAmount) =>
    (async (url: string, init: RequestInit) => {
      paid.push({ url, max, init });
      onAmount(charge);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
  const fetchFn = (async () => new Response(JSON.stringify(searchBody), { status: 200 })) as unknown as typeof fetch;
  const g = toolGateway({
    orthogonalKey: "orth", fetchFn, makePayingFetch,
    budgetUsd: () => budget,
    record: (...a) => recorded.push(a),
  });
  return { g, recorded, paid };
}

test("search flattens payable endpoints with USD prices", async () => {
  const { g } = gateway(1);
  assert.deepEqual(await g.search("scrape"), [
    { api: "olostep", path: "/v1/scrapes", method: "POST", description: "Scrape a URL", priceUsd: 0.005 },
  ]);
});

test("run pays through x402 and records the charged amount", async () => {
  const { g, recorded, paid } = gateway(2);
  await g.run("h1", { api: "olostep", path: "/v1/scrapes", method: "POST", body: { url_to_scrape: "https://example.com" } });
  assert.equal(paid[0].url, "https://x402.orthogonal.com/olostep/v1/scrapes");
  assert.equal(paid[0].init.method, "POST");
  assert.deepEqual(recorded, [["h1", "olostep", "/v1/scrapes", 0.005]]);
});

test("caps the x402 payment at the remaining budget", async () => {
  const { g, paid } = gateway(0.25);
  await g.run("h1", { api: "olostep", path: "/v1/scrapes" });
  assert.equal(paid[0].max, 250_000n);
});

test("refuses a run when the budget is exhausted", async () => {
  const { g, paid } = gateway(0);
  await assert.rejects(g.run("h1", { api: "olostep", path: "/v1/scrapes" }), BudgetExhausted);
  assert.equal(paid.length, 0);
});

test("details posts api and path to the free details endpoint", async () => {
  const calls: { url: string; body: string }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body) });
    return new Response(JSON.stringify({ success: true, endpoint: { path: "/v1/scrapes", price: "0.005" } }), { status: 200 });
  }) as unknown as typeof fetch;
  const g = toolGateway({ orthogonalKey: "orth", fetchFn, makePayingFetch: () => { throw new Error("must not pay"); }, budgetUsd: () => 1, record: () => {} });
  const out: any = await g.details("olostep", "/v1/scrapes");
  assert.equal(calls[0].url, "https://api.orthogonal.com/v1/details");
  assert.deepEqual(JSON.parse(calls[0].body), { api: "olostep", path: "/v1/scrapes" });
  assert.equal(out.endpoint.price, "0.005");
});

test("never retries a paid call", async () => {
  let attempts = 0;
  const g = toolGateway({
    orthogonalKey: "orth",
    fetchFn: (async () => new Response("{}")) as unknown as typeof fetch,
    makePayingFetch: () => (async () => { attempts++; throw new Error("socket hang up"); }) as unknown as typeof fetch,
    budgetUsd: () => 1,
    record: () => { throw new Error("must not record"); },
  });
  await assert.rejects(g.run("h1", { api: "olostep", path: "/v1/scrapes" }), /socket hang up/);
  assert.equal(attempts, 1);
});

test("rejects paths that could escape the API", async () => {
  const { g } = gateway(1);
  await assert.rejects(g.run("h1", { api: "olostep", path: "/../admin" }), /invalid/);
  await assert.rejects(g.run("h1", { api: "olo/step", path: "/x" }), /invalid/);
});

function failingGateway(fail: () => Promise<Response>) {
  const recorded: unknown[][] = [];
  const g = toolGateway({
    orthogonalKey: "orth",
    fetchFn: (async () => new Response("{}")) as unknown as typeof fetch,
    makePayingFetch: (_max, onAmount) => (async () => { onAmount(5_000n); return fail(); }) as unknown as typeof fetch,
    budgetUsd: () => 1,
    record: (...a) => recorded.push(a),
  });
  return { g, recorded };
}

test("records a paid call that fails after payment", async () => {
  const { g, recorded } = failingGateway(async () => new Response("upstream down", { status: 500 }));
  await assert.rejects(g.run("h1", { api: "olostep", path: "/v1/scrapes" }), (err: unknown) => {
    assert.ok(err instanceof ToolCallFailed);
    assert.equal(err.charged, 0.005);
    assert.match(err.message, /500 upstream down/);
    assert.match(err.message, /check usage before retrying/);
    return true;
  });
  assert.deepEqual(recorded, [["h1", "olostep", "/v1/scrapes", 0.005]]);
});

test("records a paid call whose request throws after the amount was chosen", async () => {
  const { g, recorded } = failingGateway(async () => { throw new Error("socket hang up"); });
  await assert.rejects(g.run("h1", { api: "olostep", path: "/v1/scrapes" }), (err: unknown) => {
    assert.ok(err instanceof ToolCallFailed);
    assert.match(err.message, /socket hang up/);
    assert.match(err.message, /0\.005/);
    assert.match(err.message, /check usage/);
    return true;
  });
  assert.deepEqual(recorded, [["h1", "olostep", "/v1/scrapes", 0.005]]);
});

test("parallel runs on one key share the budget", async () => {
  const charge = 5_000n;
  const paid: { max: bigint }[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const g = toolGateway({
    orthogonalKey: "orth",
    fetchFn: (async () => new Response("{}")) as unknown as typeof fetch,
    makePayingFetch: (max, onAmount) => (async () => {
      paid.push({ max });
      onAmount(charge);
      await gate;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch,
    budgetUsd: () => 0.01,
    record: () => {},
  });
  const call = { api: "olostep", path: "/v1/scrapes" };
  const r1 = g.run("h1", call);
  await new Promise((r) => setImmediate(r)); // run 1 has chosen its amount
  const r2 = g.run("h1", call);
  assert.equal(paid[1].max, 5_000n);
  await assert.rejects(g.run("h1", call), BudgetExhausted);
  assert.equal(paid.length, 2);
  release();
  await Promise.all([r1, r2]);
  await g.run("h1", call);
  assert.equal(paid[2].max, 10_000n);
});

test("a price above the cap is not recorded as a paid call", async () => {
  const recorded: unknown[][] = [];
  const price = 5_000n;
  const g = toolGateway({
    orthogonalKey: "orth",
    fetchFn: (async () => new Response("{}")) as unknown as typeof fetch,
    makePayingFetch: (max, onAmount) => (async () => {
      if (price <= max) onAmount(price);
      throw new Error("Payment amount exceeds maximum allowed");
    }) as unknown as typeof fetch,
    budgetUsd: () => 0.001,
    record: (...a) => recorded.push(a),
  });
  await assert.rejects(g.run("h1", { api: "olostep", path: "/v1/scrapes" }), (err: unknown) => {
    assert.ok(err instanceof Error && !(err instanceof ToolCallFailed));
    assert.match(err.message, /exceeds maximum/);
    return true;
  });
  assert.deepEqual(recorded, []);
});

test("a paid replay answered with 402 was rejected, so it is not recorded", async () => {
  const recorded: unknown[][] = [];
  const header = Buffer.from(JSON.stringify({ x402Version: 2, error: "invalid payment" })).toString("base64");
  const g = toolGateway({
    orthogonalKey: "orth",
    fetchFn: (async () => new Response("{}")) as unknown as typeof fetch,
    makePayingFetch: (_max, onAmount) => (async () => {
      onAmount(5_000n);
      return new Response("{}", { status: 402, headers: { "payment-required": header } });
    }) as unknown as typeof fetch,
    budgetUsd: () => 1,
    record: (...a) => recorded.push(a),
  });
  await assert.rejects(g.run("h1", { api: "olostep", path: "/v1/scrapes" }), (err: unknown) => {
    assert.ok(err instanceof Error && !(err instanceof ToolCallFailed));
    assert.match(err.message, /invalid payment/);
    assert.match(err.message, /nothing charged/);
    return true;
  });
  assert.deepEqual(recorded, []);
});

test("capResourceDescription shortens a long echoed description and leaves short ones alone", () => {
  const long = { resource: { url: "https://x", description: "a".repeat(551), mimeType: "" } };
  capResourceDescription(long);
  assert.equal(long.resource.description.length, 255);
  const short = { resource: { url: "https://x", description: "fine", mimeType: "" } };
  capResourceDescription(short);
  assert.equal(short.resource.description, "fine");
  const empty: { resource?: { description?: string } } = {};
  const noDescription: { resource?: { description?: string } } = { resource: {} };
  assert.doesNotThrow(() => capResourceDescription(empty));
  assert.doesNotThrow(() => capResourceDescription(noDescription));
});
