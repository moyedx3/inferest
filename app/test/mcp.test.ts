import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../mcp.ts";
import { BudgetExhausted, type ToolGateway } from "../tools.ts";

async function connect(gateway: ToolGateway) {
  const server = buildMcpServer(gateway, "h1");
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(c);
  return client;
}

const gateway = {
  search: async (prompt: string) => [{ api: "olostep", path: "/v1/scrapes", method: "POST", description: prompt, priceUsd: 0.005 }],
  details: async (api: string, path: string) => ({ api, path, parameters: [{ name: "url_to_scrape", in: "body", required: true }] }),
  run: async (keyHash: string, call: { api: string; query?: Record<string, string> }) => {
    if (call.api === "broke") throw new BudgetExhausted("no yield left for tools on this key");
    return { keyHash, api: call.api, query: call.query };
  },
} as unknown as ToolGateway;

test("lists the three tools", async () => {
  const client = await connect(gateway);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["run_tool", "search_tools", "tool_details"]);
});

test("tool_details returns the parameter schema", async () => {
  const client = await connect(gateway);
  const r: any = await client.callTool({ name: "tool_details", arguments: { api: "olostep", path: "/v1/scrapes" } });
  assert.equal(JSON.parse(r.content[0].text).parameters[0].name, "url_to_scrape");
});

test("run_tool passes the authenticated key hash", async () => {
  const client = await connect(gateway);
  const r: any = await client.callTool({ name: "run_tool", arguments: { api: "olostep", path: "/v1/scrapes" } });
  assert.deepEqual(JSON.parse(r.content[0].text), { keyHash: "h1", api: "olostep" });
});

test("run_tool converts numeric and boolean query values to strings", async () => {
  const client = await connect(gateway);
  const r: any = await client.callTool({
    name: "run_tool",
    arguments: { api: "olostep", path: "/v1/scrapes", query: { size: 5, safe: true } },
  });
  assert.deepEqual(JSON.parse(r.content[0].text), {
    keyHash: "h1",
    api: "olostep",
    query: { size: "5", safe: "true" },
  });
});

test("budget errors come back as tool errors, not crashes", async () => {
  const client = await connect(gateway);
  const r: any = await client.callTool({ name: "run_tool", arguments: { api: "broke", path: "/x" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no yield left/);
});
