# Agent Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hosted financial agent that funds its own model and tool calls from its Inferest vault's yield, shown live on a public Agents page, with Home and Treasury pages beside it.

**Architecture:** A separate runner program under `agent/` talks to the server only through the proxy, the MCP endpoint, and the operator routes, signs its own transactions with its own wallet, and writes its runs into `agent_` tables in the same SQLite file. The server gains a public `GET /api/agent` that joins those tables with the vault's state and the per-run spend. The dashboard becomes three pages served from clean paths. Yield sources become a list the Factory allowlists.

**Tech Stack:** Node 26 native TypeScript (erasable syntax, `.ts` imports), `node:test`, `node:sqlite`, viem 2.56.9, `@modelcontextprotocol/sdk` client, Foundry for the deploy script. Browser code stays plain ES modules with no build step.

**Spec:** `docs/superpowers/specs/2026-09-27-agent-page-design.md`

## Global Constraints

- Erasable TypeScript only; relative imports end in `.ts`; `npm test` and `npm run typecheck` green after every task.
- Prose, comments and commit messages: no em dashes, American spelling, no event names.
- Secrets never reach a log line, a store row, or a response body: the agent's Inferest key lives only in the runner's memory; the runner's private key is read from the environment only.
- The runner reads and writes only tables prefixed `agent_`; it reaches the server only through `/v1/chat/completions`, `/mcp`, `POST /api/vaults`, `POST /api/keys`, `POST /api/keys/:id/rotate`, `POST /api/keys/:id/revoke`, and `POST /api/admin/settle`.
- The fence in `agent/fence.ts` is pure and is the only place a decision is validated.
- Amounts in USDC base units are `bigint`; dollars in the log are numbers with six decimals at most.
- Every `git commit` ends with the two trailers used on this branch (see the ledger).
- Never stage `.env*` (other than `.env.example`), `inferest.db*`, `contracts/deployments/42161.json`, `.obsidian/workspace.json`, `app/dashboard/dynamic.bundle.js`.

## Review Focus

1. **A decision that is half legal** (one trade over the cap, one fine): the fence keeps the legal part, logs the rest as refused with a reason, and the run status is `done`. Test in Task 4.
2. **The proxy answers 402 mid-loop**: the run ends with status `out_of_budget`, no transaction is sent, the note is the fixed sentence. Test in Task 5.
3. **A source move to a vault the agent already has over that target**: the runner reuses it rather than creating another, and the key on the reused vault is the one it rotates. Test in Task 6.
4. **`GET /api/agent` before the runner has ever registered**: 404 with `{ error: "no agent yet" }`, never a 500 from a missing table. Test in Task 3.
5. **The rate from samples taken in the same block** (`t1 === t0`): unknown, not a division by zero. Test in Task 4.

---

### Task 1: Yield sources as a list

**Files:**
- Modify: `config/arbitrum-one.json`
- Modify: `contracts/script/Deploy.s.sol`
- Modify: `app/config.ts`
- Modify: `app/chain.ts`
- Modify: `app/cli.ts` (publicConfig)
- Modify: `app/test/config.test.ts`
- Modify: `README.md` (one sentence under Deployment), `.env.example` (`TARGET_VAULTS`)

**Interfaces:**
- Produces: `Config.targets: { address: Hex; name: string }[]` (first entry is the default `target`); `Chain.targetOf(vault: string): Promise<string>`; `publicConfig.targets`.

- [ ] **Step 1: Write the failing config tests**

Append to `app/test/config.test.ts`:

```ts
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test app/test/config.test.ts`
Expected: FAIL, `cfg.targets` is undefined.

- [ ] **Step 3: Extend the config loader**

In `app/config.ts` add to `Config`:

```ts
  /** Allowlisted ERC-4626 yield sources, the first one being `target`, the default the Treasury page creates over. */
  targets: { address: Hex; name: string }[];
```

In `loadConfig`, after the target mismatch check:

```ts
  const targets: { address: Hex; name: string }[] = Array.isArray(chain.targets) && chain.targets.length
    ? chain.targets.map((t: { address: string; name?: string }) => ({ address: t.address as Hex, name: String(t.name ?? "yield source") }))
    : [{ address: chain.target as Hex, name: String(chain.targetName ?? "yield source") }];
  if (targets[0].address.toLowerCase() !== String(chain.target).toLowerCase()) throw new Error("the first of targets must be target");
  const allowlisted = new Set((Array.isArray(dep.targets) ? dep.targets : [dep.target]).map((a: string) => String(a).toLowerCase()));
  for (const t of targets) if (!allowlisted.has(t.address.toLowerCase())) throw new Error(`target ${t.address} is not allowlisted in the deployment`);
```

and `targets,` in the returned object.

- [ ] **Step 4: The chain adapter reads a vault's target**

In `app/chain.ts` add to the `Chain` interface: `/** The ERC-4626 yield source the vault's strategy wraps. */ targetOf(vault: string): Promise<string>;` and in `makeChain`:

```ts
    async targetOf(vault) {
      return (await pub.readContract({ address: vault as Hex, abi: strategyAbi, functionName: "targetVault" })).toLowerCase();
    },
```

Add `targetOf: async () => "0x"` to every fake `Chain` in `app/test/server.test.ts` and `app/test/keeper.test.ts` (the typecheck will point at each).

- [ ] **Step 5: Public config, chain config, deploy script**

`app/cli.ts` publicConfig: add `targets: cfg.targets,`.

`config/arbitrum-one.json`: add `"targets": [{ "address": "0x1A996cb54bb95462040408C06122D45D6Cdb6096", "name": "Fluid USDC" }]`. The implementer adds one or two more live ERC-4626 USDC vaults on Arbitrum One only after verifying each on the fork: `cast call <addr> "asset()(address)"` must return the USDC address in this file and `cast call <addr> "convertToAssets(uint256)(uint256)" 1000000` must answer. Candidates to check: Aave's static aToken wrapper for USDC on Arbitrum. A candidate that fails either call is left out and named in the report.

`contracts/script/Deploy.s.sol`: read `TARGET_VAULTS` when set (comma separated, parsed with `vm.envOr("TARGET_VAULTS", string(""))` and a small split loop), else `[TARGET_VAULT]`; `setAllowedTarget` each; keep `target` as the first and serialize `targets` with `vm.serializeAddress(o, "targets", targetsArray)`. `.env.example`: a `TARGET_VAULTS=` line under the deploy comment.

- [ ] **Step 6: Tests green, commit**

Run: `npm test && npm run typecheck && (cd contracts && forge build)`
Expected: all pass, forge builds.

```bash
git add config/arbitrum-one.json contracts/script/Deploy.s.sol app/config.ts app/chain.ts app/cli.ts app/test/config.test.ts app/test/server.test.ts app/test/keeper.test.ts README.md .env.example
git commit -m "Yield sources are a list the Factory allowlists; the chain adapter reads a vault's target"
```

---

### Task 2: Three pages

**Files:**
- Rename: `app/dashboard/index.html` to `app/dashboard/treasury.html`
- Create: `app/dashboard/home.html`, `app/dashboard/agents.html`, `app/dashboard/agents.js` (placeholder until Task 7)
- Modify: `app/server.ts` (`serveStatic`, `/setup`), `app/dashboard/styles.css` (nav), `app/dashboard/app.js` (nothing functional; the page path in comments), `app/test/server.test.ts`, `docs/07-walkthrough.md`, `README.md`

**Interfaces:**
- Produces: `/` serves `home.html`, `/treasury` serves `treasury.html`, `/agents` serves `agents.html`; `/setup` answers 302 to `/treasury#use-a-key`.

- [ ] **Step 1: Failing route tests**

In `app/test/server.test.ts` replace the `/setup` test's expected `Location` with `/treasury#use-a-key` and add:

```ts
test("the three pages are served from clean paths", async () => {
  const { base, server } = await start();
  for (const [path, marker] of [["/", "For treasuries"], ["/treasury", 'id="signin"'], ["/agents", 'id="runs"']] as const) {
    const r = await fetch(base + path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get("content-type"), "text/html");
    assert.ok((await r.text()).includes(marker), `${path} carries ${marker}`);
  }
  assert.equal((await fetch(base + "/index.html")).status, 404);
  server.close();
});
```

- [ ] **Step 2: Run, see them fail**

Run: `node --test app/test/server.test.ts`
Expected: FAIL on `/` (still index.html) and `/agents` (404).

- [ ] **Step 3: Serve the pages**

In `app/server.ts` replace the first line of `serveStatic` with:

```ts
  const PAGES: Record<string, string> = { "/": "home.html", "/treasury": "treasury.html", "/agents": "agents.html" };
  const file = PAGES[pathname] ?? pathname.slice(1);
  if (file === "index.html" || file.endsWith(".html") && !Object.values(PAGES).includes(file)) return send(res, 404, { error: "not found" });
```

and the redirect line to `Location: "/treasury#use-a-key"`.

`git mv app/dashboard/index.html app/dashboard/treasury.html`. In `treasury.html` add inside `.topbar .wrap`, right after the brand link:

```html
      <nav class="nav"><a href="/">Home</a><a href="/treasury" aria-current="page">Treasury</a><a href="/agents">Agents</a></nav>
```

`home.html`: the `<head>` of treasury.html, the same top bar with `aria-current` on Home and no account block, then the hero section copied from treasury.html without the sign-in card, followed by a `<section class="doors"><div class="wrap">` with two cards:

```html
<a class="card door" href="/treasury"><span class="tag">For treasuries</span><h3>Put idle USDC to work.</h3><p>Deposit once. Issue keys to your developers. Only the interest pays.</p></a>
<a class="card door" href="/agents"><span class="tag">For agents</span><h3>An agent that pays for its own thinking.</h3><p>Watch our agent fund its model and tool calls from its own vault's yield.</p></a>
```

and the footer from treasury.html without the Operator pill. Home loads no script.

`agents.html`: head, top bar with `aria-current` on Agents, a `<main class="wrap"><section id="runs"><p class="fine">The agent has not run yet.</p></section></main>`, the footer, and `<script type="module" src="/agents.js"></script>`. `agents.js` in this task only fetches `/api/agent` once and writes `no agent yet` into `#runs` on a 404 (the endpoint arrives in Task 3, so until then every answer is a 404 too); Task 7 replaces it.

`styles.css`: `.nav { display: flex; gap: 18px; margin-left: 28px; } .nav a { color: var(--grey); text-decoration: none; font-size: 14px; } .nav a[aria-current] { color: var(--ink); } .doors { padding: 40px 0 64px; } .doors .wrap { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; } .door { display: block; text-decoration: none; color: inherit; } .door h3 { font: 26px var(--serif); margin: 12px 0 6px; } @media (max-width: 900px) { .doors .wrap { grid-template-columns: 1fr; } }`.

`docs/07-walkthrough.md` step 1: "Open the dashboard at the server's public URL" becomes "Open `/treasury` on the server's public URL". README: the dashboard line names the three pages.

- [ ] **Step 4: Tests green, commit**

Run: `npm test && npm run typecheck`

```bash
git add app/server.ts app/dashboard/treasury.html app/dashboard/home.html app/dashboard/agents.html app/dashboard/agents.js app/dashboard/styles.css app/test/server.test.ts docs/07-walkthrough.md README.md
git commit -m "Home, Treasury and Agents pages from clean paths; /setup follows the Treasury page"
```

---

### Task 3: The agent log tables and `GET /api/agent`

**Files:**
- Create: `agent/log.ts`, `agent/test/log.test.ts`
- Modify: `app/store.ts` (`spendInWindow`), `app/test/store.test.ts`, `app/server.ts` (`/api/agent`, `vaultEntry`), `app/test/server.test.ts`, `app/cli.ts` (pass `agentLog` to the app)

**Interfaces:**
- Produces: `openAgentLog(path: string): AgentLog` with the methods below; `Store.spendInWindow(keyIds: string[], from: number, to: number): { modelUsd: number; toolUsd: number; modelCalls: number; toolCalls: number }`; `AppDeps.agentLog?: AgentLog`; `GET /api/agent`.

- [ ] **Step 1: Failing tests for the log**

`agent/test/log.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openAgentLog } from "../log.ts";

test("a run is opened, given actions, and finished; runs list newest first with their actions", () => {
  const log = openAgentLog(":memory:");
  const a = log.startRun({ clockAt: 1_000, bookBefore: { walletUsdc: 500 } });
  log.addAction(a, { kind: "deposit", detail: { amountUsdc: 100 }, tx: "0xa" });
  log.addAction(a, { kind: "refused", detail: { what: "trade", reason: "over the cap" } });
  log.finishRun(a, { status: "done", note: "parked more", decision: { split: { action: "deposit", amountUsdc: 100 } }, bookAfter: { walletUsdc: 400 } });
  const b = log.startRun({ clockAt: 2_000, bookBefore: {} });
  log.finishRun(b, { status: "out_of_budget", note: "out of thinking budget until yield accrues", decision: null, bookAfter: {} });
  const runs = log.listRuns(10);
  assert.deepEqual(runs.map((r) => r.id), [b, a]);
  assert.equal(runs[1].actions.length, 2);
  assert.equal(runs[1].actions[1].detail.reason, "over the cap");
  assert.equal(runs[0].status, "out_of_budget");
  assert.equal(log.latestRun()!.id, b);
});

test("samples keep the last two per target and meta round-trips", () => {
  const log = openAgentLog(":memory:");
  log.addSample("0xT", 1_000_000n, 100);
  log.addSample("0xT", 1_001_000n, 200);
  log.addSample("0xT", 1_002_000n, 300);
  assert.deepEqual(log.lastSamples("0xT").map((s) => s.at), [200, 300]);
  assert.equal(log.getMeta("vault"), undefined);
  log.setMeta("vault", "0xV");
  assert.equal(log.getMeta("vault"), "0xV");
});

test("positions open and close", () => {
  const log = openAgentLog(":memory:");
  const run = log.startRun({ clockAt: 1, bookBefore: {} });
  const id = log.openPosition(run, { asset: "ETH", side: "buy", sizeUsdc: 50, entryPrice: 4_000 });
  assert.equal(log.openPositions().length, 1);
  log.markPositions({ ETH: 4_100 });
  assert.equal(log.openPositions()[0].markPrice, 4_100);
  log.closePosition(id, run, 4_050);
  assert.equal(log.openPositions().length, 0);
});
```

- [ ] **Step 2: Run, see them fail** (`node --test agent/test/log.test.ts`: cannot find module).

- [ ] **Step 3: Write the log**

`agent/log.ts`:

```ts
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
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
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
```

- [ ] **Step 4: Log tests green** (`node --test agent/test/log.test.ts`).

- [ ] **Step 5: Failing test for the spend window and the endpoint**

`app/test/store.test.ts`, append:

```ts
test("spendInWindow sums the given keys' model and tool rows inside the window only", () => {
  const store = openStore(":memory:");
  store.addVault("0xv", "0xc", "T");
  store.addKey({ id: "k1", vault: "0xv", name: "a", weight: 1, secretSha256: "s1" });
  store.addKey({ id: "k2", vault: "0xv", name: "b", weight: 1, secretSha256: "s2" });
  store.recordModelCall({ keyId: "k1", model: "m", costUsd: 0.5, generationId: "g1" }, 1_000);
  store.recordModelCall({ keyId: "k1", model: "m", costUsd: 0.25, generationId: "g2" }, 5_000);
  store.recordToolCall("k1", "search", "/s", 0.1, 9_000); // outside the first window, inside the second
  store.recordModelCall({ keyId: "k2", model: "m", costUsd: 9, generationId: "g3" }, 1_500);
  assert.deepEqual(store.spendInWindow(["k1"], 900, 2_000), { modelUsd: 0.5, toolUsd: 0, modelCalls: 1, toolCalls: 0 });
  assert.deepEqual(store.spendInWindow(["k1", "k2"], 0, 10_000), { modelUsd: 9.75, toolUsd: 0.1, modelCalls: 3, toolCalls: 1 });
});
```

`recordToolCall` takes no timestamp today: give it a trailing `now: number = Date.now()` parameter like `recordModelCall`, used for `at`.

`app/test/server.test.ts`, append:

```ts
import { openAgentLog } from "../../agent/log.ts";

test("GET /api/agent is 404 without a runner and public with one", async () => {
  const { base, server, store, d } = await start();
  assert.equal((await fetch(base + "/api/agent")).status, 404);
  const log = openAgentLog(":memory:");
  d.agentLog = log;
  assert.equal((await fetch(base + "/api/agent")).status, 404); // tables exist, no vault registered yet
  await post(base, "/api/vaults", { vault: V, label: "Agent" });
  const { id: keyId } = await (await post(base, "/api/keys", { vault: V, name: "agent", weight: 1 })).json();
  log.setMeta("address", "0x00000000000000000000000000000000000000cc");
  log.setMeta("vault", V);
  log.setMeta("keys", JSON.stringify([keyId]));
  const run = log.startRun({ clockAt: 1_700_000_000, bookBefore: { walletUsdc: 500 } }, 1_000);
  store.recordModelCall({ keyId, model: "m", costUsd: 0.002, generationId: "g1" }, 1_500);
  log.addAction(run, { kind: "deposit", detail: { amountUsdc: 50 }, tx: "0xdead" });
  log.finishRun(run, { status: "done", note: "parked 50", decision: { split: { action: "deposit", amountUsdc: 50 } }, bookAfter: { walletUsdc: 450 } }, 2_000);
  const r = await fetch(base + "/api/agent");
  assert.equal(r.status, 200);
  const body: any = await r.json();
  assert.equal(body.agent.vault, V);
  assert.equal(body.agent.runCount, 1);
  assert.equal(body.budget.vault, V);
  assert.deepEqual(body.runs[0].cost, { models: 0.002, tools: 0 });
  assert.equal(body.runs[0].actions[0].tx, "0xdead");
  assert.equal(body.book.floor, 200);
  assert.ok(Array.isArray(body.sources));
  assert.ok(!JSON.stringify(body).includes("secret"));
  server.close();
});
```

- [ ] **Step 6: Run, see them fail.**

- [ ] **Step 7: Store method and the endpoint**

`app/store.ts`, inside the returned object:

```ts
    /** Model and tool spend of the given keys with `at` in [from, to]. Pending model calls (cost unknown) count as calls, not dollars. */
    spendInWindow(keyIds: string[], from: number, to: number): { modelUsd: number; toolUsd: number; modelCalls: number; toolCalls: number } {
      if (!keyIds.length) return { modelUsd: 0, toolUsd: 0, modelCalls: 0, toolCalls: 0 };
      const marks = keyIds.map(() => "?").join(",");
      const m = db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS n FROM model_calls WHERE key_id IN (${marks}) AND at BETWEEN ? AND ?`).get(...keyIds, from, to) as { usd: number; n: number };
      const t = db.prepare(`SELECT COALESCE(SUM(price), 0) AS usd, COUNT(*) AS n FROM tool_calls WHERE key_id IN (${marks}) AND at BETWEEN ? AND ?`).get(...keyIds, from, to) as { usd: number; n: number };
      return { modelUsd: m.usd, toolUsd: t.usd, modelCalls: m.n, toolCalls: t.n };
    },
```

and give `recordToolCall` a trailing `now: number = Date.now()` used for `at`.

`app/server.ts`: import `type AgentLog` from `../agent/log.ts`; add `agentLog?: AgentLog;` to `AppDeps` with the comment `/** The hosted agent's run log, read-only here; unset when no runner exists. */`. Extract the per-vault entry from `state()` into `function vaultEntry(d: AppDeps, v: VaultRow)` and use it in `state()`. Add before the `/api/` block:

```ts
  if (url.pathname === "/api/agent" && req.method === "GET") {
    const log = d.agentLog;
    const vault = log?.getMeta("vault");
    const row = vault ? d.store.vault(vault) : undefined;
    if (!log || !vault || !row) return send(res, 404, { error: "no agent yet" });
    const keyIds: string[] = JSON.parse(log.getMeta("keys") ?? "[]");
    const runs = log.listRuns(50).map((r) => ({
      id: r.id, startedAt: r.startedAt, finishedAt: r.finishedAt, clockAt: r.clockAt, status: r.status, note: r.note, decision: r.decision,
      actions: r.actions.map((a) => ({ kind: a.kind, detail: a.detail, tx: a.tx })),
      cost: (({ modelUsd, toolUsd }) => ({ models: modelUsd, tools: toolUsd }))(d.store.spendInWindow(keyIds, r.startedAt, r.finishedAt ?? Date.now())),
    }));
    const sources = (d.publicConfig.targets as { address: string; name: string }[] | undefined ?? []).map((t) => {
      const s = log.lastSamples(t.address);
      return { target: t.address, name: t.name, rate: rateFrom(s), current: t.address.toLowerCase() === (log.getMeta("source") ?? "") };
    });
    const book = JSON.parse(log.getMeta("book") ?? "{}");
    return send(res, 200, {
      agent: { address: log.getMeta("address") ?? null, vault, source: sources.find((s) => s.current) ?? null, period: row.period, runCount: log.latestRun()?.id ?? 0 },
      book: { walletUsdc: book.walletUsdc ?? null, vaultValue: book.vaultValue ?? null, floor: Number(log.getMeta("floor") ?? 200), positions: log.openPositions() },
      budget: vaultEntry(d, row),
      sources,
      runs,
      settlements: d.store.listSettlements().filter((s) => s.vault === vault),
    });
  }
```

`rateFrom` is the pure function from Task 4's `agent/book.ts`; for this task put it in `agent/rate.ts` (`export function rateFrom(samples: { sharePrice: bigint; at: number }[]): number | null`) with the body from Task 4 Step 3, and have Task 4 import it from there. `app/cli.ts` serve: `agentLog: openAgentLog(cfg.dbPath),` (the tables are harmless when no runner exists; the 404 comes from the missing `vault` meta).

- [ ] **Step 8: Green, commit**

Run: `npm test && npm run typecheck`

```bash
git add agent/log.ts agent/rate.ts agent/test/log.test.ts app/store.ts app/test/store.test.ts app/server.ts app/test/server.test.ts app/cli.ts
git commit -m "The agent's run log and a public GET /api/agent joining it with the vault's state and per-run spend"
```

---

### Task 4: The book, the rate, and the fence

**Files:**
- Create: `agent/book.ts`, `agent/fence.ts`, `agent/test/fence.test.ts`, `agent/test/rate.test.ts`
- Modify: `agent/rate.ts` (if Task 3 left it minimal)

**Interfaces:**
- Produces: `Book`, `readBook(deps): Promise<Book>`; `Decision`, `applyFence(decision, ctx): { accepted: Decision; refused: { what: string; reason: string }[] }`; `rateFrom(samples): number | null`.

- [ ] **Step 1: Failing tests**

`agent/test/rate.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { rateFrom } from "../rate.ts";

const YEAR = 365 * 86_400;
test("a rate needs two samples at different times", () => {
  assert.equal(rateFrom([]), null);
  assert.equal(rateFrom([{ sharePrice: 1_000_000n, at: 1 }]), null);
  assert.equal(rateFrom([{ sharePrice: 1_000_000n, at: 5 }, { sharePrice: 1_010_000n, at: 5 }]), null);
});
test("the rate is annualized from the share price change", () => {
  const r = rateFrom([{ sharePrice: 1_000_000n, at: 0 }, { sharePrice: 1_020_000n, at: YEAR / 2 }]);
  assert.ok(Math.abs(r! - 0.04) < 1e-9, String(r));
});
```

`agent/test/fence.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFence, type Decision, type FenceContext } from "../fence.ts";

const ctx: FenceContext = {
  walletUsdc: 500, vaultValue: 500, floorUsdc: 200, currentTarget: "0xa", targets: ["0xa", "0xb"],
  tradeCapBps: 2000, positions: [{ asset: "ETH", sizeUsdc: 60 }],
};
const base = (over: Partial<Decision> = {}): Decision => ({ note: "n", split: { action: "hold", amountUsdc: 0 }, source: { action: "stay", target: null }, trades: [], ...over });

test("a legal decision passes untouched", () => {
  const d = base({ split: { action: "deposit", amountUsdc: 100 }, source: { action: "move", target: "0xb" }, trades: [{ side: "buy", asset: "ETH", sizeUsdc: 100, price: 4_000, reasoning: "r" }] });
  const { accepted, refused } = applyFence(d, ctx);
  assert.deepEqual(refused, []);
  assert.deepEqual(accepted, d);
});
test("the floor, the balances and the caps are enforced, and the rest survives", () => {
  const d = base({
    split: { action: "withdraw", amountUsdc: 350 },
    source: { action: "move", target: "0xc" },
    trades: [{ side: "buy", asset: "ETH", sizeUsdc: 101, price: 4_000, reasoning: "r" }, { side: "sell", asset: "ETH", sizeUsdc: 60, price: 4_100, reasoning: "r" }, { side: "buy", asset: "SOL", sizeUsdc: 10, price: 1, reasoning: "r" }],
  });
  const { accepted, refused } = applyFence(d, ctx);
  assert.equal(accepted.split.action, "hold");
  assert.equal(accepted.source.action, "stay");
  assert.deepEqual(accepted.trades.map((t) => t.asset + t.side), ["ETHsell"]);
  assert.deepEqual(refused.map((r) => r.what), ["split", "source", "trade 1", "trade 3"]);
  assert.match(refused[0].reason, /floor/);
  assert.match(refused[1].reason, /allowlist/);
  assert.match(refused[2].reason, /20%/);
  assert.match(refused[3].reason, /asset/);
});
test("a deposit above the wallet, a sell above the position, a fourth trade, a zero price, and a move to the current source are refused", () => {
  const d = base({
    split: { action: "deposit", amountUsdc: 501 }, source: { action: "move", target: "0xa" },
    trades: [
      { side: "sell", asset: "ETH", sizeUsdc: 61, price: 4_000, reasoning: "r" },
      { side: "buy", asset: "BTC", sizeUsdc: 10, price: 0, reasoning: "r" },
      { side: "buy", asset: "ARB", sizeUsdc: 10, price: 1, reasoning: "r" },
      { side: "buy", asset: "ARB", sizeUsdc: 10, price: 1, reasoning: "r" },
      { side: "buy", asset: "ARB", sizeUsdc: 10, price: 1, reasoning: "r" },
      { side: "buy", asset: "ARB", sizeUsdc: 10, price: 1, reasoning: "r" },
    ],
  });
  const { accepted, refused } = applyFence(d, ctx);
  assert.equal(accepted.split.action, "hold");
  assert.equal(accepted.source.action, "stay");
  assert.equal(accepted.trades.length, 3); // the three legal ARB buys; the fourth is over the per-run count
  assert.equal(refused.filter((r) => r.what.startsWith("trade")).length, 3);
});
```

- [ ] **Step 2: Run, see them fail.**

- [ ] **Step 3: Implement**

`agent/rate.ts`:

```ts
const YEAR_SECONDS = 365 * 86_400;
/** Annualized rate from the last two share-price samples of a yield source; null with fewer than two or no time between them. */
export function rateFrom(samples: { sharePrice: bigint; at: number }[]): number | null {
  if (samples.length < 2) return null;
  const [a, b] = samples.slice(-2);
  if (b.at <= a.at || a.sharePrice === 0n) return null;
  const growth = Number(b.sharePrice) / Number(a.sharePrice) - 1;
  return growth * (YEAR_SECONDS / (b.at - a.at));
}
```

`agent/fence.ts`:

```ts
export type Trade = { side: "buy" | "sell"; asset: "ETH" | "BTC" | "ARB"; sizeUsdc: number; price: number; reasoning: string };
export type Decision = {
  note: string;
  split: { action: "deposit" | "withdraw" | "hold"; amountUsdc: number };
  source: { action: "stay" | "move"; target: string | null };
  trades: Trade[];
};
export type FenceContext = {
  walletUsdc: number; vaultValue: number; floorUsdc: number; currentTarget: string; targets: string[];
  tradeCapBps: number; positions: { asset: string; sizeUsdc: number }[];
};
export const ASSETS = new Set(["ETH", "BTC", "ARB"]);
export const MAX_TRADES = 3;

/** Rules the model cannot change. Returns what may be executed and what was dropped, with a reason each. */
export function applyFence(d: Decision, c: FenceContext): { accepted: Decision; refused: { what: string; reason: string }[] } {
  const refused: { what: string; reason: string }[] = [];
  const lc = (s: string | null) => (s ?? "").toLowerCase();
  let split = d.split;
  if (split.action === "deposit" && !(split.amountUsdc > 0 && split.amountUsdc <= c.walletUsdc)) { refused.push({ what: "split", reason: `deposit of ${split.amountUsdc} exceeds the wallet's ${c.walletUsdc} USDC` }); split = { action: "hold", amountUsdc: 0 }; }
  else if (split.action === "withdraw" && !(split.amountUsdc > 0 && c.vaultValue - split.amountUsdc >= c.floorUsdc)) { refused.push({ what: "split", reason: `withdrawing ${split.amountUsdc} would leave the vault under the ${c.floorUsdc} USDC floor: no room to think` }); split = { action: "hold", amountUsdc: 0 }; }
  let source = d.source;
  if (source.action === "move") {
    if (!c.targets.map(lc).includes(lc(source.target))) { refused.push({ what: "source", reason: `${source.target} is not in the allowlist` }); source = { action: "stay", target: null }; }
    else if (lc(source.target) === lc(c.currentTarget)) { refused.push({ what: "source", reason: "already in that source" }); source = { action: "stay", target: null }; }
  }
  const trades: Trade[] = [];
  const cap = (c.walletUsdc * c.tradeCapBps) / 10_000;
  d.trades.forEach((t, i) => {
    const what = `trade ${i + 1}`;
    if (trades.length >= MAX_TRADES) return refused.push({ what, reason: `at most ${MAX_TRADES} trades per run` });
    if (!ASSETS.has(t.asset)) return refused.push({ what, reason: `asset ${t.asset} is not allowed` });
    if (!(t.price > 0)) return refused.push({ what, reason: "price must be above zero" });
    if (t.side === "buy" && !(t.sizeUsdc > 0 && t.sizeUsdc <= cap)) return refused.push({ what, reason: `a buy is at most 20% of the working half (${cap.toFixed(2)} USDC)` });
    const held = c.positions.filter((p) => p.asset === t.asset).reduce((s, p) => s + p.sizeUsdc, 0);
    if (t.side === "sell" && !(t.sizeUsdc > 0 && t.sizeUsdc <= held)) return refused.push({ what, reason: `a sell is at most the open ${t.asset} position (${held} USDC)` });
    trades.push(t);
  });
  return { accepted: { note: d.note, split, source, trades }, refused };
}
```

`agent/book.ts`:

```ts
import { createPublicClient, defineChain, http, parseAbi, type Hex } from "viem";
import type { AgentLog } from "./log.ts";

export type Book = {
  walletUsdc: bigint; vault: Hex | null; vaultShares: bigint; vaultValue: bigint; target: string | null;
  samples: { target: string; sharePrice: bigint; at: number }[]; clockAt: number;
};
export const erc4626Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function targetVault() view returns (address)",
]);
export const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export function publicClient(rpcUrl: string, chainId: number) {
  const chain = defineChain({ id: chainId, name: "inferest", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  return createPublicClient({ chain, transport: http(rpcUrl) });
}

/** What the agent reads before it thinks: its wallet, its vault, and a share-price sample of every allowlisted source. */
export async function readBook(d: { pub: ReturnType<typeof publicClient>; address: Hex; usdc: Hex; vault: Hex | null; targets: Hex[]; log: AgentLog }): Promise<Book> {
  const block = await d.pub.getBlock();
  const clockAt = Number(block.timestamp);
  const walletUsdc = await d.pub.readContract({ address: d.usdc, abi: erc20Abi, functionName: "balanceOf", args: [d.address] });
  let vaultShares = 0n, vaultValue = 0n, target: string | null = null;
  if (d.vault) {
    vaultShares = await d.pub.readContract({ address: d.vault, abi: erc4626Abi, functionName: "balanceOf", args: [d.address] });
    vaultValue = await d.pub.readContract({ address: d.vault, abi: erc4626Abi, functionName: "convertToAssets", args: [vaultShares] });
    target = (await d.pub.readContract({ address: d.vault, abi: erc4626Abi, functionName: "targetVault" })).toLowerCase();
  }
  const samples = [];
  for (const t of d.targets) {
    const sharePrice = await d.pub.readContract({ address: t, abi: erc4626Abi, functionName: "convertToAssets", args: [1_000_000n] });
    d.log.addSample(t, sharePrice, clockAt);
    samples.push({ target: t.toLowerCase(), sharePrice, at: clockAt });
  }
  return { walletUsdc, vault: d.vault, vaultShares, vaultValue, target, samples, clockAt };
}
export const usd = (micro: bigint): number => Number(micro) / 1e6;
```

- [ ] **Step 4: Green, commit**

```bash
git add agent/rate.ts agent/fence.ts agent/book.ts agent/test/rate.test.ts agent/test/fence.test.ts
git commit -m "The agent's book read, its rate from share-price samples, and the fence a decision must pass"
```

---

### Task 5: Think

**Files:**
- Create: `agent/think.ts`, `agent/test/think.test.ts`

**Interfaces:**
- Consumes: `Decision` from `agent/fence.ts`, `Book` and `usd` from `agent/book.ts`, `rateFrom`.
- Produces: `think(input): Promise<ThinkResult>` where `ThinkResult = { decision: Decision | null; outOfBudget: boolean; toolCalls: { name: string; args: unknown }[]; turns: number; error?: string }`; `Mcp = { listTools(): Promise<{ name: string; description?: string; inputSchema: unknown }[]>; callTool(name: string, args: unknown): Promise<unknown> }`.

- [ ] **Step 1: Failing tests**

`agent/test/think.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { think, type Mcp } from "../think.ts";

const mcp: Mcp = {
  listTools: async () => [{ name: "search_tools", description: "find a tool", inputSchema: { type: "object" } }],
  callTool: async (name, args) => ({ content: [{ type: "text", text: `result of ${name} ${JSON.stringify(args)}` }] }),
};
const prompt = { walletUsdc: 500, vaultValue: 500, floorUsdc: 200, currentTarget: "0xa", targets: [{ address: "0xa", name: "A", rate: 0.04 }, { address: "0xb", name: "B", rate: null }], positions: [] };
const decision = { note: "hold", split: { action: "hold", amountUsdc: 0 }, source: { action: "stay", target: null }, trades: [] };
const reply = (message: unknown) => new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { "content-type": "application/json" } });

test("the loop calls a paid tool, then decides", async () => {
  const bodies: any[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    if (bodies.length === 1) return reply({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "search_tools", arguments: JSON.stringify({ query: "eth price" }) } }] });
    return reply({ role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "decide", arguments: JSON.stringify(decision) } }] });
  }) as unknown as typeof fetch;
  const r = await think({ key: "sk-inf-x", model: "m", api: "http://api.test", mcp, book: prompt, maxTurns: 10, maxToolCalls: 4, fetchFn });
  assert.deepEqual(r.decision, decision);
  assert.equal(r.outOfBudget, false);
  assert.deepEqual(r.toolCalls, [{ name: "search_tools", args: { query: "eth price" } }]);
  assert.equal(r.turns, 2);
  assert.equal(bodies[0].messages[0].role, "system");
  assert.ok(bodies[0].tools.some((t: any) => t.function.name === "decide"));
  assert.equal(bodies[1].messages.at(-1).role, "tool");
});

test("a 402 ends the run out of budget", async () => {
  const fetchFn = (async () => new Response(JSON.stringify({ error: { code: 402 } }), { status: 402 })) as unknown as typeof fetch;
  const r = await think({ key: "k", model: "m", api: "http://api.test", mcp, book: prompt, maxTurns: 10, maxToolCalls: 4, fetchFn });
  assert.equal(r.outOfBudget, true);
  assert.equal(r.decision, null);
});

test("a malformed decide call, the turn cap and the tool cap end the loop without a decision", async () => {
  let n = 0;
  const bad = (async () => reply({ role: "assistant", content: null, tool_calls: [{ id: `c${++n}`, type: "function", function: { name: "decide", arguments: JSON.stringify({ note: 1 }) } }] })) as unknown as typeof fetch;
  const r1 = await think({ key: "k", model: "m", api: "http://api.test", mcp, book: prompt, maxTurns: 10, maxToolCalls: 4, fetchFn: bad });
  assert.equal(r1.decision, null);
  assert.match(r1.error!, /decision/);
  const chatty = (async () => reply({ role: "assistant", content: "thinking" })) as unknown as typeof fetch;
  const r2 = await think({ key: "k", model: "m", api: "http://api.test", mcp, book: prompt, maxTurns: 2, maxToolCalls: 4, fetchFn: chatty });
  assert.equal(r2.turns, 2);
  assert.equal(r2.decision, null);
  const tools = (async () => reply({ role: "assistant", content: null, tool_calls: [{ id: `c${++n}`, type: "function", function: { name: "search_tools", arguments: "{}" } }] })) as unknown as typeof fetch;
  const r3 = await think({ key: "k", model: "m", api: "http://api.test", mcp, book: prompt, maxTurns: 10, maxToolCalls: 2, fetchFn: tools });
  assert.equal(r3.toolCalls.length, 2);
  assert.equal(r3.decision, null);
});
```

- [ ] **Step 2: Run, see them fail.**

- [ ] **Step 3: Implement**

`agent/think.ts`:

```ts
import type { Decision } from "./fence.ts";

export type Mcp = {
  listTools(): Promise<{ name: string; description?: string; inputSchema: unknown }[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
};
export type PromptBook = {
  walletUsdc: number; vaultValue: number; floorUsdc: number; currentTarget: string | null;
  targets: { address: string; name: string; rate: number | null }[];
  positions: { asset: string; side: string; sizeUsdc: number; entryPrice: number; markPrice: number }[];
};
export type ThinkResult = { decision: Decision | null; outOfBudget: boolean; toolCalls: { name: string; args: unknown }[]; turns: number; error?: string };

const DECIDE = {
  type: "function",
  function: {
    name: "decide",
    description: "End the run with your decision. Call it once, after your research.",
    parameters: {
      type: "object", required: ["note", "split", "source", "trades"],
      properties: {
        note: { type: "string", description: "Your desk note, under 120 words." },
        split: { type: "object", required: ["action", "amountUsdc"], properties: { action: { enum: ["deposit", "withdraw", "hold"] }, amountUsdc: { type: "number" } } },
        source: { type: "object", required: ["action", "target"], properties: { action: { enum: ["stay", "move"] }, target: { type: ["string", "null"] } } },
        trades: { type: "array", items: { type: "object", required: ["side", "asset", "sizeUsdc", "price", "reasoning"], properties: {
          side: { enum: ["buy", "sell"] }, asset: { enum: ["ETH", "BTC", "ARB"] }, sizeUsdc: { type: "number" }, price: { type: "number" }, reasoning: { type: "string" } } } },
      },
    },
  },
};

export function systemPrompt(b: PromptBook): string {
  const pct = (r: number | null) => (r === null ? "unknown yet" : `${(r * 100).toFixed(2)}% a year`);
  return [
    "You are a financial agent that pays for its own thinking. Your capital is split between an Inferest vault, whose yield is your model and tool budget, and a working half you trade with on paper.",
    `Book: ${b.walletUsdc.toFixed(2)} USDC working, ${b.vaultValue.toFixed(2)} USDC parked in the vault (floor ${b.floorUsdc} USDC). Current yield source: ${b.currentTarget ?? "none"}.`,
    `Allowed yield sources: ${b.targets.map((t) => `${t.name} ${t.address} at ${pct(t.rate)}`).join("; ")}.`,
    `Open paper positions: ${b.positions.length ? b.positions.map((p) => `${p.side} ${p.asset} ${p.sizeUsdc} USDC at ${p.entryPrice}, marked ${p.markPrice}`).join("; ") : "none"}.`,
    "Rules you must respect: the vault never goes below the floor; one split move and one source move per run at most; only ETH, BTC or ARB against USDC; a buy at most 20% of the working half; a sell at most the open position; at most three trades.",
    "Research with the tools: search_tools finds a paid web search, price or news tool, tool_details shows its parameters, run_tool calls it. Paid tools cost from your budget, so call only what you need. Then call decide exactly once.",
  ].join("\n");
}

function parseDecision(raw: string): Decision {
  const d = JSON.parse(raw);
  const ok = typeof d?.note === "string" && ["deposit", "withdraw", "hold"].includes(d?.split?.action) && typeof d?.split?.amountUsdc === "number"
    && ["stay", "move"].includes(d?.source?.action) && Array.isArray(d?.trades)
    && d.trades.every((t: any) => ["buy", "sell"].includes(t?.side) && typeof t?.asset === "string" && typeof t?.sizeUsdc === "number" && typeof t?.price === "number" && typeof t?.reasoning === "string");
  if (!ok) throw new Error("the decision does not match the schema");
  return { note: d.note, split: { action: d.split.action, amountUsdc: d.split.amountUsdc }, source: { action: d.source.action, target: d.source.target ?? null }, trades: d.trades };
}

/** One run's chat loop on the agent's own key: MCP tools for research, `decide` to end. Never throws on a 402: it reports it. */
export async function think(i: { key: string; model: string; api: string; mcp: Mcp; book: PromptBook; maxTurns: number; maxToolCalls: number; fetchFn?: typeof fetch }): Promise<ThinkResult> {
  const fetchFn = i.fetchFn ?? fetch;
  const mcpTools = await i.mcp.listTools();
  const tools = [...mcpTools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema } })), DECIDE];
  const messages: any[] = [{ role: "system", content: systemPrompt(i.book) }, { role: "user", content: "Run your review of the book and decide." }];
  const toolCalls: { name: string; args: unknown }[] = [];
  let turns = 0;
  while (turns < i.maxTurns) {
    turns++;
    const r = await fetchFn(`${i.api}/v1/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${i.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: i.model, messages, tools }),
    });
    if (r.status === 402) return { decision: null, outOfBudget: true, toolCalls, turns };
    if (!r.ok) return { decision: null, outOfBudget: false, toolCalls, turns, error: `proxy answered ${r.status}` };
    const msg = ((await r.json()) as any).choices?.[0]?.message;
    if (!msg) return { decision: null, outOfBudget: false, toolCalls, turns, error: "empty answer" };
    messages.push(msg);
    if (!msg.tool_calls?.length) continue; // prose only: ask again until the turn cap
    for (const call of msg.tool_calls) {
      if (call.function.name === "decide") {
        try { return { decision: parseDecision(call.function.arguments || "{}"), outOfBudget: false, toolCalls, turns }; }
        catch (e) { return { decision: null, outOfBudget: false, toolCalls, turns, error: `decision rejected: ${(e as Error).message}` }; }
      }
      if (toolCalls.length >= i.maxToolCalls) return { decision: null, outOfBudget: false, toolCalls, turns, error: "paid tool cap reached" };
      let args: unknown = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }
      toolCalls.push({ name: call.function.name, args });
      let out: unknown;
      try { out = await i.mcp.callTool(call.function.name, args); } catch (e) { out = { isError: true, content: [{ type: "text", text: `tool call failed: ${(e as Error).message}` }] }; }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify((out as any)?.content ?? out).slice(0, 6_000) });
    }
  }
  return { decision: null, outOfBudget: false, toolCalls, turns, error: "turn cap reached" };
}
```

Note for the implementer: the third test's tool-cap case expects exactly two recorded tool calls before the cap ends the loop; the check above runs before recording, so the cap of 2 allows two calls and refuses the third.

- [ ] **Step 4: Green, commit**

```bash
git add agent/think.ts agent/test/think.test.ts
git commit -m "The agent's think loop: MCP tools for research, one decide call to end, a 402 reported as out of budget"
```

---

### Task 6: Act and run

**Files:**
- Create: `agent/act.ts`, `agent/run.ts`, `agent/test/act.test.ts`
- Modify: `package.json` (`"agent": "node --env-file-if-exists=.env --env-file-if-exists=.env.local agent/run.ts"`), `.env.example` (the `AGENT_*` block), `README.md` (one paragraph "The hosted agent")

**Interfaces:**
- Consumes: everything above; `@modelcontextprotocol/sdk` client as in `demo/agent.ts`.
- Produces: `planActions(decision, ctx): Step[]` (pure) and `act(steps, deps): Promise<void>` where deps carry a viem wallet client, the public client, the log, the run id, the operator `api(path, body)`, the Factory, USDC, the targets, and the key handling; `npm run agent [-- --once]`. Steps 3 and 4 give the executor and the loop as exact prose rather than full code, on purpose: their bodies follow the deposit handler in `app/dashboard/app.js` and `demo/agent.ts` line by line, and the chain calls are settled by the live fork rather than by the plan.

- [ ] **Step 1: Failing tests for act's pure parts**

`agent/test/act.test.ts` tests `planActions(accepted, ctx)`, the pure planner that turns an accepted decision into an ordered list of steps the executor performs, so the transaction order and the reuse rule are checked without a chain:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { planActions } from "../act.ts";

const ctx = { vault: "0xv1", currentTarget: "0xa", vaultsByTarget: { "0xa": "0xv1", "0xb": "0xv2" }, vaultShares: 10n, walletUsdc: 500_000_000n };

test("a deposit and paper trades plan in order", () => {
  const steps = planActions({ note: "", split: { action: "deposit", amountUsdc: 100 }, source: { action: "stay", target: null }, trades: [{ side: "buy", asset: "ETH", sizeUsdc: 50, price: 4000, reasoning: "r" }] }, ctx);
  assert.deepEqual(steps.map((s) => s.kind), ["approve", "deposit", "paper_open"]);
  assert.equal((steps[1] as { amount: bigint }).amount, 100_000_000n);
});
test("a source move reuses an existing vault over that target and re-keys it", () => {
  const steps = planActions({ note: "", split: { action: "hold", amountUsdc: 0 }, source: { action: "move", target: "0xb" }, trades: [] }, ctx);
  assert.deepEqual(steps.map((s) => s.kind), ["redeem_all", "approve", "deposit", "rekey"]);
  assert.equal((steps[1] as { vault: string }).vault, "0xv2");
});
test("a source move to a new target creates and registers a vault first", () => {
  const steps = planActions({ note: "", split: { action: "hold", amountUsdc: 0 }, source: { action: "move", target: "0xc" }, trades: [] }, ctx);
  assert.deepEqual(steps.map((s) => s.kind), ["redeem_all", "create_vault", "accept", "register", "approve", "deposit", "rekey"]);
});
test("a withdrawal redeems the shares worth the amount", () => {
  const steps = planActions({ note: "", split: { action: "withdraw", amountUsdc: 50 }, source: { action: "stay", target: null }, trades: [] }, ctx);
  assert.deepEqual(steps.map((s) => s.kind), ["withdraw"]);
  assert.equal((steps[0] as { amount: bigint }).amount, 50_000_000n);
});
```

- [ ] **Step 2: Run, see them fail.**

- [ ] **Step 3: Implement act**

`agent/act.ts`:

```ts
import type { Decision } from "./fence.ts";

export type Step =
  | { kind: "approve" | "deposit" | "withdraw"; vault: string; amount: bigint }
  | { kind: "redeem_all"; vault: string }
  | { kind: "create_vault"; target: string } | { kind: "accept" } | { kind: "register" } | { kind: "rekey" }
  | { kind: "paper_open" | "paper_close"; trade: Decision["trades"][number] };
export type PlanContext = { vault: string | null; currentTarget: string | null; vaultsByTarget: Record<string, string>; vaultShares: bigint; walletUsdc: bigint };
const micro = (usdc: number): bigint => BigInt(Math.round(usdc * 1e6));

/** The ordered steps an accepted decision needs. Pure, so the order and the reuse rule are testable. */
export function planActions(d: Decision, c: PlanContext): Step[] {
  const steps: Step[] = [];
  const lc = (s: string | null) => (s ?? "").toLowerCase();
  if (d.source.action === "move" && d.source.target) {
    if (c.vault) steps.push({ kind: "redeem_all", vault: c.vault });
    const existing = Object.entries(c.vaultsByTarget).find(([t]) => lc(t) === lc(d.source.target))?.[1];
    const amount = c.vaultShares > 0n ? c.vaultShares : 0n; // redeemed principal comes back as USDC; the executor uses the actual balance delta
    if (existing) steps.push({ kind: "approve", vault: existing, amount }, { kind: "deposit", vault: existing, amount });
    else steps.push({ kind: "create_vault", target: d.source.target }, { kind: "accept" }, { kind: "register" }, { kind: "approve", vault: "new", amount }, { kind: "deposit", vault: "new", amount });
    steps.push({ kind: "rekey" });
  }
  if (d.split.action === "deposit" && c.vault) steps.push({ kind: "approve", vault: c.vault, amount: micro(d.split.amountUsdc) }, { kind: "deposit", vault: c.vault, amount: micro(d.split.amountUsdc) });
  if (d.split.action === "withdraw" && c.vault) steps.push({ kind: "withdraw", vault: c.vault, amount: micro(d.split.amountUsdc) });
  for (const t of d.trades) steps.push({ kind: t.side === "buy" ? "paper_open" : "paper_close", trade: t });
  return steps;
}
```

then the executor `act(steps, deps): Promise<void>` that writes to the log. Transactions use viem like `app/dashboard/app.js`'s deposit handler: `createVault(target, "Inferest Agent", "infVAULT")` on the Factory and `VaultCreated` from the receipt, `acceptManagement`, `approve` on USDC, `deposit(assets, address)`, `withdraw(assets, receiver, owner)` for a withdrawal by amount (the Inferest vault is ERC-4626, so `withdraw` takes assets), `redeem(shares, receiver, owner)` for `redeem_all`. After `redeem_all` the executor reads the wallet's USDC and deposits the delta into the next vault, replacing the planner's placeholder amount. `register` posts `/api/vaults` with the operator token and stores `vaultsByTarget` in `agent_meta`. `rekey` posts `/api/keys` on the new vault (name `agent`, weight 1), appends the id to the `keys` meta list, keeps the secret in memory (`deps.setKey(secret)`), and revokes the previous key through `/api/keys/:id/revoke`. `paper_open` calls `log.openPosition` with `sizeUsdc` and `price`; `paper_close` closes the oldest open position in that asset at `price` (partial sizes close the whole oldest position when its size is at most the requested size, then continue). Each executed step becomes a log action: `deposit`, `withdraw`, `move_source` (one action carrying the redeem and deposit hashes), `paper_open`, `paper_close`. A step that throws stops the run: the error goes into the run row and the remaining steps are recorded as `refused` with reason `not attempted: <error>`.

- [ ] **Step 4: The run loop**

`agent/run.ts`:

```ts
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync } from "node:fs";
import { openAgentLog } from "./log.ts";
import { readBook, publicClient, usd } from "./book.ts";
import { rateFrom } from "./rate.ts";
import { applyFence } from "./fence.ts";
import { think } from "./think.ts";
import { planActions, act } from "./act.ts";
import { createFaucet } from "../app/faucet.ts";

const env = (k: string, fallback?: string): string => { const v = process.env[k] ?? fallback; if (v === undefined) throw new Error(`missing env ${k}`); return v; };
const once = process.argv.includes("--once");
const cfg = {
  rpcUrl: env("RPC_URL"), api: env("API_URL", "http://localhost:8787"), adminToken: env("ADMIN_TOKEN"), dbPath: env("DB_PATH", "inferest.db"),
  key: env("AGENT_PRIVATE_KEY") as Hex, bookUsdc: Number(env("AGENT_BOOK_USDC", "1000")), floorUsdc: Number(env("AGENT_FLOOR_USDC", "200")),
  intervalMs: Number(env("AGENT_INTERVAL_MS", "600000")), demoDays: Number(env("AGENT_DEMO_DAYS", "0")), model: env("AGENT_MODEL", process.env.DEMO_MODEL ?? "moonshotai/kimi-k2.6"),
  maxTurns: Number(env("AGENT_MAX_TURNS", "10")), maxToolCalls: Number(env("AGENT_MAX_TOOL_CALLS", "4")), tradeCapBps: Number(env("AGENT_TRADE_CAP_BPS", "2000")),
};
const chainCfg = JSON.parse(readFileSync(process.env.CHAIN_CONFIG ?? "config/arbitrum-one.json", "utf8"));
const dep = JSON.parse(readFileSync(env("DEPLOYMENTS"), "utf8"));
const targets: { address: Hex; name: string }[] = chainCfg.targets ?? [{ address: chainCfg.target, name: chainCfg.targetName ?? "yield source" }];
```

then: the account, wallet client and public client; `api(path, body)` with `x-admin-token`; the log; `ensureRegistered()` (first start: fund on a fork when `demoDays > 0` and the wallet holds no USDC, deposit `bookUsdc / 2` into a vault over `targets[0]` through the same steps as a source move, register, mint the key; later starts: rotate the current key and keep the secret); `advanceClock()` when `demoDays > 0` (`evm_increaseTime` then `evm_mine`, falling back to `tenderly_setNextBlockTimestamp` style methods the faucet already probes for); `runOnce()`: `startRun` with the book, sweep any old-vault shares (redeem where `vaultsByTarget` names a vault that is not current and the wallet holds its shares), build the `PromptBook` with rates from `log.lastSamples`, `think`, on `outOfBudget` finish the run with that status and the fixed note, otherwise `applyFence`, log refusals, `planActions`, `act`, mark positions at the prices the decision used, `finishRun` with the book after, then `setMeta("book", ...)`; `monthEnd()` every fourth run calls `POST /api/admin/settle` for every vault in `vaultsByTarget`. The MCP client is created per run exactly as `demo/agent.ts` does, with the fresh key, and closed after. The loop: `runOnce`, then `once ? exit : sleep(intervalMs)`; an uncaught error in a run is written to the run row as `failed` and the loop continues. Log lines are one per run: `run <id> <status> models $x tools $y` with no secrets.

- [ ] **Step 5: Docs, scripts, env**

`package.json` script `agent`; `.env.example` block:

```
# the hosted agent (npm run agent)
AGENT_PRIVATE_KEY=
AGENT_BOOK_USDC=1000
AGENT_FLOOR_USDC=200
AGENT_INTERVAL_MS=600000
# days the chain clock moves before each run on a fork or a Tenderly testnet; 0 on a real chain
AGENT_DEMO_DAYS=7
AGENT_MODEL=
AGENT_MAX_TURNS=10
AGENT_MAX_TOOL_CALLS=4
AGENT_TRADE_CAP_BPS=2000
```

README: a paragraph "The hosted agent" under the demos: what it is, `npm run agent`, `--once`, and that its key never touches disk.

- [ ] **Step 6: Green, smoke, commit**

Run: `npm test && npm run typecheck`. Smoke, by the controller on a fresh fork after `npm run demo:treasury`: `npm run agent -- --once` twice, then `sqlite3 inferest.db "select id, status, note from agent_runs"` shows two rows and `curl -s localhost:8787/api/agent | head -c 400` answers.

```bash
git add agent/act.ts agent/run.ts agent/test/act.test.ts package.json .env.example README.md
git commit -m "The agent runner: act on a fenced decision with its own wallet, run on a schedule, settle at month end"
```

---

### Task 7: The Agents page

**Files:**
- Modify: `app/dashboard/agents.html`, `app/dashboard/agents.js`, `app/dashboard/styles.css`
- Modify: `docs/07-walkthrough.md` (a short "Agents" section at the end), `README.md`

**Interfaces:**
- Consumes: `GET /api/agent` from Task 3, `snippets()` and `NOTES` from `snippets.js`, the `usd`/`spent` formatting from `app.js` (copy the two one-liners; `app.js` is not a module the page can import without pulling the Dynamic session code).

- [ ] **Step 1: Markup**

`agents.html` sections in order, all `class="wrap"` inside `<main>`: the head (`#agenttag`, `#agenthead` with the two-line headline), the book card (`#splitbar` with `.seg parked` and `.seg working` and a `.floor` marker, `#parked` details, `#working` details, `#positions` table), the budget card (copy the yield card markup from `treasury.html` with the same ids, `yield`, `barused`, `usedamt`, `openamt`, `models`, `tools`, `backstop`, and the settle preview ids, without the Principal bar and Shares cell), `#runs` (a `<ul class="feed runs">`), `#sources` table, `#activity` feed, and the strip `#own` with a `<div class="tabs" id="tabs"></div><pre id="snippet"></pre>` and two links.

- [ ] **Step 2: Script**

`agents.js` renders from one `render(data)`:

- tag: `Agent · run ${agent.runCount} · period ${agent.period}` plus the live chip; headline: `It pays for its own thinking.` / `${usd(bookTotal, 0)}. Half parked, half at work. The interest funds the model.` where `bookTotal = walletUsdc + vaultValue`.
- split bar: parked width `vaultValue / total`, working the rest, the floor marker at `floor / total`.
- parked: `${source.name} · ${rate}` with `rate` as `x.xx% a year` or `rate unknown yet`, and `vaultValue`; working: `walletUsdc` USDC and the positions table (asset, side, size, entry, mark, change as `(mark / entry - 1) * size` signed).
- budget: the same code as `renderTreasury`'s yield card part, over `data.budget`.
- runs: newest first; each `<li>`: the clock date (`new Date(clockAt * 1000)` as `Sep 27`), the status chip (`thinking` for `running`, `out of budget` for `out_of_budget`, `failed`), the note, the actions as small rows (`deposit 50 USDC ↗`, `moved to Fluid USDC ↗`, `paper buy ETH 50 USDC at 4,000`, `refused: <what>, <reason>`), the tool calls count, and `models $x · tools $y` from `cost` with the `spent` formatter.
- sources: one row per source, `current` bold with a lime `here` chip.
- activity: settlements (the Treasury page's rows) and the on-chain actions from runs with a `tx`, merged and sorted by time.
- own: `snippets(location.origin, "sk-inf-YOUR-KEY")` filtered to the Agent config and MCP tabs, the tab buttons as on the Treasury page, plus links to `/treasury#use-a-key` and `https://github.com/moyedx3/inferest/tree/main/agent`.

Polling: `load()` fetches `/api/agent`; on 404 it shows the "no agent yet" line in `#runs` and keeps polling; on 200 it renders; `setInterval(load, 10_000)`. Errors go to a `.fine` line, never a thrown exception. Nothing on the page reads the wallet or the chain.

- [ ] **Step 3: Styles**

Add to `styles.css`: `.splitbar` like `.yieldbar` with `.seg.parked` in blue and `.seg.working` in the soft blue, `.floor` as a 1px ink line positioned by `left: N%`; `.runs li` with the status chip variants (`.status.wait`, `.status.err`); `.positions td.up { color: #2f7d4f } .positions td.down { color: var(--red) }`.

- [ ] **Step 4: Docs**

`docs/07-walkthrough.md`: an "Agents" section: open `/agents`, what each card is, that a run appears every interval and the clock moves on a fork, and the 402 line. README: one sentence in the site description.

- [ ] **Step 5: Verify and commit**

Run: `npm test && npm run typecheck`, then the smoke from Task 6 with the server up and a browser on `/agents`: the run cards show, the split bar and floor draw, the budget card matches `/treasury` for the agent's vault under the operator token, the strip's snippets carry the placeholder.

```bash
git add app/dashboard/agents.html app/dashboard/agents.js app/dashboard/styles.css docs/07-walkthrough.md README.md
git commit -m "The Agents page: the book, the budget, the runs, the sources, and the strip for your own agent"
```

---

## Self-review notes

- Spec coverage: site shape (Task 2), the agent and the run (Tasks 4 to 6), the fence (Task 4), architecture and tables (Tasks 3 and 6), yield sources (Task 1), the page (Task 7), configuration (Tasks 1 and 6), testing (each task; the browser walkthrough is the controller's live pass after Task 7).
- Type consistency: `Decision`, `Trade`, `FenceContext` live in `agent/fence.ts`; `Run`, `Action`, `AgentLog` in `agent/log.ts`; `rateFrom` in `agent/rate.ts` from Task 3 on; `Step`, `PlanContext`, `planActions`, `act` in `agent/act.ts`; `Mcp`, `PromptBook`, `ThinkResult`, `think` in `agent/think.ts`.
- Review Focus 1, 2, 4, 5 have tests in Tasks 4, 5, 3, 4. Review Focus 3 is covered by the planner test in Task 6 ("reuses an existing vault over that target and re-keys it").
