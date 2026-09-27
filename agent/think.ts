import { MAX_TRADES, type Decision } from "./fence.ts";

export type Mcp = {
  listTools(): Promise<{ name: string; description?: string; inputSchema: unknown }[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
};
export type PromptBook = {
  walletUsdc: number; vaultValue: number; floorUsdc: number; currentTarget: string | null; tradeCapBps: number;
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
    "You are a desk analyst, not a vault-sitter. When you have a current price you are expected to hold at least one small paper position and say why in your note; when you hold one, decide whether to keep it, add within the cap, or close it. Holding everything in cash run after run is the wrong default.",
    `Rules you must respect: the vault never goes below the floor; one split move and one source move per run at most; only ETH, BTC or ARB against USDC; a buy at most ${b.tradeCapBps / 100}% of the working half; a sell at most the open position; at most ${MAX_TRADES} trades.`,
    "Research with the tools: search_tools finds a paid web search, price or news tool, tool_details shows its parameters, run_tool calls it. Only run_tool costs money, from your budget, so run only what you need. For spot prices the exchange-rate tool abstractapi /v1/live (query base USD, target BTC,ETH) costs about a tenth of a cent and is enough; it does not know ARB, so trade ARB only when a web search gives you a price. At most one news or web search call per run. Then call decide exactly once.",
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

const FORCE = "Decide now with what you have.";
const PAID = "run_tool";

/**
 * One run's chat loop on the agent's own key: MCP tools for research, `decide` to end. Only `run_tool` counts toward
 * the paid-tool cap; discovery is free. At the paid-tool cap or on the last allowed turn, one call offers only
 * `decide` and forces it. Never throws on a 402: it reports it.
 */
export async function think(i: { key: string; model: string; api: string; mcp: Mcp; book: PromptBook; maxTurns: number; maxToolCalls: number; fetchFn?: typeof fetch; timeoutMs?: number }): Promise<ThinkResult> {
  const fetchFn = i.fetchFn ?? fetch;
  const mcpTools = await i.mcp.listTools();
  const tools = [...mcpTools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema } })), DECIDE];
  const messages: any[] = [{ role: "system", content: systemPrompt(i.book) }, { role: "user", content: "Run your review of the book and decide." }];
  const toolCalls: { name: string; args: unknown }[] = [];
  let turns = 0, paid = 0;
  const done = (r: Partial<ThinkResult>): ThinkResult => ({ decision: null, outOfBudget: false, toolCalls, turns, ...r });
  const decideFrom = (call: any): ThinkResult => {
    try { return done({ decision: parseDecision(call.function.arguments || "{}") }); }
    catch (e) { return done({ error: `decision rejected: ${(e as Error).message}` }); }
  };
  /** One chat call; a Response-level failure comes back as the run's result. */
  const chat = async (body: Record<string, unknown>): Promise<{ msg: any } | { end: ThinkResult }> => {
    turns++;
    const r = await fetchFn(`${i.api}/v1/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${i.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: i.model, messages, ...body }),
      // a hung proxy call throws a TimeoutError, which the runner records as the run's error
      signal: AbortSignal.timeout(i.timeoutMs ?? 180_000),
    });
    if (r.status === 402) return { end: done({ outOfBudget: true }) };
    if (!r.ok) return { end: done({ error: `proxy answered ${r.status}` }) };
    const msg = ((await r.json()) as any).choices?.[0]?.message;
    if (!msg) return { end: done({ error: "empty answer" }) };
    messages.push(msg);
    return { msg };
  };
  /** The last call: only `decide` is offered, and it is forced. Without a valid decide, the run ends with `why`. */
  const forced = async (why: string): Promise<ThinkResult> => {
    messages.push({ role: "user", content: FORCE });
    const r = await chat({ tools: [DECIDE], tool_choice: { type: "function", function: { name: "decide" } } });
    if ("end" in r) return r.end;
    const call = r.msg.tool_calls?.find((c: any) => c.function?.name === "decide");
    return call ? decideFrom(call) : done({ error: why });
  };
  while (turns < i.maxTurns) {
    if (turns === i.maxTurns - 1) return forced("turn cap reached");
    const r = await chat({ tools });
    if ("end" in r) return r.end;
    const msg = r.msg;
    if (!msg.tool_calls?.length) continue; // prose only: ask again until the turn cap
    let capped = false;
    for (const call of msg.tool_calls) {
      if (call.function.name === "decide") return decideFrom(call);
      // every call in the assistant message gets a tool answer, even the ones past the cap, so the forced call is well formed
      if (capped || (call.function.name === PAID && paid >= i.maxToolCalls)) {
        capped = true;
        messages.push({ role: "tool", tool_call_id: call.id, content: "not run: the paid tool cap is reached" });
        continue;
      }
      let args: unknown = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }
      toolCalls.push({ name: call.function.name, args });
      if (call.function.name === PAID) paid++;
      let out: unknown;
      try { out = await i.mcp.callTool(call.function.name, args); } catch (e) { out = { isError: true, content: [{ type: "text", text: `tool call failed: ${(e as Error).message}` }] }; }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify((out as any)?.content ?? out).slice(0, 6_000) });
    }
    if (capped || paid >= i.maxToolCalls) return forced("paid tool cap reached");
  }
  return done({ error: "turn cap reached" });
}
