import type { Decision } from "./fence.ts";

export type Mcp = {
  listTools(): Promise<{ name: string; description?: string; inputSchema: unknown }[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
};
export type PromptBook = {
  walletUsdc: number; vaultValue: number; floorUsdc: number; currentTarget: string | null;
  targets: { address: string; name: string; rate: number | null }[];
  positions: { asset: string; side: string; sizeUsdc: number; entryPrice: number; markPrice: number }[];
};
export type ThinkResult = { decision: Decision | null; outOfBudget: boolean; toolCalls: { name: string; args: unknown }[]; turns: number; error?: string };

const DECIDE = {
  type: "function",
  function: {
    name: "decide",
    description: "End the run with your decision. Call it once, after your research.",
    parameters: {
      type: "object", required: ["note", "split", "source", "trades"],
      properties: {
        note: { type: "string", description: "Your desk note, under 120 words." },
        split: { type: "object", required: ["action", "amountUsdc"], properties: { action: { enum: ["deposit", "withdraw", "hold"] }, amountUsdc: { type: "number" } } },
        source: { type: "object", required: ["action", "target"], properties: { action: { enum: ["stay", "move"] }, target: { type: ["string", "null"] } } },
        trades: { type: "array", items: { type: "object", required: ["side", "asset", "sizeUsdc", "price", "reasoning"], properties: {
          side: { enum: ["buy", "sell"] }, asset: { enum: ["ETH", "BTC", "ARB"] }, sizeUsdc: { type: "number" }, price: { type: "number" }, reasoning: { type: "string" } } } },
      },
    },
  },
};

export function systemPrompt(b: PromptBook): string {
  const pct = (r: number | null) => (r === null ? "unknown yet" : `${(r * 100).toFixed(2)}% a year`);
  return [
    "You are a financial agent that pays for its own thinking. Your capital is split between an Inferest vault, whose yield is your model and tool budget, and a working half you trade with on paper.",
    `Book: ${b.walletUsdc.toFixed(2)} USDC working, ${b.vaultValue.toFixed(2)} USDC parked in the vault (floor ${b.floorUsdc} USDC). Current yield source: ${b.currentTarget ?? "none"}.`,
    `Allowed yield sources: ${b.targets.map((t) => `${t.name} ${t.address} at ${pct(t.rate)}`).join("; ")}.`,
    `Open paper positions: ${b.positions.length ? b.positions.map((p) => `${p.side} ${p.asset} ${p.sizeUsdc} USDC at ${p.entryPrice}, marked ${p.markPrice}`).join("; ") : "none"}.`,
    "Rules you must respect: the vault never goes below the floor; one split move and one source move per run at most; only ETH, BTC or ARB against USDC; a buy at most 20% of the working half; a sell at most the open position; at most three trades.",
    "Research with the tools: search_tools finds a paid web search, price or news tool, tool_details shows its parameters, run_tool calls it. Paid tools cost from your budget, so call only what you need. Then call decide exactly once.",
  ].join("\n");
}

function parseDecision(raw: string): Decision {
  const d = JSON.parse(raw);
  const ok = typeof d?.note === "string" && ["deposit", "withdraw", "hold"].includes(d?.split?.action) && typeof d?.split?.amountUsdc === "number"
    && ["stay", "move"].includes(d?.source?.action) && (d?.source?.target === null || d?.source?.target === undefined || typeof d?.source?.target === "string") && Array.isArray(d?.trades)
    && d.trades.every((t: any) => ["buy", "sell"].includes(t?.side) && typeof t?.asset === "string" && typeof t?.sizeUsdc === "number" && typeof t?.price === "number" && typeof t?.reasoning === "string");
  if (!ok) throw new Error("the decision does not match the schema");
  return { note: d.note, split: { action: d.split.action, amountUsdc: d.split.amountUsdc }, source: { action: d.source.action, target: d.source.target ?? null }, trades: d.trades };
}

/** One run's chat loop on the agent's own key: MCP tools for research, `decide` to end. Never throws on a 402: it reports it. */
export async function think(i: { key: string; model: string; api: string; mcp: Mcp; book: PromptBook; maxTurns: number; maxToolCalls: number; fetchFn?: typeof fetch }): Promise<ThinkResult> {
  const fetchFn = i.fetchFn ?? fetch;
  const mcpTools = await i.mcp.listTools();
  const tools = [...mcpTools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema } })), DECIDE];
  const messages: any[] = [{ role: "system", content: systemPrompt(i.book) }, { role: "user", content: "Run your review of the book and decide." }];
  const toolCalls: { name: string; args: unknown }[] = [];
  let turns = 0;
  while (turns < i.maxTurns) {
    turns++;
    const r = await fetchFn(`${i.api}/v1/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${i.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: i.model, messages, tools }),
    });
    if (r.status === 402) return { decision: null, outOfBudget: true, toolCalls, turns };
    if (!r.ok) return { decision: null, outOfBudget: false, toolCalls, turns, error: `proxy answered ${r.status}` };
    const msg = ((await r.json()) as any).choices?.[0]?.message;
    if (!msg) return { decision: null, outOfBudget: false, toolCalls, turns, error: "empty answer" };
    messages.push(msg);
    if (!msg.tool_calls?.length) continue; // prose only: ask again until the turn cap
    for (const call of msg.tool_calls) {
      if (call.function.name === "decide") {
        try { return { decision: parseDecision(call.function.arguments || "{}"), outOfBudget: false, toolCalls, turns }; }
        catch (e) { return { decision: null, outOfBudget: false, toolCalls, turns, error: `decision rejected: ${(e as Error).message}` }; }
      }
      if (toolCalls.length >= i.maxToolCalls) return { decision: null, outOfBudget: false, toolCalls, turns, error: "paid tool cap reached" };
      let args: unknown = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }
      toolCalls.push({ name: call.function.name, args });
      let out: unknown;
      try { out = await i.mcp.callTool(call.function.name, args); } catch (e) { out = { isError: true, content: [{ type: "text", text: `tool call failed: ${(e as Error).message}` }] }; }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify((out as any)?.content ?? out).slice(0, 6_000) });
    }
  }
  return { decision: null, outOfBudget: false, toolCalls, turns, error: "turn cap reached" };
}
