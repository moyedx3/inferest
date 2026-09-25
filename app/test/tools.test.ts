import { test } from "node:test";
import assert from "node:assert/strict";
import { toolGateway, BudgetExhausted, type PayingFetchFactory } from "../tools.ts";

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
