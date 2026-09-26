import { test } from "node:test";
import assert from "node:assert/strict";
import { settleThroughServer, describeSettle } from "../remote.ts";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

test("settleThroughServer maps a 200 answer to RemoteSettle", async () => {
  const fetchFn = fakeFetch(200, { usageMicro: "1500", tx: "0xabc", pending: false });
  const r = await settleThroughServer("http://localhost:8787", "admin-token", "0xvault", fetchFn);
  assert.deepEqual(r, { usageMicro: "1500", tx: "0xabc", pending: false });
});

test("settleThroughServer resolves undefined when fetch throws (no server listening)", async () => {
  const fetchFn = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as unknown as typeof fetch;
  const r = await settleThroughServer("http://localhost:8787", "admin-token", "0xvault", fetchFn);
  assert.equal(r, undefined);
});

test("settleThroughServer rejects on a non-200 answer", async () => {
  const fetchFn = fakeFetch(404, { error: "unknown vault" });
  await assert.rejects(
    () => settleThroughServer("http://localhost:8787", "admin-token", "0xvault", fetchFn),
    /refused the settlement: 404 unknown vault/,
  );
});

test("describeSettle on null", () => {
  assert.equal(describeSettle(null), "nothing settled");
});

test("describeSettle on a remote pending answer", () => {
  assert.equal(
    describeSettle({ usageMicro: "2500", tx: "0xdef", pending: true }),
    "pending 2500 micro-USD in 0xdef",
  );
});

test("describeSettle on an in-process SettleResult", () => {
  assert.equal(describeSettle({ usage: 5n, tx: "0x1" }), "settled 5 micro-USD in 0x1");
});
