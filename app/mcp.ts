import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolGateway } from "./tools.ts";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

export function buildMcpServer(gateway: ToolGateway, keyHash: string): McpServer {
  const server = new McpServer({ name: "inferest-tools", version: "0.1.0" });

  server.registerTool(
    "search_tools",
    {
      description:
        "Find paid tools: web search, scraping, enrichment, research. Returns api, path, method and price in USD. " +
        "Calls are paid from this key's yield.",
      inputSchema: { prompt: z.string().min(1), limit: z.number().int().min(1).max(50).optional() },
    },
    async ({ prompt, limit }) => text(await gateway.search(prompt, limit)),
  );

  server.registerTool(
    "tool_details",
    {
      description:
        "Exact parameters (name, location: path, query or body) and price for one tool. " +
        "Call this before run_tool; never guess parameter names. Free.",
      inputSchema: { api: z.string(), path: z.string() },
    },
    async ({ api, path }) => text(await gateway.details(api, path)),
  );

  server.registerTool(
    "run_tool",
    {
      description:
        "Run a tool found with search_tools, using the parameters from tool_details. Paid per call from this key's yield. " +
        "If a call fails or times out, do not repeat it blindly.",
      inputSchema: {
        api: z.string(),
        path: z.string(),
        method: z.string().optional(),
        body: z.unknown().optional(),
        query: z.record(z.string(), z.string()).optional(),
      },
    },
    async (args) => {
      try {
        return text(await gateway.run(keyHash, args));
      } catch (e) {
        const message = (e as Error).message;
        console.error(`run_tool ${keyHash}: ${message}`);
        return { isError: true, content: [{ type: "text" as const, text: message }] };
      }
    },
  );

  return server;
}
