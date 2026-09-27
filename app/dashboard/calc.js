// The calculator's sums. OpenRouter list prices, dollars per 1M tokens, checked against https://openrouter.ai/api/v1/models on 2026-09-27.
export const PRICES = [
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", in: 0.348, out: 0.696 },
  { id: "moonshotai/kimi-k2.6", name: "Kimi K2.6", in: 0.95, out: 4.0 },
  { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", in: 2.0, out: 10.0 },
  { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", in: 4.0, out: 20.0 },
  { id: "openai/gpt-5.5", name: "GPT-5.5", in: 5.0, out: 30.0 },
];
export const PRICES_DATE = "September 2026";
export const RATES = [0.04, 0.045, 0.05, 0.06];
export const RAIL_FEE = 0.05;
/** Deposits from docs/04-unit-economics.md: the principal that covers $200, $50 and $10,000 a month. The demo agent's comes from the page. */
export const PRESETS = [
  { label: "a solo developer", icon: "user", deposit: 56_100, modelId: "anthropic/claude-sonnet-5" },
  { label: "an always-on agent", icon: "bot", deposit: 14_000, modelId: "moonshotai/kimi-k2.6" },
  { label: "a 20-person team", icon: "users", deposit: 2_810_000, modelId: "anthropic/claude-sonnet-5" },
  { label: "our demo agent", icon: "sparkles", deposit: null, modelId: "moonshotai/kimi-k2.6" },
];
const blended = (m) => (3 * m.in + m.out) / 4; // 3 in for every 1 out
const perCall = (m) => (4000 * m.in + 1000 * m.out) / 1e6; // a call is 4K in, 1K out

/** What a deposit buys a month at a vault rate on a model, and the same credit on every other model. */
export function compute({ deposit, rate, modelId }) {
  const model = PRICES.find((m) => m.id === modelId) ?? PRICES[1];
  const interest = (deposit * rate) / 12;
  const credit = interest * (1 - RAIL_FEE);
  const tokens = (credit / blended(model)) * 1e6;
  const callsMonth = credit / perCall(model);
  const others = PRICES.map((m) => ({ id: m.id, name: m.name, tokens: (credit / blended(m)) * 1e6 }));
  return { model, interest, credit, tokens, perCall: perCall(model), callsMonth, callsDay: callsMonth / 30, others };
}
/** Millions with no decimals under 1,000M, billions with one decimal above. */
export const tokensText = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : `${Math.max(1, Math.round(n / 1e6))}M`);
/** Calls a month, rounded to the nearest hundred. */
export const callsText = (n) => (Math.round(n / 100) * 100).toLocaleString("en-US");
/** Calls a day, rounded to the nearest ten, so the worked example reads 1,520. */
export const callsDayText = (n) => (Math.round(n / 10) * 10).toLocaleString("en-US");
