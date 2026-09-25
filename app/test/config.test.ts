import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";

function envFor(depChainId: number, chainChainId: number): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "inferest-config-"));
  const chainPath = join(dir, "chain.json");
  const depPath = join(dir, "deployments.json");
  writeFileSync(chainPath, JSON.stringify({ chainId: chainChainId, usdc: "0x01" }));
  writeFileSync(depPath, JSON.stringify({ chainId: depChainId, target: "0x02", factory: "0x03", splitter: "0x04" }));
  return {
    CHAIN_CONFIG: chainPath, DEPLOYMENTS: depPath, RPC_URL: "http://localhost:8545",
    KEEPER_PRIVATE_KEY: "0x05", OPENROUTER_MANAGEMENT_KEY: "or", ADMIN_TOKEN: "admin",
  };
}

test("loads when the deployments and chain config agree on the chain id", () => {
  const cfg = loadConfig(envFor(42161, 42161));
  assert.equal(cfg.chainId, 42161);
  assert.equal(cfg.splitter, "0x04");
});

test("throws when the deployments and chain config disagree on the chain id", () => {
  assert.throws(() => loadConfig(envFor(31337, 42161)), /chain id mismatch: deployments 31337 vs chain config 42161/);
});
