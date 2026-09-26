import { DatabaseSync } from "node:sqlite";

export type VaultRow = {
  vault: string; customer: string; label: string; period: number; frozen: boolean; yieldUsd: number;
  /** set while a settlement is in progress; the proxy refuses new requests for the vault */
  settling: boolean;
  /** epoch ms the settling flag was set, 0 while open; lets a flag left by a crash be told apart from a fresh one */
  settlingSince: number;
  /** the company's OpenRouter key on the Management API (an identifier, not a secret) and its last synced limit and usage */
  orKeyHash: string | null; orLimit: number; orUsage: number;
};
export type KeyRow = {
  id: string; vault: string; name: string; weight: number; createdAt: number; revoked: boolean;
  /** this period's recorded model cost (USD) and paid tool spend (USDC) */
  modelSpent: number; toolSpent: number;
};
export type SettlementRow = { vault: string; usageMicro: string; tx: string; at: number };
/** What each key had spent when a settlement was signed, kept with the pending row for the record. */
export type SpendSnapshot = { keyId: string; spentUsd: number };
/** A settlement sent on chain whose receipt has not yet been seen: its bookkeeping is still owed. */
export type PendingSettlement = {
  vault: string; usageMicro: bigint; baselines: SpendSnapshot[]; tx: string; createdAt: number;
  /** The highest model_calls and tool_calls ids at snapshot time: a call with a higher id is billed next period.
   *  Null when unknown (a row written before version 4), in which case nothing is moved. */
  modelCallId: number | null; toolCallId: number | null;
};
export type ModelCallStatus = "recorded" | "pending";
export type ModelCallRow = {
  id: number; keyId: string; vault: string; period: number; model: string; costUsd: number | null;
  generationId: string; status: ModelCallStatus; at: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vaults (
  vault TEXT PRIMARY KEY, customer TEXT NOT NULL, label TEXT NOT NULL,
  period INTEGER NOT NULL DEFAULT 0, frozen INTEGER NOT NULL DEFAULT 0, yield_usd REAL NOT NULL DEFAULT 0,
  settling INTEGER NOT NULL DEFAULT 0, or_key_hash TEXT, or_key_secret TEXT,
  or_limit REAL NOT NULL DEFAULT 0, or_usage REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS keys (
  id TEXT PRIMARY KEY, vault TEXT NOT NULL REFERENCES vaults(vault), name TEXT NOT NULL,
  weight REAL NOT NULL, secret_sha256 TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY, key_id TEXT NOT NULL, api TEXT NOT NULL, path TEXT NOT NULL,
  price REAL NOT NULL, period INTEGER NOT NULL, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS model_calls (
  id INTEGER PRIMARY KEY, key_id TEXT NOT NULL, vault TEXT NOT NULL, period INTEGER NOT NULL,
  model TEXT NOT NULL, cost_usd REAL, generation_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS model_calls_key_period ON model_calls(key_id, period, status);
CREATE INDEX IF NOT EXISTS tool_calls_key_period ON tool_calls(key_id, period);
CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY, vault TEXT NOT NULL, usage_micro TEXT NOT NULL, tx TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pending_settlements (
  vault TEXT PRIMARY KEY, usage_micro TEXT NOT NULL, baselines TEXT NOT NULL, tx TEXT NOT NULL, created_at INTEGER NOT NULL,
  model_call_id INTEGER, tool_call_id INTEGER
);
`;

export const SCHEMA_VERSION = "4";

/** Brings an older database up to SCHEMA_VERSION. Returns the version it ends at. Runs as one transaction, so a crash midway leaves the file at its starting version instead of half migrated. */
function migrate(db: DatabaseSync, from: string, log: (msg: string) => void): string {
  if (from === SCHEMA_VERSION) return from;
  db.exec("BEGIN");
  try {
    let at = from;
    // version 2 only added pending_settlements; a version 1 file has none, and the SCHEMA run inside the 2 -> 3
    // step below creates it
    if (at === "1") at = "2";
    if (at === "2") {
      // Version 3 files keys under our own ids and meters spend in our own rows. The old keys, tool_calls and
      // pending_settlements rows were keyed by OpenRouter hashes that mean nothing now; they came from demos and
      // are dropped. Vault rows and the settlement history survive, with the new vault columns added.
      const exists = (table: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
      const count = (table: string) => (exists(table) ? Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c) : 0);
      if (exists("pending_settlements")) {
        for (const r of db.prepare("SELECT vault, tx FROM pending_settlements ORDER BY created_at, vault").all() as { vault: string; tx: string }[]) {
          log(`migration: dropping the version 2 pending settlement ${r.tx} for ${r.vault}; it cannot be reconciled by this version`);
        }
      }
      log(`migration: ${count("keys")} keys and ${count("tool_calls")} tool call rows from version 2 dropped`);
      db.exec("DROP TABLE IF EXISTS keys; DROP TABLE IF EXISTS tool_calls; DROP TABLE IF EXISTS pending_settlements;");
      const cols = ["settling INTEGER NOT NULL DEFAULT 0", "or_key_hash TEXT", "or_key_secret TEXT",
        "or_limit REAL NOT NULL DEFAULT 0", "or_usage REAL NOT NULL DEFAULT 0"];
      for (const col of cols) db.exec(`ALTER TABLE vaults ADD COLUMN ${col}`);
      db.exec(SCHEMA);
      at = "3";
    }
    if (at === "3") {
      // Version 4 records on each pending settlement the last call ids its snapshot saw. The 2 -> 3 step above
      // recreates the table from SCHEMA with the columns already there, hence the check.
      const have = new Set((db.prepare("PRAGMA table_info(pending_settlements)").all() as { name: string }[]).map((c) => c.name));
      for (const col of ["model_call_id", "tool_call_id"]) {
        if (!have.has(col)) db.exec(`ALTER TABLE pending_settlements ADD COLUMN ${col} INTEGER`);
      }
      at = "4";
    }
    if (at !== from) db.prepare("UPDATE meta SET v = ? WHERE k = ?").run(at, "schemaVersion");
    db.exec("COMMIT");
    return at;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

const KEY_SELECT = `
SELECT k.id, k.vault, k.name, k.weight, k.created_at AS createdAt, k.revoked_at AS revokedAt,
  COALESCE((SELECT SUM(m.cost_usd) FROM model_calls m WHERE m.key_id = k.id AND m.period = v.period AND m.status = 'recorded'), 0) AS modelSpent,
  COALESCE((SELECT SUM(t.price) FROM tool_calls t WHERE t.key_id = k.id AND t.period = v.period), 0) AS toolSpent
FROM keys k JOIN vaults v ON v.vault = k.vault`;

const lc = (a: string) => a.toLowerCase();
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** The meta key holding the last month a vault was settled for. */
export const settledMonthKey = (vault: string): string => `settledMonth:${lc(vault)}`;

/** The meta key holding when the keeper last synced a vault. */
const syncedAtKey = (vault: string): string => `syncedAt:${lc(vault)}`;

export function openStore(path: string, opts: { log?: (msg: string) => void } = {}) {
  const db = new DatabaseSync(path);
  // Bootstrap only `meta` first: an old (pre-3) database already has `keys` and `tool_calls` under their old
  // column names, and SCHEMA now indexes those tables by their new columns. Running the full SCHEMA before
  // migrate() has a chance to drop and recreate those tables would fail with "no such column". `meta` itself
  // is unchanged since version 1, so creating it alone is always safe to check the version by.
  db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);");

  const versionRow = db.prepare("SELECT v FROM meta WHERE k = ?").get("schemaVersion") as { v: string } | undefined;
  if (!versionRow) {
    db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run("schemaVersion", SCHEMA_VERSION);
  } else {
    // whatever goes wrong inside migrate(), the handle is released before the error reaches the caller
    let migrated: string;
    try {
      migrated = migrate(db, String(versionRow.v), opts.log ?? (() => {}));
    } catch (e) {
      db.close();
      throw e;
    }
    if (migrated !== SCHEMA_VERSION) {
      db.close();
      throw new Error(`unsupported schema version ${versionRow.v}, expected ${SCHEMA_VERSION}`);
    }
  }
  // Safe now: a fresh database has no conflicting tables, and a migrated one has already been brought current.
  db.exec(SCHEMA);

  const toVault = (r: any): VaultRow => ({
    vault: r.vault, customer: r.customer, label: r.label, period: Number(r.period),
    frozen: Number(r.frozen) === 1, yieldUsd: Number(r.yield_usd), settling: Number(r.settling) > 0,
    settlingSince: Number(r.settling),
    orKeyHash: r.or_key_hash ?? null, orLimit: Number(r.or_limit), orUsage: Number(r.or_usage),
  });
  const toKey = (r: any): KeyRow => ({
    id: r.id, vault: r.vault, name: r.name, weight: Number(r.weight), createdAt: Number(r.createdAt),
    revoked: r.revokedAt !== null && r.revokedAt !== undefined,
    modelSpent: round6(Number(r.modelSpent)), toolSpent: round6(Number(r.toolSpent)),
  });
  const toPending = (r: any): PendingSettlement => ({
    vault: r.vault, usageMicro: BigInt(r.usage_micro), baselines: JSON.parse(r.baselines) as SpendSnapshot[],
    tx: r.tx, createdAt: Number(r.created_at),
    modelCallId: r.model_call_id === null || r.model_call_id === undefined ? null : Number(r.model_call_id),
    toolCallId: r.tool_call_id === null || r.tool_call_id === undefined ? null : Number(r.tool_call_id),
  });
  const toModelCall = (r: any): ModelCallRow => ({
    id: Number(r.id), keyId: r.key_id, vault: r.vault, period: Number(r.period), model: r.model,
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd), generationId: r.generation_id,
    status: r.status as ModelCallStatus, at: Number(r.at),
  });

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
  const requireKey = (id: string): void => {
    if (!db.prepare("SELECT 1 FROM keys WHERE id = ?").get(id)) throw new Error(`unknown key ${id}`);
  };
  const keysForVault = (vault: string): KeyRow[] =>
    db.prepare(`${KEY_SELECT} WHERE k.vault = ? ORDER BY k.created_at, k.id`).all(lc(vault)).map(toKey);
  const keyById = (id: string): KeyRow | undefined => {
    const r = db.prepare(`${KEY_SELECT} WHERE k.id = ?`).get(id);
    return r ? toKey(r) : undefined;
  };
  // the insert selects through the key's vault row, so a key whose vault row is missing inserts nothing
  const requireInserted = (c: { keyId: string; generationId: string }): void => {
    if (db.prepare("SELECT 1 FROM model_calls WHERE generation_id = ?").get(c.generationId) === undefined) {
      throw new Error(`unknown vault for key ${c.keyId}`);
    }
  };
  const MODEL_CALL_INSERT = `INSERT INTO model_calls (key_id, vault, period, model, cost_usd, generation_id, status, at)
    SELECT k.id, k.vault, v.period, ?, ?, ?, ?, ? FROM keys k JOIN vaults v ON v.vault = k.vault WHERE k.id = ?`;

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
    setVaultState(vault: string, s: { frozen?: boolean; yieldUsd?: number; orLimit?: number; orUsage?: number }): void {
      if (s.frozen !== undefined) db.prepare("UPDATE vaults SET frozen = ? WHERE vault = ?").run(s.frozen ? 1 : 0, lc(vault));
      if (s.yieldUsd !== undefined) db.prepare("UPDATE vaults SET yield_usd = ? WHERE vault = ?").run(s.yieldUsd, lc(vault));
      if (s.orLimit !== undefined) db.prepare("UPDATE vaults SET or_limit = ? WHERE vault = ?").run(s.orLimit, lc(vault));
      if (s.orUsage !== undefined) db.prepare("UPDATE vaults SET or_usage = ? WHERE vault = ?").run(s.orUsage, lc(vault));
    },
    /** The settling flag doubles as its own timestamp: `now` while set, 0 while open, so a sync can tell an old
     *  flag left by a crash apart from a fresh one another process just set. */
    setSettling(vault: string, settling: boolean, now: number = Date.now()): void {
      db.prepare("UPDATE vaults SET settling = ? WHERE vault = ?").run(settling ? now : 0, lc(vault));
    },
    /** Files the company's OpenRouter key: its hash for the Management API and its secret, encrypted by the caller. */
    setVaultOpenRouterKey(vault: string, hash: string, encryptedSecret: string): void {
      db.prepare("UPDATE vaults SET or_key_hash = ?, or_key_secret = ? WHERE vault = ?").run(hash, encryptedSecret, lc(vault));
    },
    /** The company's OpenRouter key with its secret still encrypted. Never send this to a client. */
    openRouterKeyFor(vault: string): { hash: string; encryptedSecret: string } | undefined {
      const r: any = db.prepare("SELECT or_key_hash, or_key_secret FROM vaults WHERE vault = ?").get(lc(vault));
      return r && r.or_key_hash && r.or_key_secret ? { hash: String(r.or_key_hash), encryptedSecret: String(r.or_key_secret) } : undefined;
    },
    addKey(k: { id: string; vault: string; name: string; weight: number; secretSha256: string }, now: number = Date.now()): void {
      db.prepare("INSERT INTO keys (id, vault, name, weight, secret_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(k.id, lc(k.vault), k.name, k.weight, k.secretSha256, now);
    },
    setWeight(id: string, weight: number): void {
      db.prepare("UPDATE keys SET weight = ? WHERE id = ?").run(weight, id);
    },
    /** Replaces the secret on the same row, so budget and history stay with the developer. A revoked row is never rotated. */
    rotateKey(id: string, secretSha256: string): boolean {
      return Number(db.prepare("UPDATE keys SET secret_sha256 = ? WHERE id = ? AND revoked_at IS NULL").run(secretSha256, id).changes) > 0;
    },
    revokeKey(id: string, now: number = Date.now()): boolean {
      return Number(db.prepare("UPDATE keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id).changes) > 0;
    },
    keysForVault,
    keyById,
    keyBySecret(sha256: string): KeyRow | undefined {
      const r = db.prepare(`${KEY_SELECT} WHERE k.secret_sha256 = ?`).get(sha256);
      return r ? toKey(r) : undefined;
    },
    recordToolCall(keyId: string, api: string, path: string, priceUsd: number): void {
      const r = db.prepare(`INSERT INTO tool_calls (key_id, api, path, price, period, at)
        SELECT ?, ?, ?, ?, v.period, ? FROM keys k JOIN vaults v ON v.vault = k.vault WHERE k.id = ?`)
        .run(keyId, api, path, priceUsd, Date.now(), keyId);
      if (Number(r.changes) === 0) throw new Error(`unknown key ${keyId}`);
    },
    /** Records a metered call. Idempotent on generation id: a repeat is ignored, a pending row is upgraded. */
    recordModelCall(c: { keyId: string; model: string; costUsd: number; generationId: string }, now: number = Date.now()): void {
      requireKey(c.keyId);
      db.prepare(`${MODEL_CALL_INSERT}
        ON CONFLICT(generation_id) DO UPDATE SET cost_usd = excluded.cost_usd, status = 'recorded' WHERE model_calls.status = 'pending'`)
        .run(c.model, c.costUsd, c.generationId, "recorded", now, c.keyId);
      requireInserted(c);
    },
    /** A call whose cost did not arrive; the keeper resolves it through OpenRouter's generation lookup. */
    recordPendingModelCall(c: { keyId: string; model: string; generationId: string }, now: number = Date.now()): void {
      requireKey(c.keyId);
      db.prepare(`${MODEL_CALL_INSERT} ON CONFLICT(generation_id) DO NOTHING`)
        .run(c.model, null, c.generationId, "pending", now, c.keyId);
      requireInserted(c);
    },
    /**
     * Resolves a pending call once its cost is known. If the vault has already moved past the call's period
     * (a late resolution, after that period settled), the row is stamped with the vault's current period
     * instead, so the cost is billed in the period in which it resolves rather than lost to an already-closed one.
     */
    resolveModelCall(generationId: string, costUsd: number): boolean {
      const r = db.prepare(`UPDATE model_calls SET cost_usd = ?, status = 'recorded',
        period = MAX(period, COALESCE((SELECT v.period FROM vaults v WHERE v.vault = model_calls.vault), period))
        WHERE generation_id = ? AND status = 'pending'`)
        .run(costUsd, generationId);
      return Number(r.changes) > 0;
    },
    listPendingModelCalls(): ModelCallRow[] {
      return db.prepare("SELECT * FROM model_calls WHERE status = 'pending' ORDER BY at, id").all().map(toModelCall);
    },
    /** How many of the vault's model calls are still pending a cost from the keeper's generation lookup. */
    pendingModelCalls(vault: string): number {
      const r: any = db.prepare("SELECT COUNT(*) AS c FROM model_calls WHERE vault = ? AND status = 'pending'").get(lc(vault));
      return Number(r.c);
    },
    modelCall(generationId: string): ModelCallRow | undefined {
      const r = db.prepare("SELECT * FROM model_calls WHERE generation_id = ?").get(generationId);
      return r ? toModelCall(r) : undefined;
    },
    /** This period's spend: model cost in USD, tool spend in USDC. Zero for an unknown key. */
    spendForKey(id: string): { modelUsd: number; toolUsd: number } {
      const k = keyById(id);
      return k ? { modelUsd: k.modelSpent, toolUsd: k.toolSpent } : { modelUsd: 0, toolUsd: 0 };
    },
    spendForVault(vault: string): { modelUsd: number; toolUsd: number } {
      const keys = keysForVault(vault);
      return {
        modelUsd: round6(keys.reduce((s, k) => s + k.modelSpent, 0)),
        toolUsd: round6(keys.reduce((s, k) => s + k.toolSpent, 0)),
      };
    },
    /** Every recorded model cost for the vault across all periods, for the daily drift check. */
    totalModelCost(vault: string): number {
      const r: any = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM model_calls WHERE vault = ? AND status = 'recorded'").get(lc(vault));
      return round6(Number(r.c));
    },
    /** Every settlement recorded for the vault, in USD: what the chain has billed so far, for the daily check. */
    settledUsageUsd(vault: string): number {
      const r: any = db.prepare("SELECT COALESCE(SUM(CAST(usage_micro AS REAL)), 0) AS u FROM settlements WHERE vault = ?").get(lc(vault));
      return round6(Number(r.u) / 1e6);
    },
    /** The vault's tool spend in periods before `period`, the tool part of what its settlements billed. */
    toolSpendBeforePeriod(vault: string, period: number): number {
      const r: any = db.prepare(`SELECT COALESCE(SUM(t.price), 0) AS p FROM tool_calls t JOIN keys k ON k.id = t.key_id
        WHERE k.vault = ? AND t.period < ?`).get(lc(vault), period);
      return round6(Number(r.p));
    },
    /** Opens the next period. Spend is per period, so a bump is all it takes. */
    startNewPeriod(vault: string): void {
      db.prepare("UPDATE vaults SET period = period + 1 WHERE vault = ?").run(lc(vault));
    },
    recordSettlement(vault: string, usageMicro: bigint, tx: string): void {
      insertSettlement(vault, usageMicro, tx);
    },
    /**
     * Persists a settlement about to be broadcast. Insert-only: returns false, changing nothing, when the vault
     * already has a pending settlement (possibly from another process), so the caller must not broadcast.
     */
    setPendingSettlement(vault: string, p: {
      usageMicro: bigint; baselines: SpendSnapshot[]; tx: string; createdAt?: number;
      modelCallId?: number | null; toolCallId?: number | null;
    }): boolean {
      const r = db.prepare(`INSERT INTO pending_settlements (vault, usage_micro, baselines, tx, created_at, model_call_id, tool_call_id)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(vault) DO NOTHING`)
        .run(lc(vault), p.usageMicro.toString(), JSON.stringify(p.baselines), p.tx, p.createdAt ?? Date.now(),
          p.modelCallId ?? null, p.toolCallId ?? null);
      return Number(r.changes) === 1;
    },
    pendingSettlement(vault: string): PendingSettlement | undefined {
      const r = db.prepare("SELECT * FROM pending_settlements WHERE vault = ?").get(lc(vault));
      return r ? toPending(r) : undefined;
    },
    listPendingSettlements(): PendingSettlement[] {
      return db.prepare("SELECT * FROM pending_settlements ORDER BY created_at, vault").all().map(toPending);
    },
    /** Clears the pending row only if it is still this tx, and then reopens the vault to the proxy. */
    clearPendingSettlement(vault: string, tx: string): boolean {
      return inTransaction(() => {
        const cleared = Number(db.prepare("DELETE FROM pending_settlements WHERE vault = ? AND tx = ?").run(lc(vault), tx).changes) > 0;
        if (cleared) db.prepare("UPDATE vaults SET settling = 0 WHERE vault = ?").run(lc(vault));
        return cleared;
      });
    },
    /**
     * Applies a mined settlement's bookkeeping in one transaction: records it, opens the next period (moving any
     * call metered after the snapshot into it, so it is billed next period), clears the pending row and the
     * settling flag, and writes the vault's settled-month marker. Returns false, and changes
     * nothing, unless a pending row for exactly this vault and tx exists, so it applies at most once.
     */
    completePendingSettlement(vault: string, tx: string, month: string): boolean {
      return inTransaction(() => {
        const r = db.prepare("SELECT * FROM pending_settlements WHERE vault = ? AND tx = ?").get(lc(vault), tx);
        if (!r) return false;
        const p = toPending(r);
        insertSettlement(vault, p.usageMicro, p.tx);
        const period = Number((db.prepare("SELECT period FROM vaults WHERE vault = ?").get(lc(vault)) as any)?.period ?? 0);
        if (p.modelCallId !== null) {
          db.prepare("UPDATE model_calls SET period = period + 1 WHERE vault = ? AND period = ? AND id > ?")
            .run(lc(vault), period, p.modelCallId);
        }
        if (p.toolCallId !== null) {
          db.prepare(`UPDATE tool_calls SET period = period + 1 WHERE period = ? AND id > ?
            AND key_id IN (SELECT id FROM keys WHERE vault = ?)`).run(period, p.toolCallId, lc(vault));
        }
        db.prepare("UPDATE vaults SET period = period + 1, settling = 0 WHERE vault = ?").run(lc(vault));
        db.prepare("DELETE FROM pending_settlements WHERE vault = ?").run(lc(vault));
        db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
          .run(settledMonthKey(vault), month);
        return true;
      });
    },
    /** The highest model and tool call ids so far (0 when none): the settlement snapshot's markers. */
    lastCallIds(): { model: number; tool: number } {
      const m: any = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM model_calls").get();
      const t: any = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM tool_calls").get();
      return { model: Number(m.id), tool: Number(t.id) };
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
    /** Records when the keeper last synced the vault's yield and backstop (ms since the epoch). */
    setSyncedAt(vault: string, now: number = Date.now()): void {
      db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(syncedAtKey(vault), String(now));
    },
    /** When the keeper last synced the vault (ms since the epoch), or 0 when it never has. */
    syncedAt(vault: string): number {
      const r: any = db.prepare("SELECT v FROM meta WHERE k = ?").get(syncedAtKey(vault));
      return r ? Number(r.v) : 0;
    },
    close(): void {
      db.close();
    },
  };
}

export type Store = ReturnType<typeof openStore>;
