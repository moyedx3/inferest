import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "../store.ts";

const V = "0xAbC0000000000000000000000000000000000001";

function fresh() {
  const s = openStore(":memory:");
  s.addVault(V, "0xC0FFEE000000000000000000000000000000000A", "Treasury");
  s.addKey({ id: "k1", vault: V, name: "dev-1", weight: 1, secretSha256: "s1" });
  s.addKey({ id: "k2", vault: V, name: "dev-2", weight: 2, secretSha256: "s2" });
  return s;
}

/** A database file as versions 1 and 2 of the app wrote it: keys by OpenRouter hash, no model_calls. */
function writeOldDb(path: string, version: "1" | "2") {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE vaults (vault TEXT PRIMARY KEY, customer TEXT NOT NULL, label TEXT NOT NULL,
      period INTEGER NOT NULL DEFAULT 0, frozen INTEGER NOT NULL DEFAULT 0, yield_usd REAL NOT NULL DEFAULT 0);
    CREATE TABLE keys (hash TEXT PRIMARY KEY, vault TEXT NOT NULL, name TEXT NOT NULL, weight REAL NOT NULL,
      secret_sha256 TEXT NOT NULL UNIQUE, baseline REAL NOT NULL DEFAULT 0, usage_total REAL NOT NULL DEFAULT 0);
    CREATE TABLE tool_calls (id INTEGER PRIMARY KEY, key_hash TEXT NOT NULL, api TEXT NOT NULL, path TEXT NOT NULL,
      price REAL NOT NULL, period INTEGER NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE settlements (id INTEGER PRIMARY KEY, vault TEXT NOT NULL, usage_micro TEXT NOT NULL, tx TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    INSERT INTO meta (k, v) VALUES ('schemaVersion', '${version}');
    INSERT INTO vaults (vault, customer, label, period, yield_usd) VALUES ('0xaa', '0xcc', 'T', 3, 12.5);
    INSERT INTO keys (hash, vault, name, weight, secret_sha256) VALUES ('h1', '0xaa', 'old', 1, 's1');
    INSERT INTO settlements (vault, usage_micro, tx, at) VALUES ('0xaa', '5', '0xold', 1);
  `);
  if (version === "2") {
    db.exec(`CREATE TABLE pending_settlements (vault TEXT PRIMARY KEY, usage_micro TEXT NOT NULL, baselines TEXT NOT NULL,
      tx TEXT NOT NULL, created_at INTEGER NOT NULL);`);
  }
  db.close();
}

test("stores addresses lowercase and starts at period 0, unfrozen, not settling", () => {
  const s = fresh();
  const v = s.vault(V)!;
  assert.equal(v.vault, V.toLowerCase());
  assert.equal(v.period, 0);
  assert.equal(v.frozen, false);
  assert.equal(v.settling, false);
  assert.equal(v.orKeyHash, null);
  assert.equal(v.orLimit, 0);
  assert.equal(s.listVaults().length, 1);
});

test("keys carry weight, this period's model and tool spend, and are found by secret hash", () => {
  const s = fresh();
  s.recordModelCall({ keyId: "k1", model: "m", costUsd: 0.5, generationId: "g1" });
  s.recordModelCall({ keyId: "k1", model: "m", costUsd: 0.25, generationId: "g2" });
  s.recordToolCall("k1", "olostep", "/v1/scrapes", 0.005);
  s.recordToolCall("k1", "olostep", "/v1/scrapes", 0.005);
  const k = s.keysForVault(V).find((k) => k.id === "k1")!;
  assert.equal(k.modelSpent, 0.75);
  assert.equal(k.toolSpent, 0.01);
  assert.equal(k.revoked, false);
  assert.ok(k.createdAt > 0);
  assert.equal(s.keyBySecret("s2")!.id, "k2");
  assert.equal(s.keyById("nope"), undefined);
  assert.deepEqual(s.spendForKey("k1"), { modelUsd: 0.75, toolUsd: 0.01 });
  assert.deepEqual(s.spendForKey("nope"), { modelUsd: 0, toolUsd: 0 });
  assert.deepEqual(s.spendForVault(V), { modelUsd: 0.75, toolUsd: 0.01 });
  const call = s.modelCall("g1")!;
  assert.equal(call.keyId, "k1");
  assert.equal(call.vault, V.toLowerCase());
  assert.equal(call.period, 0);
  assert.equal(call.costUsd, 0.5);
  assert.equal(call.status, "recorded");
});

test("recording a model call twice with the same generation id counts once", () => {
  const s = fresh();
  s.recordModelCall({ keyId: "k1", model: "m", costUsd: 0.5, generationId: "g1" });
  s.recordModelCall({ keyId: "k1", model: "m", costUsd: 0.5, generationId: "g1" });
  assert.equal(s.spendForKey("k1").modelUsd, 0.5);
  assert.equal(s.modelCall("g1")!.status, "recorded");
});

test("pending model calls count as zero until resolved, and resolve once", () => {
  const s = fresh();
  s.recordPendingModelCall({ keyId: "k1", model: "m", generationId: "g1" });
  assert.equal(s.spendForKey("k1").modelUsd, 0);
  assert.equal(s.listPendingModelCalls().length, 1);
  assert.equal(s.listPendingModelCalls()[0].generationId, "g1");
  assert.equal(s.listPendingModelCalls()[0].costUsd, null);
  assert.equal(s.resolveModelCall("g1", 0.3), true);
  assert.equal(s.resolveModelCall("g1", 0.9), false);
  assert.equal(s.spendForKey("k1").modelUsd, 0.3);
  assert.equal(s.listPendingModelCalls().length, 0);
  // a pending row that is later recorded directly is upgraded, not duplicated
  s.recordPendingModelCall({ keyId: "k1", model: "m", generationId: "g2" });
  s.recordModelCall({ keyId: "k1", model: "m", costUsd: 0.1, generationId: "g2" });
  assert.equal(s.spendForKey("k1").modelUsd, 0.4);
  // a recorded row is not demoted by a late pending write
  s.recordPendingModelCall({ keyId: "k1", model: "m", generationId: "g2" });
  assert.equal(s.modelCall("g2")!.status, "recorded");
  assert.equal(s.modelCall("g2")!.costUsd, 0.1);
});

test("model and tool calls reject an unknown key", () => {
  const s = fresh();
  assert.throws(() => s.recordToolCall("nope", "a", "/b", 1), /unknown key/);
  assert.throws(() => s.recordModelCall({ keyId: "nope", model: "m", costUsd: 1, generationId: "g" }), /unknown key/);
  assert.throws(() => s.recordPendingModelCall({ keyId: "nope", model: "m", generationId: "g" }), /unknown key/);
});

test("a new period is a bump: this period's spend starts at zero, history stays", () => {
  const s = fresh();
  s.recordModelCall({ keyId: "k1", model: "m", costUsd: 3.5, generationId: "g1" });
  s.recordToolCall("k1", "a", "/b", 1);
  s.startNewPeriod(V);
  const k = s.keyById("k1")!;
  assert.equal(k.modelSpent, 0);
  assert.equal(k.toolSpent, 0);
  assert.equal(s.vault(V)!.period, 1);
  assert.equal(s.totalModelCost(V), 3.5);
  s.recordModelCall({ keyId: "k1", model: "m", costUsd: 1, generationId: "g2" });
  assert.equal(s.modelCall("g2")!.period, 1);
  assert.equal(s.totalModelCost(V), 4.5);
});

test("rotate replaces the secret on the same row; revoke keeps the row and its spend", () => {
  const s = fresh();
  s.recordModelCall({ keyId: "k1", model: "m", costUsd: 1, generationId: "g1" });
  assert.equal(s.rotateKey("k1", "s1b"), true);
  assert.equal(s.keyBySecret("s1"), undefined);
  assert.equal(s.keyBySecret("s1b")!.id, "k1");
  assert.equal(s.revokeKey("k1"), true);
  assert.equal(s.revokeKey("nope"), false);
  assert.equal(s.rotateKey("nope", "x"), false);
  const k = s.keyBySecret("s1b")!;
  assert.equal(k.revoked, true);
  assert.equal(k.modelSpent, 1);
  assert.equal(s.keysForVault(V).length, 2);
  s.setWeight("k2", 5);
  assert.equal(s.keyById("k2")!.weight, 5);
});

test("the company OpenRouter key is filed per vault and never on the vault row", () => {
  const s = fresh();
  assert.equal(s.openRouterKeyFor(V), undefined);
  s.setVaultOpenRouterKey(V, "orhash", "v1.enc");
  assert.deepEqual(s.openRouterKeyFor(V), { hash: "orhash", encryptedSecret: "v1.enc" });
  assert.equal(s.vault(V)!.orKeyHash, "orhash");
  assert.ok(!JSON.stringify(s.vault(V)).includes("v1.enc"));
  assert.ok(!JSON.stringify(s.listVaults()).includes("v1.enc"));
  s.setVaultState(V, { orLimit: 12.5, orUsage: 2 });
  assert.equal(s.vault(V)!.orLimit, 12.5);
  assert.equal(s.vault(V)!.orUsage, 2);
});

test("vault state, settling flag, settlements and meta round-trip", () => {
  const s = fresh();
  s.setVaultState(V, { frozen: true, yieldUsd: 12.5 });
  s.setSettling(V, true);
  assert.equal(s.vault(V)!.frozen, true);
  assert.equal(s.vault(V)!.yieldUsd, 12.5);
  assert.equal(s.vault(V)!.settling, true);
  s.setSettling(V, false);
  assert.equal(s.vault(V)!.settling, false);
  s.recordSettlement(V, 1_500_000n, "0xtx");
  assert.deepEqual(s.listSettlements().map((r) => [r.vault, r.usageMicro, r.tx]), [[V.toLowerCase(), "1500000", "0xtx"]]);
  s.setMeta("lastReport", "5");
  assert.equal(s.getMeta("lastReport"), "5");
  assert.equal(s.getMeta("nope"), undefined);
});

test("a fresh store records schema version 3", () => {
  assert.equal(fresh().getMeta("schemaVersion"), "3");
});

test("pending settlements round-trip with the spend snapshot", () => {
  const s = fresh();
  assert.equal(s.pendingSettlement(V), undefined);
  const ok = s.setPendingSettlement(V, { usageMicro: 2_000_000n, baselines: [{ keyId: "k1", spentUsd: 1.5 }], tx: "0xtx", createdAt: 7 });
  assert.equal(ok, true);
  const p = s.pendingSettlement(V)!;
  assert.equal(p.usageMicro, 2_000_000n);
  assert.deepEqual(p.baselines, [{ keyId: "k1", spentUsd: 1.5 }]);
  assert.equal(p.tx, "0xtx");
  assert.equal(p.createdAt, 7);
  assert.equal(s.listPendingSettlements().length, 1);
});

test("clearing a pending settlement takes the vault out of settling, but only for its tx", () => {
  const s = fresh();
  s.setSettling(V, true);
  s.setPendingSettlement(V, { usageMicro: 1n, baselines: [], tx: "0xnew" });
  assert.equal(s.clearPendingSettlement(V, "0xold"), false);
  assert.equal(s.vault(V)!.settling, true);
  assert.equal(s.pendingSettlement(V)!.tx, "0xnew");
  assert.equal(s.clearPendingSettlement(V, "0xnew"), true);
  assert.equal(s.pendingSettlement(V), undefined);
  assert.equal(s.vault(V)!.settling, false);
});

test("setPendingSettlement does not overwrite an existing row and reports it", () => {
  const s = fresh();
  assert.equal(s.setPendingSettlement(V, { usageMicro: 1n, baselines: [], tx: "0xa" }), true);
  assert.equal(s.setPendingSettlement(V, { usageMicro: 2n, baselines: [], tx: "0xb" }), false);
  assert.equal(s.pendingSettlement(V)!.tx, "0xa");
});

test("completing a pending settlement applies it once, only for its tx, and clears settling", () => {
  const s = fresh();
  s.recordModelCall({ keyId: "k1", model: "m", costUsd: 2, generationId: "g1" });
  s.setSettling(V, true);
  s.setPendingSettlement(V, { usageMicro: 2_000_000n, baselines: [{ keyId: "k1", spentUsd: 2 }], tx: "0xtx", createdAt: 7 });
  assert.equal(s.completePendingSettlement(V, "0xother", "2026-11"), false);
  assert.equal(s.completePendingSettlement(V, "0xtx", "2026-11"), true);
  assert.equal(s.completePendingSettlement(V, "0xtx", "2026-11"), false);
  assert.equal(s.listSettlements().length, 1);
  assert.equal(s.listSettlements()[0].usageMicro, "2000000");
  assert.equal(s.vault(V)!.period, 1);
  assert.equal(s.vault(V)!.settling, false);
  assert.equal(s.keyById("k1")!.modelSpent, 0);
  assert.equal(s.pendingSettlement(V), undefined);
  assert.equal(s.getMeta(`settledMonth:${V.toLowerCase()}`), "2026-11");
});

for (const version of ["1", "2"] as const) {
  test(`a version ${version} database migrates to version 3, keeping vaults and settlements`, () => {
    const path = join(tmpdir(), `inferest-test-migrate${version}-${process.pid}-${Date.now()}.db`);
    try {
      writeOldDb(path, version);
      const s = openStore(path);
      assert.equal(s.getMeta("schemaVersion"), "3");
      const v = s.vault("0xaa")!;
      assert.equal(v.period, 3);
      assert.equal(v.yieldUsd, 12.5);
      assert.equal(v.settling, false);
      assert.equal(v.orKeyHash, null);
      assert.equal(s.listSettlements().length, 1);
      assert.equal(s.keysForVault("0xaa").length, 0);
      assert.deepEqual(s.listPendingSettlements(), []);
      s.addKey({ id: "k1", vault: "0xaa", name: "new", weight: 1, secretSha256: "s1" });
      s.recordModelCall({ keyId: "k1", model: "m", costUsd: 1, generationId: "g" });
      assert.equal(s.keyById("k1")!.modelSpent, 1);
      s.close();
      assert.equal(openStore(path).getMeta("schemaVersion"), "3"); // a second open is a no-op
    } finally {
      rmSync(path, { force: true });
    }
  });
}

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
