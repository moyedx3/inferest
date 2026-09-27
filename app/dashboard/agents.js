// The Agents page: the hosted agent's book, its thinking budget, its runs and the yield sources, all from GET /api/agent.
// It never reads a wallet or the chain. It does not import app.js, which carries the Dynamic session code.
import { snippets } from "/snippets.js";

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
const STATUS = { running: ["thinking", "wait"], done: ["done", ""], out_of_budget: ["out of budget", "err"], failed: ["failed", "err"] };

/** The block explorer's base URL from the server's public config, when it has one. Only used for links. */
let explorer = null;
async function loadExplorer() {
  try {
    const r = await fetch("/api/state");
    if (r.ok) explorer = (await r.json()).config?.explorer ?? null;
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
  const { agent, book } = data;
  $("agenttag").innerHTML = `Agent · run ${esc(agent.runCount)} · period ${esc(agent.period)} <span class="live">live</span>`;
  const known = book.walletUsdc != null || book.vaultValue != null;
  const total = (book.walletUsdc ?? 0) + (book.vaultValue ?? 0);
  $("agenthead").innerHTML = known
    ? `It pays for its own thinking.<span class="second">${esc(usd(total, 0))}. Half parked, half at work. The interest funds the model.</span>`
    : `It pays for its own thinking.<span class="second">Half parked, half at work. The interest funds the model.</span>`;
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

/** One action as a short line with its transaction link, when it has one. */
function actionLine(a) {
  const d = a.detail ?? {};
  const amt = (x) => `${num(x)} USDC`;
  switch (a.kind) {
    case "deposit": return `deposit ${amt(d.amountUsdc ?? 0)} ${txLink(a.tx, "↗")}`;
    case "withdraw": return `withdraw ${amt(d.amountUsdc ?? 0)} ${txLink(a.tx, "↗")}`;
    case "move_source": return `moved to ${esc(d.name ?? short(d.target))} ${txLink(d.redeemTx, "redeem ↗")} ${txLink(d.depositTx ?? a.tx, "deposit ↗")}`;
    case "paper_open": return `paper buy ${esc(d.asset)} ${amt(d.sizeUsdc)} at ${esc(num(d.price))}`;
    case "paper_close": return `paper sell ${esc(d.asset)} ${amt(d.sizeUsdc)} at ${esc(num(d.price))}`;
    case "sweep": return d.surplusUsdc != null
      ? `swept ${amt(d.surplusUsdc)} surplus ${txLink(a.tx, "↗")}`
      : `swept ${amt(d.amountUsdc ?? 0)} from the old vault ${txLink(a.tx, "↗")}`;
    case "refused": return `refused: ${esc(d.what)}, ${esc(d.reason)}`;
    default: return `${esc(a.kind)} ${txLink(a.tx, "↗")}`;
  }
}

function renderRuns(runs) {
  if (!runs.length) { $("runlist").innerHTML = `<li class="none">The agent has not run yet.</li>`; return; }
  $("runlist").innerHTML = [...runs].sort((a, b) => b.id - a.id).map((r) => {
    const [label, cls] = STATUS[r.status] ?? [r.status, ""];
    const calls = r.decision?.toolCalls ?? [];
    const paid = calls.filter((c) => c.name === "run_tool").length;
    const date = new Date(r.clockAt * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `<li>
      <time>${esc(date)}</time>
      <div class="run">
        <div class="runhead"><span class="status ${cls}">${esc(label)}</span><b>Run ${esc(r.id)}</b>${r.note ? `<span>${esc(r.note)}</span>` : ""}</div>
        ${r.actions.length ? `<ul class="acts">${r.actions.map((a) => `<li class="${a.kind === "refused" ? "refused" : ""}">${actionLine(a)}</li>`).join("")}</ul>` : ""}
        <div class="runfoot">${calls.length} tool call${calls.length === 1 ? "" : "s"}, ${paid} paid · models ${esc(spent(r.cost.models))} · tools ${esc(spent(r.cost.tools))}</div>
      </div></li>`;
  }).join("");
}

function renderSources(sources) {
  $("sourcerows").innerHTML = sources.length ? sources.map((s) => `<tr>
      <td>${s.current ? `<b>${esc(s.name)}</b> <span class="badge new">here</span>` : esc(s.name)}</td>
      <td class="amt faint">${esc(short(s.target))}</td>
      <td class="amt">${s.current ? `<b>${esc(rateText(s.rate))}</b>` : esc(rateText(s.rate))}</td></tr>`).join("")
    : `<tr><td colspan="3" class="empty"><b>No sources</b>The server lists no yield sources.</td></tr>`;
}

const ACTION_ICONS = { deposit: "↓", withdraw: "↑", move_source: "⇄", sweep: "→" };
const ACTION_TITLES = { deposit: "Deposited", withdraw: "Withdrew", move_source: "Moved source", sweep: "Swept" };
/** Settlements as on the Treasury page, and the runs' on-chain actions, newest first. */
function renderActivity(data) {
  const settled = data.settlements.map((s) => ({ at: s.at, icon: "✓", title: "Settled", detail: `usage ${spent(Number(s.usageMicro) / 1e6)} to float`, tx: s.tx }));
  const moves = data.runs.flatMap((r) => r.actions.filter((a) => a.tx).map((a) => {
    const d = a.detail ?? {};
    const detail = a.kind === "move_source" ? `to ${d.name ?? short(d.target)}, ${num(d.amountUsdc ?? 0)} USDC`
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
  renderBudget(data.budget);
  renderRuns(data.runs);
  renderSources(data.sources);
  renderActivity(data);
  showAgent(true);
}

async function load() {
  try {
    const r = await fetch("/api/agent");
    if (r.status === 404) {
      showAgent(false);
      $("runlist").innerHTML = `<li class="none">no agent yet</li>`;
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

renderOwn();
loadExplorer().finally(load);
setInterval(load, 10_000);
