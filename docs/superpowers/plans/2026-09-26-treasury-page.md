# Treasury Page Implementation Plan

> **For agentic workers:** execute task by task with superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dashboard and the setup page become one Treasury page with three states (signed out, no vault yet, signed in), styled after the chosen mockups, with no change to what any button does.

**Architecture:** The server adds two derived figures per vault to `/api/state` (open credit and a settle preview, both from the ledger kernel), redirects `/setup` into the page and serves a stylesheet. The browser page stays plain HTML, CSS and ES modules: `index.html` holds the markup of every section, `styles.css` the look, and `app.js` renders sections from one `/api/state` read plus the wallet's own reads of principal and USDC balance. `data-state` on `<body>` picks which sections show.

**Tech Stack:** Node 26 native TypeScript, `node:test`, `node:http`; browser ES modules, viem from esm.sh as today, the existing Dynamic bundle; Google Fonts (Newsreader, Geist, Geist Mono).

**Spec:** [`docs/superpowers/specs/2026-09-26-treasury-page-design.md`](../specs/2026-09-26-treasury-page-design.md). **Mockups:** `design/treasury-signed-out.png`, `design/treasury-no-vault.png`, `design/treasury-signed-in.png`. The spec is the authority.

## Global Constraints

- Verification for every task: `npm test` and `npm run typecheck` (must print nothing).
- TypeScript is erasable syntax only; relative imports carry `.ts`. Dashboard files are plain browser JavaScript.
- No behaviour change: every action in `docs/07-walkthrough.md` keeps its API call, its confirmation and its order of wallet signatures.
- Secrets: a new key's secret lives only in the banner and the snippet window until the banner is closed; closing clears both. Nothing secret goes to the activity feed.
- No event names in committed files. English prose: no em dashes, American spelling.
- Never read `.env`. Never commit `.env*`, `inferest.db*`, `.obsidian/workspace.json`, `contracts/deployments/42161.json`, `app/dashboard/dynamic.bundle.js` or the `.pen` scratch file at the repo root. Stage files by name.
- Branch per task off `main` (`treasury-<slug>`), reviewed with /code-review, merged with `git merge --no-ff` only when clean.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## File Structure

```
app/limits.ts                 MOD  settlePreview over the kernel's settle
app/server.ts                 MOD  credit and preview in state; /setup redirect; text/css
app/test/limits.test.ts       MOD
app/test/server.test.ts       MOD
app/dashboard/index.html      REWRITE  sections: top bar, sign-in hero, treasury, keys, use a key, activity, footer
app/dashboard/styles.css      NEW
app/dashboard/app.js          REWRITE  same calls, per-section render, activity feed
app/dashboard/setup.html      DELETE
docs/07-walkthrough.md        MOD  labels
README.md                     MOD  /setup line
```

---

### Task 1: State carries open credit and a settle preview; /setup and CSS (branch `treasury-state`)

**Files:** `app/limits.ts`, `app/server.ts`, `app/test/limits.test.ts`, `app/test/server.test.ts`, delete `app/dashboard/setup.html`.

- [ ] **Step 1: failing tests for `settlePreview`** in `app/test/limits.test.ts`:

```ts
test("the settle preview matches the kernel: usage, 10% of the leftover, the rest returned", () => {
  const p = settlePreview(2_225, [key("a", 2, 300.12, 12.28), key("b", 1, 126.82, 24.54), key("c", 1, 36.24)], HACKATHON_PARAMS);
  close(p.usage, 500); close(p.fee, 172.5); close(p.returned, 1552.5);
});

test("the settle preview grosses model spend up by the rail fee", () => {
  const p = settlePreview(1_000, [key("a", 1, 95, 10)], { ourFee: 0.1, railFee: 0.05 });
  close(p.usage, 110); close(p.fee, 89); close(p.returned, 801);
});

test("the settle preview never takes a fee on spend above yield", () => {
  const p = settlePreview(100, [key("a", 1, 150)], HACKATHON_PARAMS);
  close(p.usage, 150); close(p.fee, 0); close(p.returned, 0);
});
```

- [ ] **Step 2:** run `npm test`; expect failure (`settlePreview` not exported).
- [ ] **Step 3: implement** in `app/limits.ts`:

```ts
import { settle, type Params } from "../engine/ledger.ts";

export type SettlePreview = { usage: number; fee: number; returned: number };

/**
 * What settling now would do, from the kernel's own settle(): the period's yield as a position whose accrued
 * yield is `yieldUsd`, spent by every key of the vault (the same keys usageMicro bills). A preview only: the
 * Splitter's feeBps and the chain's yield at settle time decide.
 */
export function settlePreview(yieldUsd: number, keys: KeyInput[], params: Params): SettlePreview {
  const spent = keys.reduce((s, k) => s + Math.max(0, k.modelSpent), 0);
  const toolSpent = keys.reduce((s, k) => s + k.toolSpent, 0);
  const r = settle({ principal: 0, shares: Math.max(0, yieldUsd), spent, toolSpent }, 1, params);
  return { usage: r.usage, fee: r.fee, returned: r.returned };
}
```

(Change the existing `import type { Params }` line so `settle` is a value import.)

- [ ] **Step 4:** `npm test`; the three tests pass.
- [ ] **Step 5: failing server tests** in `app/test/server.test.ts`:

```ts
test("state carries each vault's open credit and settle preview", async () => {
  const { base, server, store } = await start();
  store.addVault(V, "0x00000000000000000000000000000000000000cc", "Treasury");
  store.setVaultState(V, { yieldUsd: 2_225 });
  store.addKey({ id: "k1", vault: V, name: "a", weight: 1, secretSha256: "h1" });
  store.recordModelCall({ keyId: "k1", model: "m", costUsd: 500, generationId: "g1" });
  const v = (await stateAs(base, { "x-admin-token": "admin" })).vaults[0];
  assert.equal(v.credit, 2_225);
  assert.deepEqual(v.preview, { usage: 500, fee: 172.5, returned: 1552.5 });
  store.setVaultState(V, { frozen: true });
  assert.equal((await stateAs(base, { "x-admin-token": "admin" })).vaults[0].credit, 0);
  server.close();
});

test("/setup sends developers to the page's snippets", async () => {
  const { base, server } = await start();
  const r = await fetch(base + "/setup", { redirect: "manual" });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/#use-a-key");
  server.close();
});

test("the stylesheet is served as CSS", async () => {
  const { base, server } = await start();
  const r = await fetch(base + "/styles.css");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/css/);
  server.close();
});
```

Replace the test `serves the setup page and exposes the public URL in state` with one that only checks `state.config.publicUrl`. Adjust the store calls to the real signatures if they differ (read `app/store.ts`); if `recordModelCall` does not move `modelSpent`, use whatever the proxy tests use to book spend. Create an empty `app/dashboard/styles.css` so the CSS test has a file.

- [ ] **Step 6:** `npm test`; expect the three to fail.
- [ ] **Step 7: implement** in `app/server.ts`:
  - In `state()`, per vault: `credit: v.frozen ? 0 : Math.max(0, v.yieldUsd) * (1 - d.params.railFee)` and `preview: settlePreview(v.yieldUsd, keys, d.params)`.
  - Before `serveStatic`, `if (url.pathname === "/setup") { res.writeHead(302, { Location: "/#use-a-key" }); res.end(); return; }` at the same place the setup route is decided today.
  - `serveStatic`: drop the `setup.html` mapping; content type `.js` → `text/javascript`, `.css` → `text/css`, else `text/html`.
  - `git rm app/dashboard/setup.html`.
- [ ] **Step 8:** `npm test` and `npm run typecheck` clean.
- [ ] **Step 9:** commit `State carries each vault's open credit and settle preview; /setup redirects into the page`. Review with /code-review, fix, merge.

---

### Task 2: The Treasury page (branch `treasury-page`)

**Files:** `app/dashboard/index.html`, `app/dashboard/styles.css`, `app/dashboard/app.js`, `app/server.ts`, `app/test/server.test.ts`, delete `app/dashboard/setup.html`.

_Moved here from Task 1 after its review: the `/setup` redirect (302 to `/#use-a-key`, with its test replacing `serves the setup page`) and the deletion of `setup.html`, so `/setup` never points at a section that does not exist yet._

The mockup PNGs are the reference for spacing, type and color; the spec's Visual system gives the tokens. Build section by section and compare each against the PNG.

- [ ] **Step 1: tokens and base** in `styles.css`: CSS custom properties for every color in the spec (`--bg #F4F2EE`, `--surface #FFF`, `--surface-2 #FAF9F6`, `--ink #151513`, `--ink-2 #5F5B54`, `--ink-3 #A19C93`, `--line #E4E0D8`, `--lime #E3F25A`, `--blue #4E6AF0`, `--blue-soft #D9E0FC`, `--red #C4432F`), fonts, `.wrap` (max-width 1200px, auto margins), `.tag`, `.serif-2line` headline pair, `.card`, pill buttons (`.btn`, `.btn-primary`, `.btn-quiet`), inputs, `.mono`, and the state switch:
  `body[data-state="out"] .in-only, body:not([data-state="out"]) .out-only, body[data-state="novault"] .vault-only, body[data-state="vault"] .novault-only { display: none; }`
  Media query below 900px: columns stack, the key table rows become cards.
- [ ] **Step 2: markup** in `index.html`, top to bottom, with the Google Fonts `<link>` and `styles.css`:
  1. Top bar: wordmark; `#network` pill; `.in-only` account (`#who`, `#address`, `#walletlist`, `#linkwallet`, `#linkproviders`, `#signout`).
  2. `.out-only` sign-in hero: headline pair, three facts, sign-in card holding `#loggedout` (`#email`, `#sendcode`, `#codebox` with `#code` and `#verify`, `#connectwallet`, `#providers`), `#operatorhint`, and a slot `#operatorslot` the operator input moves into when login is off.
  3. `.in-only` Treasury `#treasury`: `#treasurytag` (tag or vault picker `<select id="vaultpick">`), headline `#headline`, `.vault-only` yield card (`#yield`, `#vaultname`, `#vaultlink`, bar `#barused`/`#baropen`, `#principalbar`, breakdown `#models`, `#tools`, `#backstop`, `#shares`), `.novault-only` steps list (`#stepfunds` marks done after funding), side column with the deposit card (`#fund`, `#amount`, `#open` whose label is "Deposit" or "Create vault and deposit", `#walletbalance`, `#withdraw`) and the `.vault-only` settle card (`#pvusage`, `#pvfee`, `#pvreturned`, `#settle`, `#report`, `#sync`).
  4. `.in-only` Keys: headline, form (`#keyname`, `#weight`, `#addkey`, disabled in no-vault), `#keystable` with an empty-state row.
  5. `#use-a-key` (all states): notes list from `NOTES`, `#panel` banner (`#paneltitle`, `#secret`, `#copysecret`, `#closepanel`), code window (`#tabs`, `#copysnippet`, `#snippet`).
  6. `.in-only` Activity `#activity`.
  7. Footer: wordmark, `#contracts`, `<details id="operator">` with `#token`.
- [ ] **Step 3: app.js** keeps every handler it has (sign-in, providers, wallet pick, sign out, fund, open, withdraw, sync, report, addkey, rotate, revoke, settle, token change) and their API calls unchanged. Changes:
  - `log(m)` becomes `activity({ icon, title, detail, tx, error })`, prepending a row to `#activity` (time `HH:MM`; tx links to `${cfg.explorer}/tx/${tx}` when `cfg.explorer`). Every existing `log` call maps to a titled event; errors use `error: true`. On render, settlements from `state.settlements` for the shown vault are listed under the session's events, deduplicated by tx.
  - `setState()` sets `document.body.dataset.state` to `out` (no session and no token), `novault` (signed in, no vault visible) or `vault`.
  - `renderTreasury(v)`: yield, bar widths (used share of `credit`, min 10% width when used > 0 so its label fits), preview figures, backstop text (`no provider key yet` when `!v.hasOpenRouterKey`), `frozen`/`settling` chips in the tag, period in the tag and the settle card.
  - `renderWallet()`: when a wallet session and a vault: `balanceOf(address)` and `convertToAssets(shares)` on the vault for Principal, Shares and the headline amount, `balanceOf` on USDC for the wallet balance; operator mode hides the principal bar and shares and uses "Your vault earns, your keys spend." as the headline.
  - `renderKeys(v)`: rows per the spec, `new` chip on the id returned by the last create, spend bar widths from `modelSpent`/`toolSpent` against `budget`.
  - Snippets always render: with the shown secret when the banner is open, `sk-inf-YOUR-KEY` otherwise. Closing the banner clears the secret and re-renders with the placeholder.
  - Operator: with several vaults, `#vaultpick` lists them and every section follows the picked one; when login is off, `#token` moves into `#operatorslot`.
  - Money formatting: one `usd(n, digits = 2)` helper with thousands separators.
- [ ] **Step 4: preview harness (not committed)**: `/tmp/treasury-preview.ts` starts `createApp` with the fakes from `app/test/server.test.ts`, login off, admin token `preview`, a vault with yield 2,225, three keys with the mockup's spend and one revoked, and one completed settlement; serves on port 8799. Run it, open `http://localhost:8799`, and compare each state with the PNGs: signed out (no token), no vault (token, vaults removed), signed in (token). Screenshot each.
- [ ] **Step 5:** `npm test`, `npm run typecheck`, then commit `The dashboard and setup page become one Treasury page`. Review, fix, merge.

---

### Task 3: Docs (branch `treasury-docs`)

- [ ] `docs/07-walkthrough.md`: new labels (Deposit card, "If you settle now", Use a key, Activity), `/setup` now the page's Use a key section.
- [ ] README: the `/setup` line points at the page's Use a key section.
- [ ] Commit, review, merge.

## After the last task

A full walkthrough on an anvil fork with Dynamic login is the user's check (it needs their `.env` and an email inbox). Report what was verified with the preview harness and what was not.
