/** Ready-to-paste client setups for an Inferest key. `key` may be a placeholder. */
export function snippets(baseUrl, key) {
  const base = baseUrl.replace(/\/+$/, "");
  return [
    { name: "curl", text: `curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"moonshotai/kimi-k2.6","messages":[{"role":"user","content":"Say hi"}]}'` },
    { name: "OpenAI SDK (Python)", text: `from openai import OpenAI

client = OpenAI(base_url="${base}/v1", api_key="${key}")
r = client.chat.completions.create(model="moonshotai/kimi-k2.6", messages=[{"role": "user", "content": "Say hi"}])
print(r.choices[0].message.content)` },
    { name: "OpenAI SDK (Node)", text: `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${base}/v1", apiKey: "${key}" });
const r = await client.chat.completions.create({ model: "moonshotai/kimi-k2.6", messages: [{ role: "user", content: "Say hi" }] });
console.log(r.choices[0].message.content);` },
    { name: "Vercel AI SDK", text: `import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

const inferest = createOpenAI({ baseURL: "${base}/v1", apiKey: "${key}" });
const { text } = await generateText({ model: inferest.chat("moonshotai/kimi-k2.6"), prompt: "Say hi" });
console.log(text);` },
    { name: "Agent config (OpenClaw, Hermes, any OpenRouter-compatible agent)", text: `# The proxy speaks OpenRouter's chat completions API, so point the agent's OpenRouter settings at Inferest:
OPENROUTER_API_KEY=${key}
OPENROUTER_BASE_URL=${base}/v1` },
    { name: "MCP tools (same key)", text: `# Streamable HTTP MCP server with paid web tools, billed from the same yield budget
URL:    ${base}/mcp
Header: Authorization: Bearer ${key}` },
  ];
}

/** What a developer needs to know about an Inferest key, as short titled notes; `icon` names an icon in app.js. */
export const NOTES = [
  { icon: "link", title: "Base URL", text: "This server, path /v1. Only POST /v1/chat/completions and GET /v1/models are served." },
  { icon: "box", title: "Model ids", text: "OpenRouter's, for example moonshotai/kimi-k2.6 or openai/gpt-4o-mini. Streaming works." },
  { icon: "stop", title: "402 insufficient_quota", text: "This key's yield budget for the period is used up, or its vault is frozen. Not retryable." },
  { icon: "lock", title: "401", text: "The key is unknown or revoked. Keys are shown once; rotate for a new secret on the same budget." },
];
