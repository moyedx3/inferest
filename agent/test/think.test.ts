import { test } from "node:test";
import assert from "node:assert/strict";
import { think, type Mcp } from "../think.ts";

const mcp: Mcp = {
  listTools: async () => [{ name: "search_tools", description: "find a tool", inputSchema: { type: "object" } }],
  callTool: async (name, args) => ({ content: [{ type: "text", text: `result of ${name} ${JSON.stringify(args)}` }] }),
};
const prompt = { walletUsdc: 500, vaultValue: 500, floorUsdc: 200, currentTarget: "0xa", targets: [{ address: "0xa", name: "A", rate: 0.04 }, { address: "0xb", name: "B", rate: null }], positions: [] };
const decision = { note: "hold", split: { action: "hold", amountUsdc: 0 }, source: { action: "stay", target: null }, trades: [] };
const reply = (message: unknown) => new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { "content-type": "application/json" } });

test("the loop calls a paid tool, then decides", async () => {
  const bodies: any[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    if (bodies.length === 1) return reply({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "search_tools", arguments: JSON.stringify({ query: "eth price" }) } }] });
    return reply({ role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "decide", arguments: JSON.stringify(decision) } }] });
  }) as unknown as typeof fetch;
  const r = await think({ key: "sk-inf-x", model: "m", api: "http://api.test", mcp, book: prompt, maxTurns: 10, maxToolCalls: 4, fetchFn });
  assert.deepEqual(r.decision, decision);
  assert.equal(r.outOfBudget, false);
  assert.deepEqual(r.toolCalls, [{ name: "search_tools", args: { query: "eth price" } }]);
  assert.equal(r.turns, 2);
  assert.equal(bodies[0].messages[0].role, "system");
  assert.ok(bodies[0].tools.some((t: any) => t.function.name === "decide"));
  assert.equal(bodies[1].messages.at(-1).role, "tool");
});

test("a 402 ends the run out of budget", async () => {
  const fetchFn = (async () => new Response(JSON.stringify({ error: { code: 402 } }), { status: 402 })) as unknown as typeof fetch;
  const r = await think({ key: "k", model: "m", api: "http://api.test", mcp, book: prompt, maxTurns: 10, maxToolCalls: 4, fetchFn });
  assert.equal(r.outOfBudget, true);
  assert.equal(r.decision, null);
});

test("a malformed decide call, the turn cap and the tool cap end the loop without a decision", async () => {
  let n = 0;
  const bad = (async () => reply({ role: "assistant", content: null, tool_calls: [{ id: `c${++n}`, type: "function", function: { name: "decide", arguments: JSON.stringify({ note: 1 }) } }] })) as unknown as typeof fetch;
  const r1 = await think({ key: "k", model: "m", api: "http://api.test", mcp, book: prompt, maxTurns: 10, maxToolCalls: 4, fetchFn: bad });
  assert.equal(r1.decision, null);
  assert.match(r1.error!, /decision/);
  const chatty = (async () => reply({ role: "assistant", content: "thinking" })) as unknown as typeof fetch;
  const r2 = await think({ key: "k", model: "m", api: "http://api.test", mcp, book: prompt, maxTurns: 2, maxToolCalls: 4, fetchFn: chatty });
  assert.equal(r2.turns, 2);
  assert.equal(r2.decision, null);
  const tools = (async () => reply({ role: "assistant", content: null, tool_calls: [{ id: `c${++n}`, type: "function", function: { name: "search_tools", arguments: "{}" } }] })) as unknown as typeof fetch;
  const r3 = await think({ key: "k", model: "m", api: "http://api.test", mcp, book: prompt, maxTurns: 10, maxToolCalls: 2, fetchFn: tools });
  assert.equal(r3.toolCalls.length, 2);
  assert.equal(r3.decision, null);
});
