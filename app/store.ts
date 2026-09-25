import { DatabaseSync } from "node:sqlite";

export type VaultRow = { vault: string; customer: string; label: string; period: number; frozen: boolean; yieldUsd: number };
export type KeyRow = { hash: string; vault: string; name: string; weight: number; baseline: number; usageTotal: number; toolSpent: number };
export type SettlementRow = { vault: string; usageMicro: string; tx: string; at: number };
export type Baseline = { hash: string; baseline: number };
/** A settlement sent on chain whose receipt has not yet been seen: its bookkeeping is still owed. */
export type PendingSettlement = { vault: string; usageMicro: bigint; baselines: Baseline[]; tx: string; createdAt: number };

const PENDING_TABLE = `
CREATE TABLE IF NOT EXISTS pending_settlements (
  vault TEXT PRIMARY KEY, usage_micro TEXT NOT NULL, baselines TEXT NOT NULL, tx TEXT NOT NULL, created_at INTEGER NOT NULL
);
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vaults (
  vault TEXT PRIMARY KEY, customer TEXT NOT NULL, label TEXT NOT NULL,
  period INTEGER NOT NULL DEFAULT 0, frozen INTEGER NOT NULL DEFAULT 0, yield_usd REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS keys (
  hash TEXT PRIMARY KEY, vault TEXT NOT NULL REFERENCES vaults(vault), name TEXT NOT NULL,
  weight REAL NOT NULL, secret_sha256 TEXT NOT NULL UNIQUE,
  baseline REAL NOT NULL DEFAULT 0, usage_total REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY, key_hash TEXT NOT NULL, api TEXT NOT NULL, path TEXT NOT NULL,
  price REAL NOT NULL, period INTEGER NOT NULL, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY, vault TEXT NOT NULL, usage_micro TEXT NOT NULL, tx TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
${PENDING_TABLE}`;

export const SCHEMA_VERSION = "2";

/** Brings an older database up to SCHEMA_VERSION. Returns the version it ends at. */
function migrate(db: DatabaseSync, from: string): string {
  if (from === "1") {
    db.exec(PENDING_TABLE);
    db.prepare("UPDATE meta SET v = ? WHERE k = ?").run("2", "schemaVersion");
    return "2";
  }
  return from;
}

const KEY_SELECT = `
SELECT k.hash, k.vault, k.name, k.weight, k.baseline, k.usage_total AS usageTotal,
  COALESCE((SELECT SUM(t.price) FROM tool_calls t WHERE t.key_hash = k.hash AND t.period = v.period), 0) AS toolSpent
FROM keys k JOIN vaults v ON v.vault = k.vault`;

const lc = (a: string) => a.toLowerCase();

export function openStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  const versionRow = db.prepare("SELECT v FROM meta WHERE k = ?").get("schemaVersion") as { v: string } | undefined;
  if (!versionRow) {
    db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run("schemaVersion", SCHEMA_VERSION);
  } else if (migrate(db, String(versionRow.v)) !== SCHEMA_VERSION) {
    throw new Error(`unsupported schema version ${versionRow.v}, expected ${SCHEMA_VERSION}`);
  }

  const toVault = (r: any): VaultRow => ({
    vault: r.vault, customer: r.customer, label: r.label, period: Number(r.period),
    frozen: Number(r.frozen) === 1, yieldUsd: Number(r.yield_usd),
  });
  const toKey = (r: any): KeyRow => ({
    hash: r.hash, vault: r.vault, name: r.name, weight: Number(r.weight), baseline: Number(r.baseline),
    usageTotal: Number(r.usageTotal), toolSpent: Math.round(Number(r.toolSpent) * 1e6) / 1e6,
  });

  const toPending = (r: any): PendingSettlement => ({
    vault: r.vault, usageMicro: BigInt(r.usage_micro), baselines: JSON.parse(r.baselines) as Baseline[],
    tx: r.tx, createdAt: Number(r.created_at),
  });

  /** Moves baselines and bumps the period. The caller owns the transaction. */
  function newPeriod(vault: string, baselines?: Baseline[]): void {
    db.prepare("UPDATE keys SET baseline = usage_total WHERE vault = ?").run(lc(vault));
    const set = db.prepare("UPDATE keys SET baseline = ? WHERE hash = ? AND vault = ?");
    for (const b of baselines ?? []) set.run(b.baseline, b.hash, lc(vault));
    db.prepare("UPDATE vaults SET period = period + 1 WHERE vault = ?").run(lc(vault));
  }

  function inTransaction<T>(fn: () => T): T {
    db.exec("BEGIN");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  const insertSettlement = (vault: string, usageMicro: bigint, tx: string) =>
    db.prepare("INSERT INTO settlements (vault, usage_micro, tx, at) VALUES (?, ?, ?, ?)").run(lc(vault), usageMicro.toString(), tx, Date.now());

  return {
    addVault(vault: string, customer: string, label: string): void {
      db.prepare("INSERT OR IGNORE INTO vaults (vault, customer, label) VALUES (?, ?, ?)").run(lc(vault), lc(customer), label);
    },
    vault(vault: string): VaultRow | undefined {
      const r = db.prepare("SELECT * FROM vaults WHERE vault = ?").get(lc(vault));
      return r ? toVault(r) : undefined;
    },
    listVaults(): VaultRow[] {
      return db.prepare("SELECT * FROM vaults ORDER BY vault").all().map(toVault);
    },
    setVaultState(vault: string, s: { frozen?: boolean; yieldUsd?: number }): void {
      if (s.frozen !== undefined) db.prepare("UPDATE vaults SET frozen = ? WHERE vault = ?").run(s.frozen ? 1 : 0, lc(vault));
      if (s.yieldUsd !== undefined) db.prepare("UPDATE vaults SET yield_usd = ? WHERE vault = ?").run(s.yieldUsd, lc(vault));
    },
    addKey(k: { hash: string; vault: string; name: string; weight: number; secretSha256: string }): void {
      db.prepare("INSERT INTO keys (hash, vault, name, weight, secret_sha256) VALUES (?, ?, ?, ?, ?)")
        .run(k.hash, lc(k.vault), k.name, k.weight, k.secretSha256);
    },
    setWeight(hash: string, weight: number): void {
      db.prepare("UPDATE keys SET weight = ? WHERE hash = ?").run(weight, hash);
    },
    setUsage(hash: string, usageTotal: number): void {
      db.prepare("UPDATE keys SET usage_total = ? WHERE hash = ?").run(usageTotal, hash);
    },
    keysForVault(vault: string): KeyRow[] {
      return db.prepare(`${KEY_SELECT} WHERE k.vault = ? ORDER BY k.hash`).all(lc(vault)).map(toKey);
    },
    keyByHash(hash: string): KeyRow | undefined {
      const r = db.prepare(`${KEY_SELECT} WHERE k.hash = ?`).get(hash);
      return r ? toKey(r) : undefined;
    },
    keyBySecret(sha256: string): KeyRow | undefined {
      const r = db.prepare(`${KEY_SELECT} WHERE k.secret_sha256 = ?`).get(sha256);
      return r ? toKey(r) : undefined;
    },
    recordToolCall(keyHash: string, api: string, path: string, priceUsd: number): void {
      const r = db.prepare(`INSERT INTO tool_calls (key_hash, api, path, price, period, at)
        SELECT ?, ?, ?, ?, v.period, ? FROM keys k JOIN vaults v ON v.vault = k.vault WHERE k.hash = ?`)
        .run(keyHash, api, path, priceUsd, Date.now(), keyHash);
      if (Number(r.changes) === 0) throw new Error(`unknown key ${keyHash}`);
    },
    /** Opens the next period. Listed keys take the given baseline; the rest take their current usage. */
    startNewPeriod(vault: string, baselines?: Baseline[]): void {
      inTransaction(() => newPeriod(vault, baselines));
    },
    recordSettlement(vault: string, usageMicro: bigint, tx: string): void {
      insertSettlement(vault, usageMicro, tx);
    },
    setPendingSettlement(vault: string, p: { usageMicro: bigint; baselines: Baseline[]; tx: string; createdAt?: number }): void {
      db.prepare(`INSERT INTO pending_settlements (vault, usage_micro, baselines, tx, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(vault) DO UPDATE SET usage_micro = excluded.usage_micro, baselines = excluded.baselines,
          tx = excluded.tx, created_at = excluded.created_at`)
        .run(lc(vault), p.usageMicro.toString(), JSON.stringify(p.baselines), p.tx, p.createdAt ?? Date.now());
    },
    pendingSettlement(vault: string): PendingSettlement | undefined {
      const r = db.prepare("SELECT * FROM pending_settlements WHERE vault = ?").get(lc(vault));
      return r ? toPending(r) : undefined;
    },
    listPendingSettlements(): PendingSettlement[] {
      return db.prepare("SELECT * FROM pending_settlements ORDER BY created_at, vault").all().map(toPending);
    },
    clearPendingSettlement(vault: string): void {
      db.prepare("DELETE FROM pending_settlements WHERE vault = ?").run(lc(vault));
    },
    /**
     * Applies a mined settlement's bookkeeping in one transaction: records it, moves the baselines to the
     * snapshot taken before sending, opens the next period and clears the pending row. Returns false, and
     * changes nothing, unless a pending row for exactly this vault and tx exists, so it applies at most once.
     */
    completePendingSettlement(vault: string, tx: string): boolean {
      return inTransaction(() => {
        const r = db.prepare("SELECT * FROM pending_settlements WHERE vault = ? AND tx = ?").get(lc(vault), tx);
        if (!r) return false;
        const p = toPending(r);
        insertSettlement(vault, p.usageMicro, p.tx);
        newPeriod(vault, p.baselines);
        db.prepare("DELETE FROM pending_settlements WHERE vault = ?").run(lc(vault));
        return true;
      });
    },
    listSettlements(): SettlementRow[] {
      return db.prepare("SELECT vault, usage_micro AS usageMicro, tx, at FROM settlements ORDER BY id DESC").all()
        .map((r: any) => ({ vault: r.vault, usageMicro: String(r.usageMicro), tx: r.tx, at: Number(r.at) }));
    },
    getMeta(k: string): string | undefined {
      const r: any = db.prepare("SELECT v FROM meta WHERE k = ?").get(k);
      return r ? String(r.v) : undefined;
    },
    setMeta(k: string, v: string): void {
      db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
    },
    close(): void {
      db.close();
    },
  };
}

export type Store = ReturnType<typeof openStore>;
