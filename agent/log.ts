import { DatabaseSync } from "node:sqlite";

export type ActionKind = "deposit" | "withdraw" | "move_source" | "paper_open" | "paper_close" | "sweep" | "refused";
export type RunStatus = "running" | "done" | "out_of_budget" | "failed";
export type Action = { id: number; runId: number; kind: ActionKind; detail: Record<string, unknown>; tx: string | null };
export type Run = {
  id: number; startedAt: number; finishedAt: number | null; clockAt: number; status: RunStatus; note: string;
  bookBefore: unknown; bookAfter: unknown; decision: unknown; error: string | null; actions: Action[];
};
export type Position = { id: number; openedRun: number; closedRun: number | null; asset: string; side: string; sizeUsdc: number; entryPrice: number; markPrice: number; closePrice: number | null };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_samples (id INTEGER PRIMARY KEY, target TEXT NOT NULL, share_price TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS agent_samples_target ON agent_samples(target, at);
CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL, finished_at INTEGER, clock_at INTEGER NOT NULL, status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '', book_before TEXT NOT NULL, book_after TEXT, decision TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS agent_actions (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, tx TEXT);
CREATE TABLE IF NOT EXISTS agent_positions (
  id INTEGER PRIMARY KEY, opened_run INTEGER NOT NULL, closed_run INTEGER, asset TEXT NOT NULL, side TEXT NOT NULL,
  size_usdc REAL NOT NULL, entry_price REAL NOT NULL, mark_price REAL NOT NULL, close_price REAL
);`;

/** The runner's own tables, in the same file as the store. Both the runner and the server open this; the server only reads. */
export function openAgentLog(path: string) {
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  const j = (v: unknown) => JSON.stringify(v ?? null);
  const p = (s: string | null) => (s === null ? null : JSON.parse(s));
  const action = (r: Record<string, unknown>): Action => ({ id: Number(r.id), runId: Number(r.run_id), kind: r.kind as ActionKind, detail: p(r.detail as string) ?? {}, tx: (r.tx as string) ?? null });
  const run = (r: Record<string, unknown>): Run => ({
    id: Number(r.id), startedAt: Number(r.started_at), finishedAt: r.finished_at === null ? null : Number(r.finished_at), clockAt: Number(r.clock_at),
    status: r.status as RunStatus, note: String(r.note), bookBefore: p(r.book_before as string), bookAfter: p(r.book_after as string | null),
    decision: p(r.decision as string | null), error: (r.error as string) ?? null,
    actions: (db.prepare("SELECT * FROM agent_actions WHERE run_id = ? ORDER BY id").all(r.id as number) as Record<string, unknown>[]).map(action),
  });
  return {
    getMeta(k: string): string | undefined { return (db.prepare("SELECT v FROM agent_meta WHERE k = ?").get(k) as { v: string } | undefined)?.v; },
    setMeta(k: string, v: string): void { db.prepare("INSERT INTO agent_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v); },
    addSample(target: string, sharePrice: bigint, at: number): void {
      db.prepare("INSERT INTO agent_samples (target, share_price, at) VALUES (?, ?, ?)").run(target.toLowerCase(), sharePrice.toString(), at);
    },
    lastSamples(target: string): { sharePrice: bigint; at: number }[] {
      return (db.prepare("SELECT share_price, at FROM agent_samples WHERE target = ? ORDER BY at DESC, id DESC LIMIT 2").all(target.toLowerCase()) as { share_price: string; at: number }[])
        .map((r) => ({ sharePrice: BigInt(r.share_price), at: r.at })).reverse();
    },
    startRun(r: { clockAt: number; bookBefore: unknown }, now: number = Date.now()): number {
      return Number(db.prepare("INSERT INTO agent_runs (started_at, clock_at, status, book_before) VALUES (?, ?, 'running', ?)").run(now, r.clockAt, j(r.bookBefore)).lastInsertRowid);
    },
    finishRun(id: number, r: { status: RunStatus; note: string; decision: unknown; bookAfter: unknown; error?: string }, now: number = Date.now()): void {
      db.prepare("UPDATE agent_runs SET finished_at = ?, status = ?, note = ?, decision = ?, book_after = ?, error = ? WHERE id = ?")
        .run(now, r.status, r.note, j(r.decision), j(r.bookAfter), r.error ?? null, id);
    },
    addAction(runId: number, a: { kind: ActionKind; detail: Record<string, unknown>; tx?: string }): void {
      db.prepare("INSERT INTO agent_actions (run_id, kind, detail, tx) VALUES (?, ?, ?, ?)").run(runId, a.kind, j(a.detail), a.tx ?? null);
    },
    listRuns(limit: number): Run[] {
      return (db.prepare("SELECT * FROM agent_runs ORDER BY id DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map(run);
    },
    latestRun(): Run | undefined {
      const r = db.prepare("SELECT * FROM agent_runs ORDER BY id DESC LIMIT 1").get() as Record<string, unknown> | undefined;
      return r && run(r);
    },
    openPosition(runId: number, x: { asset: string; side: string; sizeUsdc: number; entryPrice: number }): number {
      return Number(db.prepare("INSERT INTO agent_positions (opened_run, asset, side, size_usdc, entry_price, mark_price) VALUES (?, ?, ?, ?, ?, ?)")
        .run(runId, x.asset, x.side, x.sizeUsdc, x.entryPrice, x.entryPrice).lastInsertRowid);
    },
    openPositions(): Position[] {
      return (db.prepare("SELECT * FROM agent_positions WHERE closed_run IS NULL ORDER BY id").all() as Record<string, unknown>[]).map((r) => ({
        id: Number(r.id), openedRun: Number(r.opened_run), closedRun: null, asset: String(r.asset), side: String(r.side), sizeUsdc: Number(r.size_usdc),
        entryPrice: Number(r.entry_price), markPrice: Number(r.mark_price), closePrice: null,
      }));
    },
    markPositions(prices: Record<string, number>): void {
      for (const [asset, price] of Object.entries(prices)) db.prepare("UPDATE agent_positions SET mark_price = ? WHERE asset = ? AND closed_run IS NULL").run(price, asset);
    },
    closePosition(id: number, runId: number, price: number): void {
      db.prepare("UPDATE agent_positions SET closed_run = ?, close_price = ?, mark_price = ? WHERE id = ?").run(runId, price, price, id);
    },
    close(): void { db.close(); },
  };
}
export type AgentLog = ReturnType<typeof openAgentLog>;
