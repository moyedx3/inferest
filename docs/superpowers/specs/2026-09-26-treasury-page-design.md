# Treasury page design

_The dashboard and the developer setup page become one page, the Treasury page, restyled after sfcompute.com, natural.com and ramp.com. The mockups are [`design/treasury-signed-out.png`](../../../design/treasury-signed-out.png), [`design/treasury-no-vault.png`](../../../design/treasury-no-vault.png) and [`design/treasury-signed-in.png`](../../../design/treasury-signed-in.png), exported from the pen.dev file in `design/` (version A; a quieter sfcompute and Natural version B was drawn and not chosen)._

## Goal

The demo works but looks like a debug console. A judge or a treasury lead should read three things at a glance: the principal does not move, the yield is what pays, and each key's spend comes out of that yield. No behaviour changes: every button in `docs/07-walkthrough.md` still exists and does the same thing.

## One page, three states

`/` serves the Treasury page. There is no section menu; the top bar holds the wordmark on the left and, on the right, the network pill plus either the signed-in account (email, short wallet, Sign out) or nothing.

| State | When | Shows |
|---|---|---|
| Signed out | no session and no operator token | Hero "Your interest, / now inference." with three facts (principal never moves, limits follow yield, unused yield returns less 10%) and the sign-in card (email → code, or Connect treasury wallet). Below it, Use a key with `sk-inf-YOUR-KEY`. Footer. |
| No vault yet | signed in, no vault for this login | Treasury section with a four-step checklist (demo funds, create vault and deposit, yield accrues, settle) and the deposit card as "Create vault and deposit". Keys section with its empty state and the create form disabled. Activity. Footer. |
| Signed in | signed in, a vault | Treasury, Keys, Use a key, Activity, footer, as below. |

`/setup` answers `302` to `/#use-a-key`, and `setup.html` is deleted. A developer with only a key lands on the signed-out page, scrolled to the snippets.

**Login off** (no Dynamic environment): the sign-in card shows the existing "Login is off on this server" text and the operator token input in place of email and wallet. **Login on:** the operator token sits behind the "Operator" pill in the footer. With a token typed, the page shows the signed-in state for every vault; with more than one vault, the section tag becomes a vault picker ("Treasury · period 6 ▾") and all sections follow the picked vault.

## Sections (signed in)

**Treasury.** Tag "Treasury · period N" plus `frozen: loss pending` or `settling` chips when set. Two-line serif headline: "Your $X stays put." / "Only the interest it earns pays for inference." A yield card and a side column:

- Yield card: "Yield earned this period", `yieldUsd` large, with a lime `live` chip. Vault name and short address (explorer link) at the right. A segmented bar: Used (sum of key `spent`, blue) and Open credit (`yieldUsd × (1 − railFee) − used`, zero when frozen, soft blue), with Used's width proportional and a minimum width so its label fits. Under it a hatched Principal bar labelled "Principal · never spent" with the amount. A breakdown row: Models, Tools, Provider backstop (`orUsage / orLimit`, or "no provider key yet"), Shares.
- Deposit card "Add to principal": amount input in USDC, black "Deposit" button, wallet USDC balance, "Withdraw all" in red, and the lime "Get demo funds" chip on faucet chains.
- Settle card "If you settle now", period N → N+1: Usage to the provider float, Inferest fee (10% of unused yield), Stays in your vault (lime). Outline "Settle now" button; Report yield and Sync limits as quiet links under it.

**Keys.** Tag, two-line headline "Every key spends only yield." / "Split by weight. Unused yield comes back, less 10%.", and the create form inline at the right (name, weight, black "Create key"). A white table: Key (mono name, created date, `new` chip on the key just created, struck through with a `revoked` chip when revoked), Weight (×n), Budget, Spend this period (total, "models · tools", a bar with models in blue and tools in olive against the budget), Left, then Rotate and Revoke pills (Revoke in red, still behind `confirm`).

**Use a key.** Left: the headline "Change the base URL." / "Keep your client, your models, your agent." and the four `NOTES` as rows with icons. Right: after a create or rotate, the lime "New key: name" banner with the secret, Copy key and a close ×. Under it a code window with the six snippet tabs and a Copy action. The window shows the created key when there is one, the placeholder otherwise. Closing the banner clears the secret from the page, as today.

**Activity.** Replaces the `<pre id="log">`. Rows: time, icon, bold event, detail, and the transaction as a short hash linking to `explorer/tx/…` when the chain has an explorer. Sources: `state.settlements` (persisted on the server) plus this session's events: funded, vault created, deposited, withdrawn, yield reported, limits synced, key created, rotated, revoked, and errors (red icon, the message as the detail). Session events are lost on reload. That is accepted: history beyond settlements is not in scope.

**Footer.** Wordmark and tagline; Factory, Splitter and USDC short addresses; the Operator pill.

## Data the page does not have today

| Figure | Source |
|---|---|
| Principal, Shares | The browser, signed in with a wallet: `balanceOf(wallet)` on the vault and `convertToAssets` of it. The Splitter holds the yield shares, so this is principal by the contract's definition. Hidden in operator mode. |
| Wallet USDC balance | The browser: `balanceOf(wallet)` on USDC. |
| Settle preview | `ourFee` and `railFee` added to `publicConfig`. usage = Σ modelSpent / (1 − railFee) + Σ toolSpent; leftover = max(0, yield − usage); fee = ourFee × leftover; stays = leftover − fee. Labelled as a preview; the settle response is what counts. |

No other server or contract changes.

## Visual system

Warm off-white `#F4F2EE` page, white cards with `#E4E0D8` hairlines and 16px corners, ink `#151513`, greys `#5F5B54` / `#A19C93`, lime `#E3F25A` for live and yours, blue `#4E6AF0` and `#D9E0FC` for spend and credit, red `#C4432F` for destructive. Newsreader for headlines, Geist for text, Geist Mono for amounts, addresses and code, from Google Fonts. Black pill buttons for the one primary action per section, outlined pills for the rest. Content width 1200px; below 900px the columns stack and the key table turns into cards.

## Code shape

- `app/dashboard/index.html`: new markup, one section per block above, with `id`s kept where `app.js` uses them. `data-state="out|novault|vault"` on `<body>` drives which blocks show.
- `app/dashboard/styles.css`: all CSS. `serveStatic` sends `text/css` for `.css`.
- `app/dashboard/app.js`: render functions per section (treasury, keys, use a key, activity) driven by one `/api/state` read plus the wallet reads; `log()` becomes `activity(event)`. No framework, no build step beyond the existing Dynamic bundle.
- `app/dashboard/figures.js`: settle preview and open credit, pure.
- `app/dashboard/snippets.js`: unchanged.
- `app/server.ts`: `/setup` redirect, CSS content type. `app/cli.ts`: `ourFee`, `railFee` in `publicConfig`.
- `docs/07-walkthrough.md` and the README: new labels.

## Testing

- `server.test.ts`: `/setup` redirects to `/#use-a-key`; `.css` is served as `text/css`; state carries `ourFee` and `railFee`. The old setup-page test is replaced.
- The settle preview and open-credit arithmetic live in `app/dashboard/figures.js`, a pure module with no imports (app.js pulls viem from esm.sh, so Node cannot import it), unit tested against the deck's numbers ($2,225 yield, $500 used → $172.50 fee, $1,552.50 stays) and a frozen vault (no open credit).
- `npm test` green. Then the full `docs/07-walkthrough.md` path in a browser on an anvil fork, checking each state and a screenshot of each against the mockups.

## Out of scope

A marketing landing page, a server-side activity log, charts over time, a dark theme.
