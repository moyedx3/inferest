import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";

function envFor(depChainId: number, chainChainId: number, depTarget = "0x02", chainTarget = "0x02"): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "inferest-config-"));
  const chainPath = join(dir, "chain.json");
  const depPath = join(dir, "deployments.json");
  writeFileSync(chainPath, JSON.stringify({ chainId: chainChainId, usdc: "0x01", target: chainTarget }));
  writeFileSync(depPath, JSON.stringify({ chainId: depChainId, target: depTarget, factory: "0x03", splitter: "0x04" }));
  return {
    CHAIN_CONFIG: chainPath, DEPLOYMENTS: depPath, RPC_URL: "http://localhost:8545",
    KEEPER_PRIVATE_KEY: "0x05", OPENROUTER_MANAGEMENT_KEY: "or", ADMIN_TOKEN: "admin",
    KEY_ENCRYPTION_KEY: "ab".repeat(32), PORT: "8787",
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

test("throws when the deployments target differs from the chain config target", () => {
  assert.throws(() => loadConfig(envFor(42161, 42161, "0x02", "0x09")), /target mismatch: deployments 0x02 vs chain config 0x09/);
});

test("compares targets case-insensitively", () => {
  assert.equal(loadConfig(envFor(42161, 42161, "0xAB", "0xab")).target, "0xAB");
});

test("refuses to start without a key encryption key", () => {
  const env = envFor(42161, 42161);
  delete env.KEY_ENCRYPTION_KEY;
  assert.throws(() => loadConfig(env), /missing env KEY_ENCRYPTION_KEY/);
});

test("refuses a key encryption key that is not 64 hex characters", () => {
  assert.throws(() => loadConfig({ ...envFor(42161, 42161), KEY_ENCRYPTION_KEY: "abc" }), /64 hex/);
});

test("public url defaults to localhost on the port", () => {
  assert.equal(loadConfig(envFor(42161, 42161)).publicUrl, "http://localhost:8787");
  assert.equal(loadConfig({ ...envFor(42161, 42161), PUBLIC_URL: "https://inferest.example/" }).publicUrl, "https://inferest.example");
});

test("login, public rpc and faucet are off unless configured", () => {
  const cfg = loadConfig(envFor(42161, 42161));
  assert.equal(cfg.dynamicEnvironmentId, undefined);
  assert.equal(cfg.publicRpcUrl, undefined);
  assert.equal(cfg.demoFaucet, false);
  assert.equal(cfg.chainName, "chain 42161");
  assert.deepEqual(cfg.nativeCurrency, { name: "Ether", symbol: "ETH", decimals: 18 });
});

test("login, public rpc and faucet come from the environment", () => {
  const cfg = loadConfig({ ...envFor(42161, 42161), DYNAMIC_ENVIRONMENT_ID: "env-1", PUBLIC_RPC_URL: "http://127.0.0.1:8545/", DEMO_FAUCET: "1" });
  assert.equal(cfg.dynamicEnvironmentId, "env-1");
  assert.equal(cfg.publicRpcUrl, "http://127.0.0.1:8545");
  assert.equal(cfg.demoFaucet, true);
  assert.equal(loadConfig({ ...envFor(42161, 42161), DEMO_FAUCET: "true" }).demoFaucet, false);
});

test("targets default to the single target and its name", () => {
  const env = envFor(42161, 42161);
  const cfg = loadConfig(env);
  assert.deepEqual(cfg.targets, [{ address: "0x02", name: "yield source" }]);
});

test("targets come from the chain config and must all be in the deployment's list", () => {
  const dir = mkdtempSync(join(tmpdir(), "inferest-config-"));
  const chainPath = join(dir, "chain.json");
  const depPath = join(dir, "deployments.json");
  writeFileSync(chainPath, JSON.stringify({
    chainId: 1, usdc: "0x01", target: "0x02", targetName: "A",
    targets: [{ address: "0x02", name: "A" }, { address: "0x06", name: "B" }],
  }));
  writeFileSync(depPath, JSON.stringify({ chainId: 1, target: "0x02", targets: ["0x02", "0x06"], factory: "0x03", splitter: "0x04" }));
  const env = { ...envFor(1, 1), CHAIN_CONFIG: chainPath, DEPLOYMENTS: depPath };
  assert.deepEqual(loadConfig(env).targets.map((t) => t.address), ["0x02", "0x06"]);
  writeFileSync(depPath, JSON.stringify({ chainId: 1, target: "0x02", targets: ["0x02"], factory: "0x03", splitter: "0x04" }));
  assert.throws(() => loadConfig(env), /target 0x06 is not allowlisted in the deployment/);
});

test("the optional OpenRouter total limit must be finite and nonnegative", () => {
  const env = envFor(42161, 42161);
  assert.equal(loadConfig(env).openRouterTotalLimitUsd, undefined);
  assert.equal(loadConfig({ ...env, OPENROUTER_TOTAL_LIMIT_USD: "" }).openRouterTotalLimitUsd, undefined);
  for (const value of ["0", "0.9"]) {
    assert.equal(loadConfig({ ...env, OPENROUTER_TOTAL_LIMIT_USD: value }).openRouterTotalLimitUsd, Number(value));
  }
  for (const value of ["-1", "NaN", "Infinity", "abc"]) {
    assert.throws(() => loadConfig({ ...env, OPENROUTER_TOTAL_LIMIT_USD: value }), /OPENROUTER_TOTAL_LIMIT_USD/);
  }
});


test("pilot admission and automatic transactions are optional and validated", () => {
  const env = envFor(42161, 42161);
  assert.equal(loadConfig(env).pilotCustomerAddress, undefined);
  assert.equal(loadConfig(env).keeperAutomaticTransactions, true);
  const address = "0x" + "ab".repeat(20);
  assert.equal(loadConfig({ ...env, PILOT_CUSTOMER_ADDRESS: address }).pilotCustomerAddress, address);
  assert.equal(loadConfig({ ...env, KEEPER_AUTOMATIC_TRANSACTIONS: "false" }).keeperAutomaticTransactions, false);
  for (const value of ["0x123", "arbitrary", "0x" + "zz".repeat(20)]) {
    assert.throws(() => loadConfig({ ...env, PILOT_CUSTOMER_ADDRESS: value }), /PILOT_CUSTOMER_ADDRESS/);
  }
  assert.throws(() => loadConfig({ ...env, KEEPER_AUTOMATIC_TRANSACTIONS: "no" }), /KEEPER_AUTOMATIC_TRANSACTIONS/);
});

test("keeper ETH bounds parse exactly to wei and reject invalid or excessive precision", () => {
  const env = envFor(42161, 42161);
  assert.equal(loadConfig(env).keeperMinBalanceWei, undefined);
  assert.equal(loadConfig(env).keeperMaxTxCostWei, undefined);
  for (const [name, field] of [["KEEPER_MIN_BALANCE_ETH", "keeperMinBalanceWei"], ["KEEPER_MAX_TX_COST_ETH", "keeperMaxTxCostWei"]] as const) {
    assert.equal(loadConfig({ ...env, [name]: "0.001000000000000001" })[field], 1_000_000_000_000_001n);
    assert.equal(loadConfig({ ...env, [name]: "0" })[field], 0n);
    for (const value of ["-1", "NaN", "Infinity", "1e-3", "0.0000000000000000001"]) {
      assert.throws(() => loadConfig({ ...env, [name]: value }), new RegExp(name));
    }
  }
});

test("DEMO_FAUCET=1 keeps the fork's cheat faucet and needs nothing else", () => {
  const cfg = loadConfig({ ...envFor(42161, 42161), DEMO_FAUCET: "1" });
  assert.equal(cfg.demoFaucet, true);
  assert.equal(cfg.faucetMode, "cheat");
  assert.equal(cfg.faucetKey, undefined);
  assert.equal(cfg.demoFund, undefined);
  assert.equal(loadConfig(envFor(42161, 42161)).faucetMode, undefined);
});

test("DEMO_FAUCET=mint needs the chain config's demo block and a faucet key of its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "inferest-config-"));
  const chainPath = join(dir, "chain.json");
  const depPath = join(dir, "deployments.json");
  const target = "0x" + "02".repeat(20);
  const faucetKey = "0x" + "07".repeat(32); // synthetic, never funded
  const write = (demo: unknown) => writeFileSync(chainPath, JSON.stringify({
    chainId: 10143, usdc: "0x01", target, targets: [{ address: target, name: "Demo" }], demo,
  }));
  writeFileSync(depPath, JSON.stringify({ chainId: 10143, target, targets: [target], factory: "0x03", splitter: "0x04" }));
  const env = { ...envFor(10143, 10143), CHAIN_CONFIG: chainPath, DEPLOYMENTS: depPath, DEMO_FAUCET: "mint", DEMO_FAUCET_PRIVATE_KEY: faucetKey };

  write(undefined);
  assert.throws(() => loadConfig(env), /DEMO_FAUCET=mint needs demo.fundNative and demo.warpTargets in the chain config/);

  write({ fundNative: "0.5", warpTargets: [target] });
  const cfg = loadConfig(env);
  assert.equal(cfg.demoFaucet, true);
  assert.equal(cfg.faucetMode, "mint");
  assert.equal(cfg.faucetKey, faucetKey);
  assert.deepEqual(cfg.demoFund, { nativeWei: 500_000_000_000_000_000n, warpTargets: [target] });
  assert.throws(() => loadConfig({ ...env, DEMO_FAUCET_PRIVATE_KEY: "" }), /missing env DEMO_FAUCET_PRIVATE_KEY/);
  assert.throws(() => loadConfig({ ...env, DEMO_FAUCET_PRIVATE_KEY: "0x05" }), /DEMO_FAUCET_PRIVATE_KEY must be 32 bytes/);
  assert.throws(() => loadConfig({ ...env, KEEPER_PRIVATE_KEY: faucetKey }), /DEMO_FAUCET_PRIVATE_KEY must not be the keeper's key/);

  write({ fundNative: "abc", warpTargets: [target] });
  assert.throws(() => loadConfig(env), /demo.fundNative must be a nonnegative amount/);
  write({ fundNative: "0.5", warpTargets: ["0x" + "09".repeat(20)] });
  assert.throws(() => loadConfig(env), /is not one of the chain config's targets/);
  write({ fundNative: "0.5", warpTargets: ["nope"] });
  assert.throws(() => loadConfig(env), /demo.warpTargets entry nope must be one 20-byte hex address/);
  write({ fundNative: "0.5", warpTargets: [] });
  assert.throws(() => loadConfig(env), /demo.warpTargets must name at least one yield source/);
  write({ fundNative: "0.5", warpTargets: [target.toUpperCase().replace("0X", "0x")] });
  assert.deepEqual(loadConfig(env).demoFund?.warpTargets, [target]);
});

test("CHAIN_SITES lists the instances a visitor can switch to, without trailing slashes", () => {
  const cfg = loadConfig({ ...envFor(42161, 42161), CHAIN_SITES: "Arbitrum One|https://a.example/, Monad|https://m.example" });
  assert.deepEqual(cfg.sites, [{ name: "Arbitrum One", url: "https://a.example" }, { name: "Monad", url: "https://m.example" }]);
});

test("CHAIN_SITES is an empty list when unset or blank", () => {
  assert.deepEqual(loadConfig(envFor(42161, 42161)).sites, []);
  assert.deepEqual(loadConfig({ ...envFor(42161, 42161), CHAIN_SITES: "  " }).sites, []);
});

test("CHAIN_SITES rejects an entry without a url", () => {
  assert.throws(() => loadConfig({ ...envFor(42161, 42161), CHAIN_SITES: "Monad" }), /CHAIN_SITES entry Monad must be name\|url/);
});

test("CHAIN_SITES rejects an empty name and a url that is not http", () => {
  assert.throws(() => loadConfig({ ...envFor(42161, 42161), CHAIN_SITES: "|https://m.example" }), /names must not be empty/);
  assert.throws(() => loadConfig({ ...envFor(42161, 42161), CHAIN_SITES: "Monad|ftp://m.example" }), /must start with http/);
});

test("CHAIN_SITES skips empty entries and rejects a url with a query, a fragment or a pipe", () => {
  assert.deepEqual(loadConfig({ ...envFor(42161, 42161), CHAIN_SITES: "Monad|https://m.example,," }).sites, [{ name: "Monad", url: "https://m.example" }]);
  for (const bad of ["Monad|https://m.example/?x=1", "Monad|https://m.example/#top", "Monad|https://m.example|extra"]) {
    assert.throws(() => loadConfig({ ...envFor(42161, 42161), CHAIN_SITES: bad }), /must not hold a query, a fragment, a pipe or spaces/);
  }
});
