# Design pass: Home, Agents, and the logo

_What changes on the live pages to match the pen.dev design. The live pages are `app/dashboard/home.html`, `agents.html`, `treasury.html` and `styles.css` on `main` at a3609fa. The design is `design/site.pen`, exported as `design/home.png`, `design/agents.png`, `design/treasury-*.png` and `design/logo.png`, plus the animated reference `design/prototypes/how-it-works.html`._

Tokens, fonts, cards, tags and the top bar are the ones already in `styles.css`; this pass reuses them. Numbers in the mockups are examples; every figure below says where the real one comes from.

## Not to copy from the mockups

- **Home has no network pill.** The Home mockup still shows one; the spec settled that Home loads no chain state.
- **Example figures.** $100,000, run 15, Dec 14 and so on are placeholders.
- **The `B · Treasury` frames** in `site.pen` are an older alternative. Ignore them.

## The logo (all pages)

The mark is a serif lowercase i: the stem is principal, the lime dot is interest. Files in `design/logo/`:

| File | Use |
|---|---|
| `inferest-icon.svg` | The mark inside an ink rounded square. Top bar (22px), footer (16px). |
| `favicon.svg` | Same drawing, for `<link rel="icon" type="image/svg+xml">` on all three pages. |
| `inferest-mark.svg` | The bare mark (ink stem, lime dot), for light backgrounds at 40px and up. Not used on the pages yet. |

Copy the icon and favicon to `app/dashboard/`. `serveStatic` in `app/server.ts` serves any file there, but answers everything that is not `.js` or `.css` as `text/html`, and browsers refuse an SVG image sent that way: add `.svg` → `image/svg+xml` to its content types, with a route test. Replace `.brand::before`, the plain ink square, with the icon: `.brand::before { width: 22px; height: 22px; background: url(/inferest-icon.svg) center / contain no-repeat; }` and `footer .brand::before { width: 16px; height: 16px; }`. Gap to the wordmark stays 10px. On a dark background (none on the site today) the icon inverts to a white square with an ink stem; see `design/logo.png`.

## Home

Section order: **hero, calculator, use cases, how it works, footer.** Home now loads one small module, `home.js`, for the calculator and the step-through. Still no Dynamic bundle and no chain reads.

### Hero

The headline moves to 88px with −2.6px letter spacing. The paragraph sits beside it on the right, 440px wide and bottom-aligned with the headline's second line. The three facts stay below, full width. Padding `88px 120px 56px`.

### Calculator

Header: tag `Calculator`, two-line h2 "What your deposit buys." / "Counted in the models you actually call.", and on the right, 400px wide at 15px: "Rule of thumb: interest covers a monthly budget when the deposit is about 281 times it. The principal is never spent."

Under the header, a row of presets: "Try a preset" (13px, ink-2) and four pill buttons (white fill, 1px ink-3 border, a soft shadow `0 2px 6px #1A18140F`, 13px medium, a 14px lucide icon before the label, padding 7px 14px):

| Preset | Icon | Sets deposit | Sets model |
|---|---|---|---|
| a solo developer | `user` | 56,100 | Claude Sonnet 5 |
| an always-on agent | `bot` | 14,000 | Kimi K2.6 |
| a 20-person team | `users` | 2,810,000 | Claude Sonnet 5 |
| our demo agent | `sparkles` | the agent's parked value from `GET /api/agent` if it answers, else 500 | Kimi K2.6 |

The deposits come from `docs/04-unit-economics.md` (required principal for $200, $50 and $10,000 a month).

Then one card split in two:

- **Inputs, 380px, right border.** Deposit: a mono 24px input with a USDC suffix and a log slider from $1K to $10M ($100K sits in the middle). Vault rate: a segmented control, 4.0 / 4.5 / 5.0 / 6.0%, with "Fluid USDC today" on the right. Default 4.5%; if the public config ever carries the live rate, use it. Model: a radio list of five, each row showing name and "$in / $out" per 1M tokens, selected row in `--blue-soft` with a blue radio. Under the list: "Any of OpenRouter's 400+ models. Streaming works." At the bottom: the ink "Deposit in the Treasury →" button linking to `/treasury`.
- **Outputs.** The label "{model}, every month, paid by interest". The figure is tokens a month in serif 88px ("208M") with "tokens" in serif 32px ink-3 and a lime chip "≈ 45,700 agent calls". A fine line explains the sums. Four tiles: credit a month, calls a day, per call, "$0 drawn from principal". Then "The same $X on other models": one row per model, name (140px), a bar scaled to the largest, tokens a month (80px, right). The selected model's bar is blue and the rest blue-soft. Fine print: "OpenRouter list prices, September 2026. At a steady rate; real yield follows the vault, and limits only open up to what it has earned."

Prices, kept as a dated constant in `home.js` (checked against `https://openrouter.ai/api/v1/models` on 2026-09-27, dollars per 1M tokens):

| Model | id | In | Out |
|---|---|---|---|
| DeepSeek V4 Pro | `deepseek/deepseek-v4-pro` | 0.348 | 0.696 |
| Kimi K2.6 | `moonshotai/kimi-k2.6` | 0.95 | 4.00 |
| Claude Sonnet 5 | `anthropic/claude-sonnet-5` | 2.00 | 10.00 |
| Claude Opus 5.5 | `anthropic/claude-opus-5.5` | 4.00 | 20.00 |
| GPT-5.5 | `openai/gpt-5.5` | 5.00 | 30.00 |

The sums, with the rail fee and ratios stated in the fine line:

```
monthly interest = deposit × rate / 12
credit           = monthly interest × (1 − 0.05)        rail fee
blended per 1M   = (3 × in + out) / 4                   3 in for every 1 out
tokens a month   = credit / blended × 1e6
cost per call    = (4000 × in + 1000 × out) / 1e6        a call is 4K in, 1K out
calls a month    = credit / cost per call;  calls a day = calls a month / 30
```

At $100,000, 4.5% and Kimi K2.6: $375.00 interest, $356.25 credit, 208M tokens, $0.0078 a call, about 45,700 calls a month and 1,520 a day. Round tokens to M with no decimals under 1,000M and calls to the nearest hundred.

### Use cases

A section with a top border, padding `72px 120px 80px`: tag `Use cases`, h2 "One rail, two kinds of wallet." / "A treasury parking cash, or an agent that can't get a card.", then the two doors side by side.

- **For treasuries** (white card): title "Put idle USDC to work.", body "Deposit once. Issue keys to your developers and agents. Only the interest pays for their inference.", a glimpse box (surface-2, 12px radius) with a small Used / Open credit bar and a sample settlement line, then "Open the Treasury →". The glimpse is illustrative. Label it "example", or leave the numbers out and keep the bar shape.
- **For agents** (ink card, lime tag stripe, white text): title "An agent that pays for its own thinking.", body "Watch our agent run a 1,000 USDC book and fund every model and tool call from its own vault's yield.", a glimpse with the parked / at work bar, the floor, and the latest run's date, note and cost, then "Watch the agent →" in lime. Fill it from `GET /api/agent` when it answers. On a 404 hide the glimpse and keep the card.

### How it works

Tag `How it works`, h2 "Principal stays put." / "Only the interest moves.", and on the right at 400px: "Every step is a contract call or a metered request you can check. Nothing leaves your wallet but the yield."

Below it, the step-through from `design/prototypes/how-it-works.html`. Port its markup, CSS and script as they are: the prev / next bar with five dots, the caption, the network / balances / ledger panels, the wallet row, and the five-step strip under the box (the strip is in the pen design, not the prototype; each cell shows its step's title and one line, the current one with a 3px blue top border). The five steps, captions, figures and ledger rows are in the prototype's `STEPS` array. It autoplays every 4.2 s until someone clicks prev, next or a dot. Two additions the prototype lacks: no autoplay under `prefers-reduced-motion` (the dots also stay still), and prev / next are real buttons, so they already take the keyboard.

## Agents

The live page already has every section. The changes:

- **Head.** Next to the tag, a status chip (lime with a pulse dot while a run is `running`, "thinking now"; hidden otherwise) and the agent's short address in mono 12px ink-3 linking to the explorer.
- **The fence card.** A 340px card beside the book card, same height. Title "The fence" with a lock icon and "set by the runner". Sub: "Checked before any signature. The model cannot change these; anything outside is refused and logged." Rows: Vault floor, Split moves per run, Source moves per run, Assets, A buy, Paid tool calls, Model calls. At the bottom, a surface-2 note: "Split and source moves are real transactions. Trades are paper for now, marked at the price the agent fetched." The values are the runner's config (`AGENT_FLOOR_USDC`, `AGENT_TRADE_CAP_BPS`, `AGENT_MAX_TOOL_CALLS`). If `/api/agent` does not carry them yet, add a `fence` object to it rather than hard-coding them.
- **The parked half** shows the current source's rate next to its name when `sources` has one.
- **Run cards.** Each run is its own white card, 14px radius; the running one has an ink border.
  - Head row: the date (mono 13px ink), "run N" (ink-3), the status chip, and on the right "models $x · tools $y".
  - Status chips: `done` is #DDF1E3 with #1F6B3A text; `thinking` is lime with a pulse; `out of budget` and `failed` are #F6E1DC with red text.
  - The note: serif 19px ink for a finished run, sans 14px ink-2 while thinking or out of budget.
  - Actions as rows with a 24px round glyph, a bold verb, detail, and the tx link in blue on the right. Refused rows get a red glyph on #F6E1DC and the reason as detail.
  - Last line: a wrench icon and the tool calls made.
- **Yield sources.** Each row has a 220px track with a bar proportional to the best rate (blue for the current source, blue-soft for the rest), the rate in mono, and a lime "here" chip on the current one. Foot: "A rate is the share price change between the last two samples, annualized. With one sample it is unknown and the agent stays put."
- **Your own agent.** Under the snippet window, two link cards side by side: an ink card "Get a key for your agent", `/treasury#use-a-key` with a lime key icon, and a white card "Read the reference runner", the GitHub `agent/` link with a GitHub icon. The snippet keeps only the Agent config and MCP tabs.

Headline copy: the live second line "A wallet of its own, half parked, half at work." can stay. The mockup's "1,000 USDC. Half parked…" only holds while the book is near 1,000.

## Treasury

Only the logo. Nothing else changes.

## Checking it

`npm test && npm run typecheck`, then a browser pass at 1440 wide against the PNGs: Home's calculator figures at the defaults match the numbers above, each preset changes deposit and model, the step-through plays and stops on a click, the reduced-motion setting stops it, and all three pages show the icon in the top bar and footer and the favicon in the tab.
