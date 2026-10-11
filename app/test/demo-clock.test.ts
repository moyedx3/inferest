import { test } from "node:test";
import assert from "node:assert/strict";
import { moveClock } from "../demo-clock.ts";

test("moves the chain's own clock when the node has evm_increaseTime", async () => {
  const calls: [string, unknown[]][] = [];
  const posts: string[] = [];
  const how = await moveClock({
    rpc: async (method, params) => { calls.push([method, params]); return null; },
    api: async (path) => { posts.push(path); return {}; },
    seconds: 604_800,
  });
  assert.equal(how, "chain");
  assert.deepEqual(calls, [["evm_increaseTime", ["0x93a80"]], ["evm_mine", []]]);
  assert.deepEqual(posts, []);
});

test("falls back to the server's warp route when the node does not know the method", async () => {
  const bodies: unknown[] = [];
  for (const message of ["evm_increaseTime: Method not found", "evm_increaseTime: the method evm_increaseTime does not exist/is not available"]) {
    bodies.length = 0;
    const how = await moveClock({
      rpc: async () => { throw new Error(message); },
      api: async (_path, body) => { bodies.push(body); return {}; },
      seconds: 604_800,
    });
    assert.equal(how, "sources");
    assert.deepEqual(bodies, [{ seconds: 604_800 }]);
  }
});

test("a node error with the JSON-RPC code for an unknown method also falls back", async () => {
  const bodies: unknown[] = [];
  const how = await moveClock({
    rpc: async () => { throw Object.assign(new Error("evm_increaseTime: nope"), { code: -32601 }); },
    api: async (_path, body) => { bodies.push(body); return {}; },
    seconds: 60,
  });
  assert.equal(how, "sources");
  assert.deepEqual(bodies, [{ seconds: 60 }]);
});

test("any other node error is not swallowed", async () => {
  await assert.rejects(moveClock({
    rpc: async () => { throw new Error("evm_increaseTime: connection refused"); },
    api: async () => ({}),
    seconds: 1,
  }), /connection refused/);
});
