import { test } from "node:test";
import assert from "node:assert/strict";
import { compute, tokensText, callsText, callsDayText, PRICES, PRESETS } from "../dashboard/calc.js";

test("the defaults match the spec's worked example", () => {
  const r = compute({ deposit: 100_000, rate: 0.045, modelId: "moonshotai/kimi-k2.6" });
  assert.equal(r.interest.toFixed(2), "375.00");
  assert.equal(r.credit.toFixed(2), "356.25");
  assert.equal(Math.round(r.tokens / 1e6), 208);
  assert.equal(r.perCall.toFixed(4), "0.0078");
  assert.equal(callsText(r.callsMonth), "45,700");
  assert.equal(callsDayText(r.callsDay), "1,520");
  assert.equal(tokensText(r.tokens), "208M");
  assert.equal(r.others.length, PRICES.length);
  assert.equal(Math.round(r.others.find((o) => o.id === "openai/gpt-5.5")!.tokens / 1e6), 32);
});

test("tokens and calls round the way the spec says", () => {
  assert.equal(tokensText(819_000_000), "819M");
  assert.equal(tokensText(1_234_000_000), "1.2B");
  assert.equal(tokensText(950_000), "1M");
  assert.equal(callsText(1_520), "1,500");
  assert.equal(callsText(49), "0");
  assert.equal(callsDayText(1_523), "1,520");
});

test("presets carry the spec's deposits and models", () => {
  assert.deepEqual(PRESETS.map((p) => [p.label, p.deposit, p.modelId]), [
    ["a solo developer", 56_100, "anthropic/claude-sonnet-5"],
    ["an always-on agent", 14_000, "moonshotai/kimi-k2.6"],
    ["a 20-person team", 2_810_000, "anthropic/claude-sonnet-5"],
    ["our demo agent", null, "moonshotai/kimi-k2.6"],
  ]);
});
