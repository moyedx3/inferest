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
  const badTarget = (async () => reply({ role: "assistant", content: null, tool_calls: [{ id: `c${++n}`, type: "function", function: { name: "decide", arguments: JSON.stringify({ ...decision, source: { action: "move", target: 123 } }) } }] })) as unknown as typeof fetch;
  const r0 = await think({ key: "k", model: "m", api: "http://api.test", mcp, book: prompt, maxTurns: 10, maxToolCalls: 4, fetchFn: badTarget });
  assert.equal(r0.decision, null);
  assert.match(r0.error!, /decision/);
  const chattyBodies: any[] = [];
  const chatty = (async (_url: string, init: RequestInit) => { chattyBodies.push(JSON.parse(String(init.body))); return reply({ role: "assistant", content: "thinking" }); }) as unknown as typeof fetch;
  const r2 = await think({ key: "k", model: "m", api: "http://api.test", mcp, book: prompt, maxTurns: 2, maxToolCalls: 4, fetchFn: chatty });
  assert.equal(r2.turns, 2);
  assert.equal(r2.decision, null);
  assert.equal(r2.error, "turn cap reached");
  assert.equal(chattyBodies.at(-1).tool_choice.function.name, "decide");
  assert.equal(chattyBodies.at(-1).tools.length, 1);
  assert.equal(chattyBodies.at(-1).messages.at(-1).content, "Decide now with what you have.");
  const tools = (async () => reply({ role: "assistant", content: null, tool_calls: [{ id: `c${++n}`, type: "function", function: { name: "run_tool", arguments: "{}" } }] })) as unknown as typeof fetch;
  const r3 = await think({ key: "k", model: "m", api: "http://api.test", mcp, book: prompt, maxTurns: 10, maxToolCalls: 2, fetchFn: tools });
  assert.equal(r3.toolCalls.length, 2);
  assert.equal(r3.decision, null);
  assert.equal(r3.error, "paid tool cap reached");
});

test("only run_tool counts toward the paid cap; discovery is free", async () => {
  let n = 0;
  const bodies: any[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const name = bodies.length <= 3 ? "search_tools" : "run_tool";
    return reply({ role: "assistant", content: null, tool_calls: [{ id: `c${++n}`, type: "function", function: { name, arguments: "{}" } }] });
  }) as unknown as typeof fetch;
  const r = await think({ key: "k", model: "m", api: "http://api.test", mcp, book: prompt, maxTurns: 10, maxToolCalls: 1, fetchFn });
  assert.deepEqual(r.toolCalls.map((c) => c.name), ["search_tools", "search_tools", "search_tools", "run_tool"]);
  assert.equal(bodies.length, 5);
  assert.equal(bodies[4].tool_choice.function.name, "decide");
});

test("at the paid-tool cap one forced decide call ends the run with its decision", async () => {
  const bodies: any[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    if (body.tool_choice) return reply({ role: "assistant", content: null, tool_calls: [{ id: "d", type: "function", function: { name: "decide", arguments: JSON.stringify(decision) } }] });
    return reply({ role: "assistant", content: null, tool_calls: [{ id: `c${bodies.length}`, type: "function", function: { name: "run_tool", arguments: "{}" } }] });
  }) as unknown as typeof fetch;
  const r = await think({ key: "k", model: "m", api: "http://api.test", mcp, book: prompt, maxTurns: 10, maxToolCalls: 2, fetchFn });
  assert.deepEqual(r.decision, decision);
  assert.equal(r.toolCalls.length, 2);
  const last = bodies.at(-1);
  assert.deepEqual(last.tool_choice, { type: "function", function: { name: "decide" } });
  assert.equal(last.tools.length, 1);
  assert.equal(last.tools[0].function.name, "decide");
});

test("on the last allowed turn a forced decide call can still end the run with a decision", async () => {
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.tool_choice) return reply({ role: "assistant", content: null, tool_calls: [{ id: "d", type: "function", function: { name: "decide", arguments: JSON.stringify(decision) } }] });
    return reply({ role: "assistant", content: "thinking" });
  }) as unknown as typeof fetch;
  const r = await think({ key: "k", model: "m", api: "http://api.test", mcp, book: prompt, maxTurns: 3, maxToolCalls: 4, fetchFn });
  assert.deepEqual(r.decision, decision);
  assert.equal(r.turns, 3);
});
