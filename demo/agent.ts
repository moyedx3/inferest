import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { API, api, customerWithVault, chat, env, printState, sleep, step, usd, warp } from "./lib.ts";

const TASK = "Find what Octant's Yield Donating Strategy is and summarize it in three sentences. Use a paid web search or scraping tool.";

step(1, "An agent's own wallet deposits 20,000 USDC into its own vault.");
const a = await customerWithVault(env("DEMO_AGENT_KEY") as `0x${string}`, 20_000_000_000n, "Agent");
const { key } = await api("/api/keys", { vault: a.vault, name: "agent", weight: 1 });

step(2, "Time passes; the agent's limit rises from its own yield.");
await warp(Math.round(182.5 * 86_400));
await api("/api/admin/report", {});
await api("/api/admin/sync", {});
await printState(a.vault);

step(3, "The agent works: a model for thinking, paid tools through the Inferest MCP server.");
const mcp = new Client({ name: "inferest-demo-agent", version: "0.1.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(`${API}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
const { tools } = await mcp.listTools();
const fnTools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema } }));
const messages: any[] = [
  { role: "system", content: "You are a research agent. Use search_tools to find a web search or scraping tool, read its parameters with tool_details, call it with run_tool, then answer. If a run_tool call is refused or returns an error, do not repeat the same call: pick a different tool from the search results (a different api) and try that instead, up to three different tools. If every tool fails, answer from what you already know and say the tools were unavailable." },
  { role: "user", content: TASK },
];
for (let turn = 0; turn < 10; turn++) {
  const msg = (await chat(key, messages, fnTools)).choices[0].message;
  messages.push(msg);
  if (!msg.tool_calls?.length) { console.log(`\n   ${String(msg.content).trim()}\n`); break; }
  for (const call of msg.tool_calls) {
    console.log(`   tool: ${call.function.name} ${call.function.arguments.slice(0, 80)}`);
    let out: any;
    try {
      // Paid tools can take a few minutes (payment plus a scrape); the client default is 60 seconds.
      out = await mcp.callTool({ name: call.function.name, arguments: JSON.parse(call.function.arguments || "{}") }, undefined, { timeout: 240_000 });
    } catch (e) {
      out = { isError: true, content: [{ type: "text", text: `tool call failed: ${(e as Error).message}` }] };
    }
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out.content).slice(0, 6_000) });
    const preview = (out.content ?? []).map((c: any) => c.text ?? "").join(" ").replace(/\s+/g, " ").slice(0, 160);
    console.log(out.isError ? `   error: ${preview}` : `   result: ${preview}`);
  }
}
await mcp.close();
await sleep(5_000);
await api("/api/admin/sync", {});
await printState(a.vault);

step(4, "Settle: leftover goes back into the agent's vault. No human topped anything up.");
console.log(`   ${JSON.stringify(await api("/api/admin/settle", { vault: a.vault }))}`);
console.log(`   agent principal now ${usd(await a.value())}`);
