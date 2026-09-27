// The Agents page: the hosted agent's book, its thinking budget, its runs and the yield sources, all from GET /api/agent.
// It never reads a wallet or the chain. It does not import app.js, which carries the Dynamic session code.
import { snippets } from "/snippets.js";
import { runsText } from "./runs-text.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const usd = (n, digits = 2) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
/** Spend figures: four decimals below a cent, so a single model call is visible. */
const spent = (n) => usd(n, n > 0 && n < 0.01 ? 4 : 2);
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
const num = (n, digits = 2) => Number(n).toLocaleString("en-US", { maximumFractionDigits: digits });
const rateText = (r) => (r == null ? "rate unknown yet" : `${(r * 100).toFixed(2)}% a year`);
const TAB_NAMES = { "MCP tools (same key)": "MCP" };
/** A run's status as its chip: the label and the class that colors it. */
const STATUS = { running: ["thinking", "thinking"], done: ["done", "done"], out_of_budget: ["out of budget", "out"], failed: ["failed", "failed"] };

// Icons are Lucide (lucide.dev, ISC license), path data copied from lucide-static; github from lucide-static 0.460.0, the last with brand icons.
const svg = (body) => `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICONS = {
  lock: svg('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  wrench: svg('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"/>'),
  key: svg('<path d="m2 21 9.6-9.6"/><path d="m7.5 15.5 2.3 2.3a1 1 0 0 1 0 1.4l-2.1 2.1a1 1 0 0 1-1.4 0L4 19"/><circle cx="15.5" cy="7.5" r="5.5"/>'),
  github: svg('<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>'),
  // arrow-up-right: the link cards' corner arrow
  arrowUpRight: svg('<path d="M7 7h10v10"/><path d="M7 17 17 7"/>'),
  // arrow-down: a deposit into the vault
  arrowDown: svg('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'),
  // arrow-up: a withdrawal to the working half
  arrowUp: svg('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>'),
  // arrow-left-right: a move between yield sources
  arrowLeftRight: svg('<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>'),
  // notebook-pen: a paper trade
  notebookPen: svg('<path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/>'),
  // broom: a sweep of surplus
  broom: svg('<path d="M13.5 10.5 22 2"/><path d="M14.734 13.841a2 2 0 00-.314-2.42L12.58 9.58a2 2 0 00-2.421-.314l-7.657 4.461A1 1 0 002.3 15.3l6.403 6.403a1 1 0 001.571-.204z"/><path d="m5 18 2-2"/><path d="m7.699 10.7 5.602 5.601"/>'),
  // ban: something the fence refused
  ban: svg('<circle cx="12" cy="12" r="10"/><path d="M4.929 4.929 19.07 19.071"/>'),
};

/** The block explorer's base URL from the server's public config, when it has one, used only for links; the same read fills the network chip. */
let explorer = null;
async function loadExplorer() {
  try {
    const r = await fetch("/api/state");
    if (!r.ok) return;
    const cfg = (await r.json()).config ?? {};
    explorer = cfg.explorer ?? null;
    $("network").textContent = `${cfg.chainName ?? `chain ${cfg.chainId}`}${cfg.demoFaucet ? " · demo fork" : ""}`;
  } catch { /* links fall back to plain hashes */ }
}
const txLink = (tx, label = `${short(tx)} ↗`) => (!tx ? "" : explorer
  ? `<a href="${esc(explorer)}/tx/${esc(tx)}" target="_blank" rel="noopener">${esc(label)}</a>`
  : `<span class="mono faint">${esc(label)}</span>`);
const addressLink = (el, a) => {
  el.textContent = a ? `${short(a)} ↗` : "";
  if (a && explorer) el.href = `${explorer}/address/${a}`; else el.removeAttribute("href");
};

function renderHead(data) {
  const { agent } = data;
  $("agenttag").innerHTML = `Agent · run ${esc(agent.runCount)} · period ${esc(agent.period)} <span class="live">live</span>`;
  $("thinkingchip").hidden = data.runs[0]?.status !== "running";
  addressLink($("agentaddr"), agent.address);
}

/** The runner's limits, as it reported them, or the defaults until it has. */
function renderFence(fence) {
  $("fence").hidden = !fence;
  if (!fence) return;
  $("fenceby").textContent = fence.fromRunner ? "set by the runner" : "defaults until the runner starts";
  const rows = [
    ["Vault floor", `${num(fence.floorUsdc)} USDC`],
    ["Split moves per run", `${fence.splitMovesPerRun}`],
    ["Source moves per run", `${fence.sourceMovesPerRun}, allowlist only`],
    ["Assets", `${fence.assets.join(" · ")}, ≤ ${fence.maxTrades} trades`],
    ["A buy", `≤ ${num(fence.tradeCapBps / 100)}% of working USDC`],
    ["Paid tool calls", `≤ ${fence.maxToolCalls} per run`],
    ["Model calls", "the key's yield budget"],
  ];
  $("fencerows").innerHTML = rows.map(([k, v]) => `<div><span>${esc(k)}</span><b class="mono">${esc(v)}</b></div>`).join("");
}

function renderBook(data) {
  const { agent, book } = data;
  const parked = book.vaultValue ?? 0, working = book.walletUsdc ?? 0, total = parked + working;
  $("booktotal").textContent = usd(total, 0);
  addressLink($("agentlink"), agent.address);
  const pct = (x) => (total > 0 ? Math.max(0, Math.min(100, (x / total) * 100)) : 50);
  $("segparked").style.flex = `0 0 ${pct(parked)}%`;
  $("segworking").style.flex = "1";
  $("parkedamt").textContent = usd(parked, 0);
  $("workingamt").textContent = usd(working, 0);
  $("floor").style.left = `${total > 0 ? Math.min(100, (book.floor / total) * 100) : 0}%`;
  $("floor").title = `floor ${usd(book.floor, 0)}`;
  $("parkedvalue").textContent = book.vaultValue == null ? "not read yet" : usd(book.vaultValue);
  $("parkedsource").textContent = agent.source ? `${agent.source.name} · ${rateText(agent.source.rate)}` : "no source yet";
  $("workingvalue").textContent = book.walletUsdc == null ? "not read yet" : `${num(book.walletUsdc)} USDC`;
  const n = book.positions.length;
  $("workingnote").textContent = n ? `${n} paper position${n === 1 ? "" : "s"} open` : "no paper positions open";
  $("floorvalue").textContent = usd(book.floor, 0);
  $("positionrows").innerHTML = n ? book.positions.map((p) => {
    const change = p.entryPrice > 0 ? (p.markPrice / p.entryPrice - 1) * p.sizeUsdc : 0;
    const cls = change > 0 ? "up" : change < 0 ? "down" : "";
    return `<tr><td class="amt">${esc(p.asset)}</td><td>${esc(p.side)}</td><td class="amt">${esc(num(p.sizeUsdc))} USDC</td>
      <td class="amt">${esc(num(p.entryPrice))}</td><td class="amt">${esc(num(p.markPrice))}</td>
      <td class="amt ${cls}">${change > 0 ? "+" : change < 0 ? "−" : ""}${esc(usd(Math.abs(change)))}</td></tr>`;
  }).join("") : `<tr><td colspan="6" class="empty"><b>No open positions</b>The working half sits in the wallet as USDC.</td></tr>`;
}

/** The same figures as the Treasury page's yield card, over the agent's vault. */
function renderBudget(v) {
  const tag = $("budgettag");
  tag.textContent = `Thinking budget · period ${v.period}`;
  if (v.frozen) tag.insertAdjacentHTML("beforeend", ` <span class="flag">frozen: loss pending</span>`);
  if (v.settling) tag.insertAdjacentHTML("beforeend", ` <span class="flag">settling</span>`);
  const keys = v.keys;
  const used = sum(keys, (k) => k.spent);
  const open = Math.max(0, v.credit - used);
  $("yield").textContent = usd(v.yieldUsd);
  $("vaultname").textContent = `${v.label} vault`;
  addressLink($("vaultlink"), v.vault);
  $("usedamt").textContent = spent(used);
  $("openamt").textContent = usd(open);
  const share = v.credit > 0 ? used / v.credit : 0;
  $("barused").hidden = used <= 0;
  $("barused").style.flex = `0 0 ${Math.min(100, Math.max(12, share * 100))}%`;
  $("models").textContent = spent(sum(keys, (k) => k.modelSpent));
  const live = keys.filter((k) => !k.revoked).length;
  $("modelsnote").textContent = `through the proxy, ${live} key${live === 1 ? "" : "s"}`;
  $("tools").textContent = spent(sum(keys, (k) => k.toolSpent));
  $("backstop").textContent = v.hasOpenRouterKey ? `${spent(v.orUsage)} / ${usd(v.orLimit)}` : "none";
  $("backstopnote").textContent = v.hasOpenRouterKey ? "OpenRouter key, synced" : "no provider key yet";
  $("pvperiod").textContent = `period ${v.period} → ${v.period + 1}`;
  $("pvusage").textContent = spent(v.preview.usage);
  $("pvfee").textContent = usd(v.preview.fee);
  $("pvreturned").textContent = usd(v.preview.returned);
}

/** One action as a row: its glyph, a verb, the detail and the transaction links, each already escaped. */
function actionRow(a) {
  const d = a.detail ?? {};
  const amt = (x) => `${num(x)} USDC`;
  const row = (icon, verb, detail, links = "", bad = false) => `<div class="actrow${bad ? " bad" : ""}">
      <span class="glyph${bad ? " refused" : ""}">${ICONS[icon]}</span><b>${verb}</b><span class="detail">${detail}</span><span class="links">${links}</span></div>`;
  switch (a.kind) {
    case "deposit": return row("arrowDown", "deposit", esc(amt(d.amountUsdc ?? 0)), txLink(a.tx));
    case "withdraw": return row("arrowUp", "withdraw", esc(amt(d.amountUsdc ?? 0)), txLink(a.tx));
    case "move_source": if (d.failed) return row("arrowLeftRight", `moved out of ${esc(short(d.from))}`, "deposit failed", txLink(d.redeemTx, "redeem ↗"), true);
      return row("arrowLeftRight", `moved to ${esc(d.name ?? short(d.target))}`, d.amountUsdc != null ? esc(amt(d.amountUsdc)) : "",
        `${txLink(d.redeemTx, "redeem ↗")} ${txLink(d.depositTx ?? a.tx, "deposit ↗")}`);
    case "paper_open": return row("notebookPen", `paper buy ${esc(d.asset)}`, `${esc(amt(d.sizeUsdc))} at ${esc(num(d.price))}`);
    case "paper_close": return row("notebookPen", `paper sell ${esc(d.asset)}`, `${esc(amt(d.sizeUsdc))} at ${esc(num(d.price))}`);
    case "sweep": return d.surplusUsdc != null
      ? row("broom", "swept", `${esc(amt(d.surplusUsdc))} surplus`, txLink(a.tx))
      : row("broom", "swept", `${esc(amt(d.amountUsdc ?? 0))} from the old vault`, txLink(a.tx));
    case "refused": return row("ban", `refused: ${esc(d.what)}`, esc(d.reason), "", true);
    default: return row("arrowLeftRight", esc(a.kind), "", txLink(a.tx));
  }
}

/** The run's MCP calls by name, with a count when a name repeats. */
function toolText(calls) {
  if (!calls.length) return "no tool calls";
  const counts = new Map();
  for (const c of calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  const paid = calls.filter((c) => c.name === "run_tool").length;
  const names = [...counts].map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join(", ");
  return `${calls.length} tool call${calls.length === 1 ? "" : "s"}, ${paid} paid · ${names}`;
}

const RUNS_SHOWN = 3;
let showAll = false;
let lastRuns = [];

function renderRuns(runs) {
  lastRuns = runs;
  if (!runs.length) { $("runlist").innerHTML = `<p class="none">The agent has not run yet.</p>`; return; }
  const sorted = [...runs].sort((a, b) => b.id - a.id);
  const shown = showAll ? sorted : sorted.slice(0, RUNS_SHOWN);
  const more = sorted.length > RUNS_SHOWN
    ? `<button type="button" class="preset more" data-more>${esc(showAll ? "Show fewer" : `Show all ${sorted.length} runs`)}</button>` : "";
  $("runlist").innerHTML = shown.map((r) => {
    const [label, cls] = STATUS[r.status] ?? [r.status, ""];
    const calls = r.decision?.toolCalls ?? [];
    const date = new Date(r.clockAt * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `<article class="runcard${r.status === "running" ? " running" : ""}">
      <div class="runhead"><time>${esc(date)}</time><span class="faint">run ${esc(r.id)}</span><span class="status ${esc(cls)}">${esc(label)}</span>
        <span class="cost">models ${esc(spent(r.cost.models))} · tools ${esc(spent(r.cost.tools))}</span></div>
      ${r.note ? `<p class="note${r.status === "done" ? " done" : ""}">${esc(r.note)}</p>` : ""}
      ${r.actions.length ? `<div class="actrows">${r.actions.map(actionRow).join("")}</div>` : ""}
      <div class="runfoot">${ICONS.wrench}<span>${esc(toolText(calls))}</span></div>
    </article>`;
  }).join("") + more;
}

// registered once: the list's HTML is replaced on every render, the listener on #runlist stays
$("runlist").addEventListener("click", (e) => {
  if (!e.target.closest("[data-more]")) return;
  showAll = !showAll;
  renderRuns(lastRuns);
  $("runlist").querySelector("[data-more]")?.focus();
});

function renderSources(sources) {
  const best = Math.max(0, ...sources.map((s) => s.rate ?? 0));
  const addr = (a) => (explorer ? `<a href="${esc(explorer)}/address/${esc(a)}" target="_blank" rel="noopener">${esc(short(a))} ↗</a>` : esc(short(a)));
  $("sourcerows").innerHTML = sources.length ? sources.map((s) => {
    const bar = s.rate != null && best > 0 ? `<i class="bar" style="width:${Math.max(2, Math.min(100, (s.rate / best) * 100)).toFixed(1)}%"></i>` : "";
    return `<tr class="${s.current ? "current" : ""}">
      <td><b>${esc(s.name)}</b><small class="mono faint">${addr(s.target)}</small></td>
      <td><div class="rate"><span class="track">${bar}</span><span class="mono">${s.rate == null ? "unknown yet" : esc(`${(s.rate * 100).toFixed(2)}%`)}</span></div></td>
      <td class="here">${s.current ? `<span class="badge new">here</span>` : ""}</td></tr>`;
  }).join("")
    : `<tr><td colspan="3" class="empty"><b>No sources</b>The server lists no yield sources.</td></tr>`;
}

const ACTION_ICONS = { deposit: "↓", withdraw: "↑", move_source: "⇄", sweep: "→" };
const ACTION_TITLES = { deposit: "Deposited", withdraw: "Withdrew", move_source: "Moved source", sweep: "Swept" };
/** Settlements as on the Treasury page, and the runs' on-chain actions, newest first. */
function renderActivity(data) {
  const settled = data.settlements.map((s) => ({ at: s.at, icon: "✓", title: "Settled", detail: `usage ${spent(Number(s.usageMicro) / 1e6)} to float`, tx: s.tx }));
  const moves = data.runs.flatMap((r) => r.actions.filter((a) => a.tx).map((a) => {
    const d = a.detail ?? {};
    const detail = a.kind === "move_source" && d.failed ? `out of ${short(d.from)}, ${num(d.amountUsdc ?? 0)} USDC, deposit failed`
      : a.kind === "move_source" ? `to ${d.name ?? short(d.target)}, ${num(d.amountUsdc ?? 0)} USDC`
      : a.kind === "sweep" && d.surplusUsdc != null ? `${num(d.surplusUsdc)} USDC surplus`
      : `${num(d.amountUsdc ?? 0)} USDC, run ${r.id}`;
    return { at: r.finishedAt ?? r.startedAt, icon: ACTION_ICONS[a.kind] ?? "•", title: ACTION_TITLES[a.kind] ?? a.kind, detail, tx: a.tx };
  }));
  const rows = [...settled, ...moves].sort((a, b) => b.at - a.at);
  const when = (at) => {
    const d = new Date(at);
    return d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
      : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };
  $("activity").innerHTML = rows.length ? rows.map((r) => `<li>
      <time>${esc(when(r.at))}</time><span class="glyph">${esc(r.icon)}</span>
      <div class="what"><b>${esc(r.title)}</b><span>${esc(r.detail)}</span></div>${txLink(r.tx)}</li>`).join("")
    : `<li class="none">Nothing on-chain yet.</li>`;
}

/** The Agent config and MCP setups with the placeholder key. */
let ownIndex = 0;
function renderOwn() {
  const list = snippets(location.origin, "sk-inf-YOUR-KEY").filter((s) => s.name.startsWith("Agent config") || s.name.startsWith("MCP"));
  $("tabs").innerHTML = "";
  for (const [i, s] of list.entries()) {
    const b = document.createElement("button");
    b.textContent = TAB_NAMES[s.name] ?? s.name.replace(/ \(.*\)$/, "");
    b.title = s.name;
    b.className = i === ownIndex ? "on" : "";
    b.onclick = () => { ownIndex = i; renderOwn(); };
    $("tabs").appendChild(b);
  }
  $("snippet").textContent = list[ownIndex]?.text ?? "";
}

function showAgent(on) {
  for (const el of document.querySelectorAll(".agent-only")) el.hidden = !on;
}

function render(data) {
  renderHead(data);
  renderBook(data);
  renderFence(data.fence);
  renderBudget(data.budget);
  renderRuns(data.runs);
  const how = runsText(data.runs, data.agent.schedule);
  $("runshow").textContent = how;
  $("runshow").hidden = !how;
  renderSources(data.sources);
  renderActivity(data);
  showAgent(true);
}

async function load() {
  try {
    const r = await fetch("/api/agent");
    if (r.status === 404) {
      showAgent(false);
      $("runlist").innerHTML = `<p class="none">no agent yet</p>`;
      $("runshow").hidden = true;
      $("thinkingchip").hidden = true;
      $("pagefine").textContent = "";
      return;
    }
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? r.status);
    render(j);
    $("pagefine").textContent = "";
  } catch (e) {
    $("pagefine").textContent = `Could not load the agent: ${e?.message ?? e}. Trying again shortly.`;
  }
}

for (const el of document.querySelectorAll("[data-icon]")) el.innerHTML = ICONS[el.dataset.icon] ?? "";
$("copysnippet").onclick = () => navigator.clipboard?.writeText($("snippet").textContent).catch(() => {});
try {
  renderOwn();
} catch (e) {
  $("pagefine").textContent = `Could not show the setups: ${e?.message ?? e}.`;
}
loadExplorer().finally(load);
setInterval(load, 10_000);
