# Design Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live Home and Agents pages match `design/home.png` and `design/agents.png`, put the i logo on all three pages, and port the How it works step-through, without changing what the pages read or do.

**Architecture:** The dashboard stays plain HTML, CSS and ES modules with no build step. Home gains one module, `home.js`, for the calculator, the two live glimpses and the step-through; the calculator's sums live in a small pure module, `calc.js`, that both the page and a unit test import. The Agents page keeps its data flow (`GET /api/agent` every ten seconds) and only changes how it renders, with one addition to the endpoint: a `fence` object the runner writes into its meta. The logo is two SVG files served like any other dashboard asset, with `serveStatic` learning the SVG content type.

**Tech Stack:** Node 26 native TypeScript (erasable syntax, `.ts` imports), `node:test`, plain browser ES modules, the existing `styles.css` tokens, inline SVG icons taken from lucide (MIT).

**Spec:** `docs/superpowers/specs/2026-09-27-design-pass.md`

## Global Constraints

- Erasable TypeScript only; relative imports end in `.ts`; `npm test` and `npm run typecheck` fully green after every task.
- Prose, comments and commit messages: no em dashes, American spelling, no event names.
- Every commit ends with the two trailers: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_017pfxD343MHfruJDutYH1Qy`.
- Never stage `.env*` (other than `.env.example`), `inferest.db*`, `contracts/deployments/42161.json`, `.obsidian/workspace.json`, `app/dashboard/dynamic.bundle.js`.
- The pages read only what they read today: Home reads `GET /api/agent` (for the demo preset and the agent glimpse) and nothing else; Agents reads `GET /api/agent` and one `GET /api/state` for the explorer URL and the network chip; Treasury is unchanged apart from the logo. No Dynamic bundle on Home or Agents, no chain reads.
- Tokens, fonts, cards, tags and the top bar are the ones in `styles.css`; new rules reuse the variables. Home has no network pill. Example figures in the mockups are never hard-coded as data.
- Every string that comes from the server or the model (notes, reasons, names, tool names) passes through `esc()` where it meets innerHTML.
- Icons are inline SVG with `aria-hidden="true"`, path data copied from lucide-static (`https://unpkg.com/lucide-static/icons/<name>.svg`), 24-unit viewBox, `stroke="currentColor"`, `stroke-width="2"`, sized by CSS; a comment names the icon.

## Review Focus

1. **The calculator at the defaults** ($100,000, 4.5%, Kimi K2.6) must show $375.00 interest, $356.25 credit, 208M tokens, $0.0078 a call, about 45,700 calls a month and 1,520 a day; a reviewer should recompute. Test in Task 3.
2. **A 404 from `/api/agent` on Home**: the "our demo agent" preset falls back to a 500 USDC deposit and the agent glimpse hides while the card stays; nothing throws. Test in Task 4 (pure part) and the browser pass.
3. **`prefers-reduced-motion`**: the step-through must not autoplay and the dots must not animate; prev and next still work from the keyboard. Browser pass in Task 4.
4. **Agents page with a `running` run**: the head shows "thinking now" with a pulse, the run card has an ink border, the note is sans; when no run is running the chip is hidden. Browser pass in Task 5 with a fake response.
5. **The fence card without a `fence` in the response** (an older store): the card shows the defaults and says so, never blanks. Test in Task 2 (endpoint defaults) and Task 5 (render).

---

### Task 1: The logo on all three pages

**Files:**
- Create: `app/dashboard/inferest-icon.svg`, `app/dashboard/favicon.svg` (copies of `design/logo/inferest-icon.svg` and `design/logo/favicon.svg`)
- Modify: `app/server.ts` (`serveStatic` content types), `app/dashboard/styles.css` (`.brand::before`, `footer .brand::before`), `app/dashboard/home.html`, `app/dashboard/treasury.html`, `app/dashboard/agents.html` (the `<link rel="icon">`)
- Test: `app/test/server.test.ts`

**Interfaces:**
- Produces: `/inferest-icon.svg` and `/favicon.svg` served as `image/svg+xml`.

- [ ] **Step 1: Failing route test**

Append to `app/test/server.test.ts`:

```ts
test("the logo files are served as SVG images", async () => {
  const { base, server } = await start();
  for (const path of ["/inferest-icon.svg", "/favicon.svg"]) {
    const r = await fetch(base + path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get("content-type"), "image/svg+xml", path);
    assert.ok((await r.text()).includes("<svg"), path);
  }
  server.close();
});
```

- [ ] **Step 2: Run it, see it fail** (`node --test --test-timeout=60000 app/test/server.test.ts`: 404 or `text/html`).

- [ ] **Step 3: Serve SVG**

In `serveStatic`, replace the `Content-Type` expression with a lookup:

```ts
const TYPES: Record<string, string> = { js: "text/javascript", css: "text/css", svg: "image/svg+xml", html: "text/html" };
...
    res.writeHead(200, { "Content-Type": TYPES[file.split(".").pop() ?? ""] ?? "text/html" });
```

Copy the two SVG files into `app/dashboard/` with `cp`. In `styles.css`:

```css
.brand::before { content: ""; width: 22px; height: 22px; background: url(/inferest-icon.svg) center / contain no-repeat; }
footer .brand::before { width: 16px; height: 16px; }
```

(replace the two existing `.brand::before` rules; the gap stays 10px). In each of the three pages' `<head>`, after the viewport meta: `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />`.

- [ ] **Step 4: Green, commit**

Run: `npm test && npm run typecheck`

```bash
git add app/dashboard/inferest-icon.svg app/dashboard/favicon.svg app/server.ts app/dashboard/styles.css app/dashboard/home.html app/dashboard/treasury.html app/dashboard/agents.html app/test/server.test.ts
git commit -m "The i logo in the top bar, the footer and the tab of all three pages"
```

---

### Task 2: The fence in `GET /api/agent`

**Files:**
- Modify: `agent/run.ts` (write the `fence` meta), `app/server.ts` (`fence` in the response), `app/test/server.test.ts`

**Interfaces:**
- Produces: `fence: { floorUsdc: number; tradeCapBps: number; maxToolCalls: number; maxTurns: number; maxTrades: number; assets: string[]; splitMovesPerRun: 1; sourceMovesPerRun: 1; fromRunner: boolean }` in the `/api/agent` response. `fromRunner` is false when the meta is absent and the defaults were used.

- [ ] **Step 1: Failing test**

In the existing `/api/agent` server test, after the 200 assertions, add:

```ts
  assert.deepEqual(body.fence, { floorUsdc: 200, tradeCapBps: 2000, maxToolCalls: 4, maxTurns: 10, maxTrades: 3, assets: ["ETH", "BTC", "ARB"], splitMovesPerRun: 1, sourceMovesPerRun: 1, fromRunner: false });
  log.setMeta("fence", JSON.stringify({ floorUsdc: 250, tradeCapBps: 1500, maxToolCalls: 2, maxTurns: 6 }));
  const again: any = await (await fetch(base + "/api/agent")).json();
  assert.equal(again.fence.floorUsdc, 250);
  assert.equal(again.fence.maxToolCalls, 2);
  assert.equal(again.fence.maxTrades, 3);
  assert.equal(again.fence.fromRunner, true);
```

- [ ] **Step 2: Run it, see it fail.**

- [ ] **Step 3: Implement**

`app/server.ts`, in the `/api/agent` handler before `send`:

```ts
    const fenceMeta = (() => { try { return JSON.parse(log.getMeta("fence") ?? "null"); } catch { return null; } })();
    const fence = {
      floorUsdc: Number(fenceMeta?.floorUsdc ?? log.getMeta("floor") ?? 200), tradeCapBps: Number(fenceMeta?.tradeCapBps ?? 2000),
      maxToolCalls: Number(fenceMeta?.maxToolCalls ?? 4), maxTurns: Number(fenceMeta?.maxTurns ?? 10),
      maxTrades: MAX_TRADES, assets: [...ASSETS], splitMovesPerRun: 1, sourceMovesPerRun: 1, fromRunner: fenceMeta !== null,
    };
```

with `import { ASSETS, MAX_TRADES } from "../agent/fence.ts";` and `fence,` in the response object. `agent/run.ts`, next to `setMeta("floor", ...)`: `log.setMeta("fence", JSON.stringify({ floorUsdc: cfg.floorUsdc, tradeCapBps: cfg.tradeCapBps, maxToolCalls: cfg.maxToolCalls, maxTurns: cfg.maxTurns }));`. Spec Architecture, Server: add `fence` to the response shape sentence.

- [ ] **Step 4: Green, commit**

```bash
git add agent/run.ts app/server.ts app/test/server.test.ts docs/superpowers/specs/2026-09-27-agent-page-design.md
git commit -m "GET /api/agent carries the fence the runner enforces"
```

---

### Task 3: Home hero and calculator

**Files:**
- Create: `app/dashboard/calc.js`, `app/dashboard/calc.d.ts`, `app/dashboard/home.js`, `app/test/calc.test.ts`
- Modify: `app/dashboard/home.html` (hero, calculator section, script tag), `app/dashboard/styles.css`

**Interfaces:**
- Produces: `calc.js` exports `PRICES` (the five models, dated), `PRESETS`, `RATES = [0.04, 0.045, 0.05, 0.06]`, `RAIL_FEE = 0.05`, `compute({ deposit, rate, modelId })`, `tokensText(n)`, `callsText(n)` (a month, nearest hundred), `callsDayText(n)` (a day, nearest ten); `home.js` renders the calculator and, in Task 4, the glimpses and the step-through.

- [ ] **Step 1: Failing calc tests**

`app/test/calc.test.ts`:

```ts
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
```

- [ ] **Step 2: Run, see them fail** (`node --test --test-timeout=60000 app/test/calc.test.ts`).

- [ ] **Step 3: The pure module**

`app/dashboard/calc.js`:

```js
// The calculator's sums. OpenRouter list prices, dollars per 1M tokens, checked against https://openrouter.ai/api/v1/models on 2026-09-27.
export const PRICES = [
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", in: 0.348, out: 0.696 },
  { id: "moonshotai/kimi-k2.6", name: "Kimi K2.6", in: 0.95, out: 4.0 },
  { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", in: 2.0, out: 10.0 },
  { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", in: 4.0, out: 20.0 },
  { id: "openai/gpt-5.5", name: "GPT-5.5", in: 5.0, out: 30.0 },
];
export const PRICES_DATE = "September 2026";
export const RATES = [0.04, 0.045, 0.05, 0.06];
export const RAIL_FEE = 0.05;
/** Deposits from docs/04-unit-economics.md: the principal that covers $200, $50 and $10,000 a month. The demo agent's comes from the page. */
export const PRESETS = [
  { label: "a solo developer", icon: "user", deposit: 56_100, modelId: "anthropic/claude-sonnet-5" },
  { label: "an always-on agent", icon: "bot", deposit: 14_000, modelId: "moonshotai/kimi-k2.6" },
  { label: "a 20-person team", icon: "users", deposit: 2_810_000, modelId: "anthropic/claude-sonnet-5" },
  { label: "our demo agent", icon: "sparkles", deposit: null, modelId: "moonshotai/kimi-k2.6" },
];
const blended = (m) => (3 * m.in + m.out) / 4; // 3 in for every 1 out
const perCall = (m) => (4000 * m.in + 1000 * m.out) / 1e6; // a call is 4K in, 1K out

/** What a deposit buys a month at a vault rate on a model, and the same credit on every other model. */
export function compute({ deposit, rate, modelId }) {
  const model = PRICES.find((m) => m.id === modelId) ?? PRICES[1];
  const interest = (deposit * rate) / 12;
  const credit = interest * (1 - RAIL_FEE);
  const tokens = (credit / blended(model)) * 1e6;
  const callsMonth = credit / perCall(model);
  const others = PRICES.map((m) => ({ id: m.id, name: m.name, tokens: (credit / blended(m)) * 1e6 }));
  return { model, interest, credit, tokens, perCall: perCall(model), callsMonth, callsDay: callsMonth / 30, others };
}
/** Millions with no decimals under 1,000M, billions with one decimal above. */
export const tokensText = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : `${Math.max(1, Math.round(n / 1e6))}M`);
/** Calls a month, rounded to the nearest hundred. */
export const callsText = (n) => (Math.round(n / 100) * 100).toLocaleString("en-US");
/** Calls a day, rounded to the nearest ten, so the worked example reads 1,520. */
export const callsDayText = (n) => (Math.round(n / 10) * 10).toLocaleString("en-US");
```

`app/dashboard/calc.d.ts`:

```ts
export type Price = { id: string; name: string; in: number; out: number };
export type Preset = { label: string; icon: string; deposit: number | null; modelId: string };
export const PRICES: Price[];
export const PRICES_DATE: string;
export const RATES: number[];
export const RAIL_FEE: number;
export const PRESETS: Preset[];
export function compute(i: { deposit: number; rate: number; modelId: string }): {
  model: Price; interest: number; credit: number; tokens: number; perCall: number; callsMonth: number; callsDay: number;
  others: { id: string; name: string; tokens: number }[];
};
export function tokensText(n: number): string;
export function callsText(n: number): string;
export function callsDayText(n: number): string;
```

The test imports `../dashboard/calc.js`, and TypeScript takes the types from the sibling `calc.d.ts`. If `npm run typecheck` reports TS7016 on that import, make sure `tsconfig.json`'s `include` covers `app/dashboard/*.d.ts`. `npm test` runs `app/test/*.test.ts`, so the test is found.

- [ ] **Step 4: Calc tests green.**

- [ ] **Step 5: The hero and the calculator markup**

`home.html`: keep the top bar (no network pill), the facts and the footer. Hero: the `h1` and a `p.lede` side by side in `.hero .wrap` (flex, `align-items: flex-end`, gap 64px; the paragraph 440px wide), facts below full width; padding `88px 120px 56px` at 1440 and the existing responsive fallback below 900px. Add `.hero h1 { font-size: 88px; letter-spacing: -2.6px; }` scoped to `.home` on `<body class="home">` so Treasury's hero is untouched.

The calculator section `<section class="calc" id="calculator">`, in order: tag `Calculator`; `.head` with the two-line h2 ("What your deposit buys." / "Counted in the models you actually call.") and the 400px aside "Rule of thumb: interest covers a monthly budget when the deposit is about 281 times it. The principal is never spent."; the presets row (`<span class="fine">Try a preset</span>` and four `button.preset` rendered by `home.js` from `PRESETS`, each with its lucide icon and label); then `.card.calc-card` split into `.inputs` (380px, right border) and `.outputs`.

Inputs: a `label` "Deposit" with `input#deposit` (mono 24px, `inputmode="numeric"`, formatted with thousands separators on blur, a `USDC` suffix) and `input#depositlog type="range" min="0" max="1000" value="500"` mapped as `deposit = 1000 × 10^(v / 250)` (so 500 is $100K, 0 is $1K, 1000 is $10M) with tick labels $1K, $10K, $100K, $1M, $10M; "Vault rate" as a `.segmented` of four buttons from `RATES` with "Fluid USDC today" at the right (the default 4.5% selected; if `/api/state`'s config ever carries a live rate it is not read here, per the global constraints, so the label stays as copy); "Model" as a radio list `.models` rendered from `PRICES`, each row `name` and `$in / $out`, the selected row `--blue-soft` with a blue radio; the fine line "Any of OpenRouter's 400+ models. Streaming works."; the ink button `a.btn.btn-primary` "Deposit in the Treasury →" to `/treasury`.

Outputs: `#outlabel` "{model}, every month, paid by interest"; the figure `#tokens` (serif 88px) with `<span class="unit">tokens</span>` (serif 32px, ink-3) and a lime chip `#callschip` "≈ 45,700 agent calls"; the fine line `#sums` "$356.25 of credit from $375.00 of monthly interest, after the 5% rail fee. Tokens counted at 3 in for every 1 out; a call is 4K in and 1K out."; four tiles `#tile-credit` (credit a month), `#tile-day` (calls a day), `#tile-call` (per call), `#tile-principal` ("$0" / "drawn from principal"); `.others` with the label "The same $X on other models" and "tokens a month" at the right, one `.other` row per model (name 140px, a track with a bar scaled to the largest, tokens 80px right-aligned, the selected model's bar blue, others blue-soft, the selected name bold); fine print "OpenRouter list prices, September 2026. At a steady rate; real yield follows the vault, and limits only open up to what it has earned."

- [ ] **Step 6: `home.js` for the calculator**

```js
import { PRICES, PRICES_DATE, RATES, RAIL_FEE, PRESETS, compute, tokensText, callsText } from "/calc.js";
```

State `{ deposit: 100_000, rate: 0.045, modelId: "moonshotai/kimi-k2.6" }`; `render()` recomputes and writes every output id; the deposit input and the slider stay in step (typing updates the slider position from `log10(deposit / 1000) × 250`, dragging updates the input); presets set deposit and model then render; the "our demo agent" preset uses `demoDeposit`, which `loadAgent()` sets from `GET /api/agent`'s `book.vaultValue` when it answers 200, else stays 500 (Task 4 reuses that fetch for the glimpse). All numbers through `toLocaleString("en-US")`; `usd(n)` two decimals. Icons: a small `ICONS` map of inline lucide SVG strings for `user`, `bot`, `users`, `sparkles`. No throw escapes `render()`; a failed `/api/agent` read only leaves the default.

- [ ] **Step 7: Styles**

In `styles.css`, a `/* home */` block: `.home .hero`, `.lede`, `.calc`, `.presets`, `.preset` (white, 1px `--ink-3` border, shadow `0 2px 6px #1A18140F`, 13px medium, 999px radius, padding 7px 14px, icon 14px), `.calc-card` (grid `380px 1fr`, the inputs with a right border), `.amountfield.big input` (mono 24px), `.logslider` and its ticks, `.segmented` (four cells, the selected white with a border), `.models` rows (selected `--blue-soft`, a 14px radio ring in blue), `.figure.huge b` (serif 88px, letter-spacing −2px), `.unit`, `.tiles` (four surface-2 tiles), `.others .track` and `.bar` (blue, blue-soft), and the same `@media (max-width: 900px)` stacking used elsewhere.

- [ ] **Step 8: Green, commit**

Run: `npm test && npm run typecheck`. Then open `/` in a browser: at the defaults the figure reads 208M and the chip 45,700; each preset changes the deposit and the model; the slider and the input stay in step.

```bash
git add app/dashboard/calc.js app/dashboard/calc.d.ts app/dashboard/home.js app/dashboard/home.html app/dashboard/styles.css app/test/calc.test.ts
git commit -m "Home: the hero at 88px and the calculator that counts a deposit in tokens"
```

---

### Task 4: Home use cases and How it works

**Files:**
- Modify: `app/dashboard/home.html` (use cases section, how it works section), `app/dashboard/home.js` (glimpses, the step-through), `app/dashboard/styles.css`
- Reference: `design/prototypes/how-it-works.html` (port its markup, CSS and script as they are, with the two additions)

**Interfaces:**
- Consumes: `home.js`'s `loadAgent()` from Task 3 (one `GET /api/agent`).

- [ ] **Step 1: Use cases markup**

Replace `.doors` with `<section class="usecases">` (top border, padding `72px 120px 80px`): tag `Use cases`, h2 "One rail, two kinds of wallet." / "A treasury parking cash, or an agent that can't get a card.", then `.doors` with two cards.

The treasury door (white `.card.door`): tag `For treasuries`, h3 "Put idle USDC to work.", p "Deposit once. Issue keys to your developers and agents. Only the interest pays for their inference.", a `.glimpse` (surface-2, 12px radius) labeled `example` in a small chip: a Used / Open credit bar with the labels only (no figures) and the line "Settled: unused yield goes back to principal.", then `a` "Open the Treasury →" to `/treasury`.

The agent door (`.card.door.dark`: ink background, lime tag stripe, white text): tag `For agents`, h3 "An agent that pays for its own thinking.", p "Watch our agent run a 1,000 USDC book and fund every model and tool call from its own vault's yield.", `.glimpse#agentglimpse` (hidden until filled): "The book · run N" and "floor X USDC", a parked / at work bar from `book.vaultValue` and `book.walletUsdc`, then the latest run's clock date, note (escaped, first 140 characters) and "models $x · tools $y", then `a` "Watch the agent →" in lime to `/agents`. On a 404 or any error the glimpse stays hidden and the card stays.

- [ ] **Step 2: How it works markup and the port**

`<section class="how" id="how">`: tag `How it works`, `.head` with h2 "Principal stays put." / "Only the interest moves." and the 400px aside "Every step is a contract call or a metered request you can check. Nothing leaves your wallet but the yield." Then the `.sim` block copied from the prototype: `.bar` with `button#prev`, `.title#title`, `.dots#dots`, `button#next`; `.caption#caption`; `.panels` with the network `svg#net`, the balances panel (legend, `#chart`, the fine line), the ledger panel `#ledger`; `.wallet` row with `#shares`, the USDC box, "principal spent: 0.00" and `#wnote`. Under the box, `.stepstrip` with five cells rendered from `STEPS`: number and title in mono, one line of the caption (the first sentence), the current one with a 3px `--blue` top border and `--blue-soft` background.

Port the prototype's CSS for `.sim`, `.bar`, `.dots`, `.caption`, `.panels`, `.panel`, `.legend`, `.chart`, `.col`, `.rows`, `.row`, `.wallet`, `.box`, `.fine` into `styles.css` under `/* how it works */`, scoped under `.how`, using the tokens (`var(--line)` and so on) that already exist. Port `NODES`, `PATHS`, `STEPS`, `drawNet`, `drawBars`, `go`, `frame` into `home.js` as they are, with:

- `go()` also updates the strip's current cell.
- `const still = matchMedia("(prefers-reduced-motion: reduce)").matches;` autoplay starts only when `!still`; `frame()` runs only when `!still` (the dots stay at their path start otherwise, drawn once).
- prev and next are the prototype's `<button>`s, so they take focus and Enter already; give them `aria-label`s and make each dot a `<button class="dot">` with `aria-label="step N: title"` so the dots take the keyboard too.
- The 4.2 s autoplay stops for good when anyone clicks prev, next or a dot (the prototype's `manual` flag, kept).

- [ ] **Step 3: Styles**

`.usecases`, `.door.dark` (ink, white text, lime tag stripe, lime link), `.glimpse` (surface-2 on the white card, a dark variant on the ink card), and the `/* how it works */` block. The strip: `.stepstrip { display: grid; grid-template-columns: repeat(5, 1fr); border: 1px solid var(--ink); border-top: 0; }`, cells with mono 12px titles and 12px ink-2 lines, `.on` with the 3px top border in blue and `--blue-soft`.

- [ ] **Step 4: Check and commit**

Run: `npm test && npm run typecheck`. Browser: the step-through autoplays and stops on a click; with reduced motion on (Chromium: DevTools rendering panel, or `prefers-reduced-motion` emulation in Playwright) it does not autoplay and the dots are still; the agent glimpse fills when `/api/agent` answers and hides on a 404.

```bash
git add app/dashboard/home.html app/dashboard/home.js app/dashboard/styles.css
git commit -m "Home: the two use cases with live glimpses and the How it works step-through"
```

---

### Task 5: The Agents page

**Files:**
- Modify: `app/dashboard/agents.html`, `app/dashboard/agents.js`, `app/dashboard/styles.css`
- Modify: `docs/07-walkthrough.md` (the Agents section names the fence card and run cards)

**Interfaces:**
- Consumes: `fence` from Task 2; everything else the page reads today.

- [ ] **Step 1: Head**

Next to `#agenttag`: `span.chip.thinking#thinkingchip` (lime, a pulsing dot, "thinking now"), shown only while the newest run's status is `running`; and `a.mono.faint#agentaddr` with the short address, linking to the explorer's address page when there is an explorer. The headline's second line stays "A wallet of its own, half parked, half at work."

- [ ] **Step 2: The fence card**

Beside the book card (the section's grid becomes `1fr 340px`, equal heights): `.card.fence` with a lock icon and the title "The fence", "set by the runner" at the right in ink-3, the sub "Checked before any signature. The model cannot change these; anything outside is refused and logged.", rows rendered from `data.fence`:

| Row | Value |
|---|---|
| Vault floor | `${floorUsdc} USDC` |
| Split moves per run | `splitMovesPerRun` |
| Source moves per run | `${sourceMovesPerRun}, allowlist only` |
| Assets | `assets.join(" · ")` and `≤ ${maxTrades} trades` |
| A buy | `≤ ${tradeCapBps / 100}% of working USDC` |
| Paid tool calls | `≤ ${maxToolCalls} per run` |
| Model calls | `the key's yield budget` |

and the surface-2 note "Split and source moves are real transactions. Trades are paper for now, marked at the price the agent fetched." When `fence.fromRunner` is false the "set by the runner" text reads "defaults until the runner starts".

- [ ] **Step 3: The parked half, run cards, sources, own agent**

- Parked: `#parkedsource` reads "{source name} · {rate}" when `agent.source` has a rate, else the name and "rate unknown yet".
- Runs: `#runlist` becomes a `div.runcards`; each run a `.runcard` (white, 14px radius; `.running` adds a 1px ink border). Head row: the clock date (mono 13px ink), `run N` (ink-3), the status chip (`done` #DDF1E3 with #1F6B3A; `thinking` lime with a pulse; `out of budget` and `failed` #F6E1DC with `--red`), and "models $x · tools $y" at the right. The note: serif 19px ink when `done`, sans 14px ink-2 otherwise. Actions as `.actrow`s: a 24px round glyph, a bold verb, the detail, the tx link in blue at the right; refused rows get a red glyph on #F6E1DC and the reason as the detail. Last line: a wrench icon and the tool names ("no tool calls" when none). Everything from the server escaped.
- Sources: each row gets a 220px `.track` with a `.bar` proportional to the best known rate (blue for the current, blue-soft for the rest; unknown rates get no bar and "unknown yet"), the rate in mono, and the lime `here` chip on the current row. Foot: "A rate is the share price change between the last two samples, annualized. With one sample it is unknown and the agent stays put."
- Own agent: under the snippet window, `.linkcards` with two cards: `a.card.link.dark` "Get a key for your agent" with a lime key icon and `/treasury#use-a-key`, and `a.card.link` "Read the reference runner" with a GitHub icon and `https://github.com/moyedx3/inferest/tree/main/agent`. The snippet tabs stay Agent config and MCP only (already so).

- [ ] **Step 4: Styles and docs**

`/* agents */` additions: `.chip.thinking` with `@keyframes pulse` on the dot (disabled under `prefers-reduced-motion`), `.fence` rows (label ink-2, value mono), `.runcard`, `.status.done|.thinking|.out|.failed`, `.actrow` and `.glyph.refused`, `.track`/`.bar` in the sources table, `.linkcards` (two columns, `.link.dark`). `docs/07-walkthrough.md`'s Agents section mentions the fence card and the run cards in one sentence each.

- [ ] **Step 5: Check and commit**

Run: `npm test && npm run typecheck`. Browser: with the fork's agent, the fence card shows the runner's values and the run cards render; with a fake response injected in the page (Playwright route) carrying a `running` run, the chip and the ink border show.

```bash
git add app/dashboard/agents.html app/dashboard/agents.js app/dashboard/styles.css docs/07-walkthrough.md
git commit -m "Agents: the fence card, run cards, rated source bars and the two link cards"
```

---

## Self-review notes

- Spec coverage: logo (Task 1), Home hero and calculator (Task 3), use cases and How it works (Task 4), Agents (Tasks 2 and 5), Treasury logo only (Task 1), "Checking it" (each task's browser step plus the controller's final pass at 1440 against the PNGs).
- Type consistency: `compute`'s return shape is the same in `calc.js`, `calc.d.ts` and the test; `fence`'s keys are the same in the endpoint, its test and the Agents page rows.
- Review Focus 1 is pinned by the calc test; 2 by the preset fallback in `home.js` and the browser pass; 3 and 4 by the browser pass with emulation; 5 by the endpoint test's defaults case.
