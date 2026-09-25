import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { openStore } from "../store.ts";

const V = "0xAbC0000000000000000000000000000000000001";

function fresh() {
  const s = openStore(":memory:");
  s.addVault(V, "0xC0FFEE000000000000000000000000000000000A", "Treasury");
  s.addKey({ hash: "h1", vault: V, name: "dev-1", weight: 1, secretSha256: "s1" });
  s.addKey({ hash: "h2", vault: V, name: "dev-2", weight: 2, secretSha256: "s2" });
  return s;
}

test("stores addresses lowercase and starts at period 0, unfrozen", () => {
  const s = fresh();
  const v = s.vault(V)!;
  assert.equal(v.vault, V.toLowerCase());
  assert.equal(v.period, 0);
  assert.equal(v.frozen, false);
  assert.equal(s.listVaults().length, 1);
});

test("keys carry weight, usage and this period's tool spend", () => {
  const s = fresh();
  s.setUsage("h1", 3.5);
  s.recordToolCall("h1", "olostep", "/v1/scrapes", 0.005);
  s.recordToolCall("h1", "olostep", "/v1/scrapes", 0.005);
  const k = s.keysForVault(V).find((k) => k.hash === "h1")!;
  assert.equal(k.usageTotal, 3.5);
  assert.equal(k.toolSpent, 0.01);
  assert.equal(s.keyBySecret("s2")!.hash, "h2");
});

test("a new period moves the baseline to current usage and clears tool spend", () => {
  const s = fresh();
  s.setUsage("h1", 3.5);
  s.recordToolCall("h1", "a", "/b", 1);
  s.startNewPeriod(V);
  const k = s.keyByHash("h1")!;
  assert.equal(k.baseline, 3.5);
  assert.equal(k.toolSpent, 0);
  assert.equal(s.vault(V)!.period, 1);
});

test("vault state, settlements and meta round-trip", () => {
  const s = fresh();
  s.setVaultState(V, { frozen: true, yieldUsd: 12.5 });
  assert.deepEqual([s.vault(V)!.frozen, s.vault(V)!.yieldUsd], [true, 12.5]);
  s.recordSettlement(V, 526_315_789n, "0xtx");
  assert.equal(s.listSettlements()[0].usageMicro, "526315789");
  s.setMeta("lastReport", "123");
  assert.equal(s.getMeta("lastReport"), "123");
  assert.equal(s.getMeta("missing"), undefined);
});

test("startNewPeriod accepts explicit baselines", () => {
  const s = fresh();
  s.setUsage("h1", 3.5);
  s.setUsage("h2", 1.25);
  s.startNewPeriod(V, [{ hash: "h1", baseline: 2 }]);
  assert.equal(s.keyByHash("h1")!.baseline, 2);
  assert.equal(s.keyByHash("h2")!.baseline, s.keyByHash("h2")!.usageTotal);
  assert.equal(s.vault(V)!.period, 1);
});

test("recordToolCall rejects an unknown key", () => {
  const s = fresh();
  assert.throws(() => s.recordToolCall("nope", "a", "/b", 1), /unknown key nope/);
});

test("a fresh store records schema version 1", () => {
  const s = fresh();
  assert.equal(s.getMeta("schemaVersion"), "1");
});

test("an unsupported schema version is refused", () => {
  const path = join(tmpdir(), `inferest-test-${process.pid}-${Date.now()}.db`);
  try {
    const s = openStore(path);
    s.setMeta("schemaVersion", "99");
    s.close();
    assert.throws(() => openStore(path), /unsupported schema version 99/);
  } finally {
    rmSync(path, { force: true });
  }
});
