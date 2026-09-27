// The Home page: the calculator, the two use cases and the How it works step-through. It reads only GET /api/agent, once, for the demo agent preset's deposit and the agent glimpse, and loads no wallet code.
import { PRICES, PRICES_DATE, RATES, RAIL_FEE, PRESETS, compute, tokensText, callsText, callsDayText } from "/calc.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const usd = (n, digits = 2) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const price = (n) => usd(n, 2);
const pct = (r) => `${(r * 100).toFixed(1)}%`;

// Icons are Lucide (lucide.dev, ISC license), path data copied from lucide-static.
const svg = (body) => `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICONS = {
  user: svg('<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  bot: svg('<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>'),
  users: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>'),
  sparkles: svg('<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/><path d="M20 2v4"/><path d="M22 4h-4"/><circle cx="4" cy="20" r="2"/>'),
};

const MIN = 1_000, MAX = 10_000_000;
const state = { deposit: 100_000, rate: 0.045, modelId: "moonshotai/kimi-k2.6" };
/** The demo agent's parked value from GET /api/agent, else 500. */
let demoDeposit = 500;

/** Slider position 0..1000 to a deposit, $1K to $10M on a log scale, and back. */
const fromSlider = (v) => Math.round(1000 * 10 ** (v / 250));
const toSlider = (d) => Math.min(1000, Math.max(0, Math.round(Math.log10(Math.max(d, 1) / 1000) * 250)));
const parseDeposit = (s) => Math.max(0, Number(String(s).replace(/[^0-9.]/g, "")) || 0);
const depositText = (d) => Math.round(d).toLocaleString("en-US");

function renderControls() {
  $("presets").innerHTML = PRESETS.map((p, i) => `<button type="button" class="preset" data-i="${i}">${ICONS[p.icon] ?? ""}${esc(p.label)}</button>`).join("");
  $("rates").innerHTML = RATES.map((r) => `<button type="button" data-rate="${r}" aria-pressed="false">${pct(r)}</button>`).join("");
  $("models").innerHTML = PRICES.map((m) => `<label class="model" data-id="${esc(m.id)}"><input type="radio" name="model" value="${esc(m.id)}" /><span class="radio" aria-hidden="true"></span><span class="name">${esc(m.name)}</span><span class="mono price">${price(m.in)} / ${price(m.out)}</span></label>`).join("");
  $("pricesnote").textContent = `OpenRouter list prices, ${PRICES_DATE}. At a steady rate; real yield follows the vault, and limits only open up to what it has earned.`;
}

function render() {
  try {
    const r = compute(state);
    for (const b of $("rates").children) b.setAttribute("aria-pressed", String(Number(b.dataset.rate) === state.rate));
    for (const row of $("models").children) {
      const on = row.dataset.id === r.model.id;
      row.classList.toggle("on", on);
      row.querySelector("input").checked = on;
    }
    $("outlabel").textContent = `${r.model.name}, every month, paid by interest`;
    $("tokens").textContent = tokensText(r.tokens);
    $("callschip").textContent = `≈ ${callsText(r.callsMonth)} agent calls`;
    $("sums").textContent = `${usd(r.credit)} of credit from ${usd(r.interest)} of monthly interest, after the ${Math.round(RAIL_FEE * 100)}% rail fee. Tokens counted at 3 in for every 1 out; a call is 4K in and 1K out.`;
    $("tile-credit").querySelector("b").textContent = usd(r.credit);
    $("tile-day").querySelector("b").textContent = callsDayText(r.callsDay);
    $("tile-call").querySelector("b").textContent = usd(r.perCall, 4);
    $("otherslabel").textContent = `The same ${usd(r.credit)} on other models`;
    const top = Math.max(...r.others.map((o) => o.tokens)) || 1;
    $("others").innerHTML = r.others
      .map((o) => `<div class="other${o.id === r.model.id ? " on" : ""}"><span class="name">${esc(o.name)}</span><span class="track"><i class="bar" style="width:${((o.tokens / top) * 100).toFixed(1)}%"></i></span><span class="mono num">${tokensText(o.tokens)}</span></div>`)
      .join("");
  } catch (e) {
    console.error(e);
  }
}

/** Sets the deposit from anywhere but the input the person is typing in. */
function setDeposit(d, { input = true, slider = true } = {}) {
  state.deposit = d;
  if (input) $("deposit").value = depositText(d);
  if (slider) $("depositlog").value = String(toSlider(d));
  render();
}

function wire() {
  $("deposit").addEventListener("input", (e) => setDeposit(parseDeposit(e.target.value), { input: false }));
  $("deposit").addEventListener("blur", () => { $("deposit").value = depositText(state.deposit); });
  $("depositlog").addEventListener("input", (e) => setDeposit(fromSlider(Number(e.target.value)), { slider: false }));
  $("rates").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-rate]");
    if (b) { state.rate = Number(b.dataset.rate); render(); }
  });
  $("models").addEventListener("change", (e) => { state.modelId = e.target.value; render(); });
  $("presets").addEventListener("click", (e) => {
    const b = e.target.closest("button.preset");
    if (!b) return;
    const p = PRESETS[Number(b.dataset.i)];
    state.modelId = p.modelId;
    setDeposit(p.deposit ?? demoDeposit);
  });
}

/** GET /api/agent: the demo agent's parked value for its preset, and the whole answer for the glimpse. Any failure leaves 500 and returns null. */
async function loadAgent() {
  try {
    const res = await fetch("/api/agent");
    if (res.status !== 200) return null;
    const body = await res.json();
    const v = Number(body?.book?.vaultValue);
    if (Number.isFinite(v) && v > 0) demoDeposit = Math.round(v);
    return body;
  } catch {
    return null;
  }
}

/** The agent door's glimpse: the book's parked / at work split, the floor and the latest run. Stays hidden without an agent. */
function fillAgentGlimpse(body) {
  const el = $("agentglimpse");
  try {
    const book = body?.book;
    const parked = Number(book?.vaultValue), working = Number(book?.walletUsdc), floor = Number(book?.floor);
    if (!book || !Number.isFinite(parked) || !Number.isFinite(working) || parked + working <= 0) return;
    const share = (parked / (parked + working)) * 100;
    const run = Array.isArray(body.runs) ? body.runs[0] : null;
    const cost = (n) => usd(Number(n) || 0, n > 0 && n < 0.01 ? 4 : 2);
    const note = run?.note ? String(run.note) : "";
    const cut = note.length > 140 ? `${note.slice(0, 140).trimEnd()}…` : note;
    const runLine = run
      ? `<div class="glimpseline"><span class="mono when">${esc(new Date(run.clockAt * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" }))}</span><span class="note">${esc(cut || run.status)}</span><span class="mono cost">models ${esc(cost(run.cost?.models))} · tools ${esc(cost(run.cost?.tools))}</span></div>`
      : "";
    el.innerHTML = `<div class="glimpsehead"><span>The book · run ${esc(Number(body.agent?.runCount) || 0)}</span>${Number.isFinite(floor) ? `<span class="mono">floor ${esc(floor.toLocaleString("en-US"))} USDC</span>` : ""}</div>
      <div class="glimpsebar"><div class="seg parked" style="flex:0 0 ${share.toFixed(1)}%"><small>Parked</small><span>${esc(usd(parked))}</span></div><div class="seg working"><small>At work</small><span>${esc(usd(working))}</span></div></div>
      ${runLine}`;
    el.hidden = false;
  } catch (e) {
    console.error(e);
    el.hidden = true;
  }
}

// How it works: the step-through from design/prototypes/how-it-works.html, ported as it is.
const NODES = { wallet:[0,"you"], vault:[119,"ERC-4626"], splitter:[238,"yield shares"], keys:[357,"3 keys"], models:[476,"/v1 · mcp"] };
const W = 72, H = 34, Y = 96, cx = (n) => NODES[n][0] + W / 2;
const PATHS = {
  deposit: `M${NODES.wallet[0] + W} ${Y + 17} H${NODES.vault[0]}`,
  report: `M${NODES.vault[0] + W} ${Y + 17} H${NODES.splitter[0]}`,
  sync: `M307 34 L${cx("keys")} ${Y}`,
  sync2: `M287 34 L${cx("splitter")} ${Y}`,
  calls: `M${NODES.keys[0] + W} ${Y + 17} H${NODES.models[0]}`,
  usage: `M${cx("splitter")} ${Y + H + 22} V214 H${cx("models")} V${Y + H + 22}`,
  back: `M${cx("splitter")} ${Y + H + 22} V196 H${cx("vault")} V${Y + H + 22}`,
};
const STEPS = [
  { title: "Deposit", caption: "Your wallet deposits 100,000 USDC into its own Inferest vault and gets 100,000 principal shares back. The solid dot is money moving on-chain.",
    active: ["wallet", "vault"], flows: [["deposit", false]], bars: { principal: 100000, yield: 0, open: 0, spent: 0 },
    ledger: [["deposit", "100,000.00", "new"]], note: "the shares are yours. nothing else can move them." },
  { title: "Yield accrues", caption: "The vault lends the USDC out through Fluid and earns. Your shares don't grow: the month's 375.00 is counted apart, as yield no one has claimed yet.",
    active: ["vault"], flows: [], bars: { principal: 100000, yield: 375, open: 0, spent: 0 },
    ledger: [["deposit", "100,000.00"], ["accruing (no tx)", "375.00", "off"]], note: "shares never grow. the yield is counted apart." },
  { title: "Credit opens", caption: "The keeper calls report(). The vault mints the yield as shares to the Splitter, never to you, and each key's limit opens up to its share. Hollow dots on dashed lines are limit updates.",
    active: ["splitter", "keys"], flows: [["report", false], ["sync", true], ["sync2", true]], bars: { principal: 100000, yield: 375, open: 356.25, spent: 0 },
    ledger: [["deposit", "100,000.00"], ["report()", "+375.00", "new"], ["sync limits", "356.25", "new"]], note: "the yield sits with the splitter until month end." },
  { title: "Calls spend", caption: "Developers and agents call models through /v1 and paid tools through MCP. Every call is metered on its key, and a key stops at its limit with a 402.",
    active: ["keys", "models"], flows: [["calls", false], ["calls", false, .33], ["calls", false, .66]], bars: { principal: 100000, yield: 375, open: 178.12, spent: 178.13 },
    ledger: [["deposit", "100,000.00"], ["report()", "+375.00"], ["sync limits", "356.25"], ["metered calls (off-chain)", "178.13", "off"]], note: "half the credit used this month." },
  { title: "Month end", caption: "The Splitter settles: it redeems only usage plus the fee. 187.50 pays the provider, 18.75 is Inferest's 10%, and 168.75 goes back into your vault as principal.",
    active: ["splitter", "vault", "models"], flows: [["usage", false], ["back", true]], bars: { principal: 100168.75, yield: 0, open: 0, spent: 187.5 },
    ledger: [["report()", "+375.00"], ["settle(): usage", "187.50", "new"], ["settle(): fee", "18.75", "new"], ["settle(): back", "168.75", "new"]], note: "your principal grew by what you didn't use.", shares: "100,168.75" },
];
/** Reduced motion: no autoplay, and the movers sit at their path start. */
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
let step = 0, timer, flows = [];
const dots = STEPS.map((s, i) => { const d = document.createElement("button"); d.type = "button"; d.className = "dot"; d.title = s.title; d.setAttribute("aria-label", `step ${i + 1}: ${s.title}`); d.onclick = () => go(i, true); $("dots").append(d); return d; });
const strip = STEPS.map((s, i) => {
  const cell = document.createElement("div"); cell.className = "cell";
  cell.innerHTML = `<b>${i + 1}. ${esc(s.title)}</b><span>${esc(s.caption.split(/(?<=\.)\s/)[0])}</span>`;
  $("stepstrip").append(cell); return cell;
});

function drawNet(s) {
  const dashed = (d) => `<path d="${d}" fill="none" stroke="#A19C93" stroke-dasharray="5 4"/>`;
  let g = dashed(PATHS.sync) + dashed(PATHS.sync2) + dashed(PATHS.back) + dashed(PATHS.usage);
  g += `<rect x="${297 - 36}" y="6" width="72" height="28" fill="#fff" stroke="#A19C93"/><text x="297" y="24" text-anchor="middle" fill="#5F5B54" font-size="11">keeper</text>`;
  const names = Object.keys(NODES);
  names.forEach((n, i) => {
    if (i < names.length - 1) { const x1 = NODES[n][0] + W, x2 = NODES[names[i + 1]][0]; g += `<line x1="${x1}" y1="${Y + 17}" x2="${x2}" y2="${Y + 17}" stroke="#151513"/>`; }
  });
  names.forEach((n) => {
    const on = s.active.includes(n), [x, sub] = NODES[n];
    g += `<rect x="${x}" y="${Y}" width="${W}" height="${H}" fill="#fff" stroke="${on ? "#4E6AF0" : "#151513"}" stroke-width="${on ? 2 : 1}"/>`;
    g += `<text x="${x + W / 2}" y="${Y + 21}" text-anchor="middle" fill="${on ? "#4E6AF0" : "#151513"}">${n}</text>`;
    g += `<text x="${x + W / 2}" y="${Y + H + 16}" text-anchor="middle" fill="#A19C93" font-size="10">${sub}</text>`;
  });
  g += `<text x="${cx("vault") + 8}" y="232" fill="#A19C93" font-size="10">dashed: settle at month end, usage out, the rest back</text>`;
  g += `<g id="movers"></g>`;
  $("net").innerHTML = g;
  const ns = "http://www.w3.org/2000/svg";
  flows = s.flows.map(([key, hollow, phase = 0]) => {
    const p = document.createElementNS(ns, "path"); p.setAttribute("d", PATHS[key]); p.setAttribute("fill", "none");
    const c = document.createElementNS(ns, "circle"); c.setAttribute("r", hollow ? 4.5 : 5.5);
    c.setAttribute("fill", hollow ? "#fff" : "#4E6AF0"); c.setAttribute("stroke", "#4E6AF0"); c.setAttribute("stroke-width", hollow ? 1.5 : 0);
    $("movers").append(p, c);
    return { p, c, len: p.getTotalLength(), phase };
  });
  if (still) flows.forEach((f) => { const pt = f.p.getPointAtLength(f.phase * f.len); f.c.setAttribute("cx", pt.x); f.c.setAttribute("cy", pt.y); });
}

const fmt = (v) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const chart = ["principal", "yield", "open", "spent"].map((k) => {
  const col = document.createElement("div"); col.className = "col " + k;
  col.innerHTML = `<span class="v"></span><div class="b"></div><span>${k}</span>`; $("chart").append(col); return col;
});
function drawBars(b) {
  chart.forEach((col) => {
    const k = col.classList[1], v = b[k];
    col.querySelector(".v").textContent = k === "principal" ? fmt(v) + "*" : fmt(v);
    col.querySelector(".b").style.height = (k === "principal" ? 108 : Math.max(1, v / 375 * 52)) + "px";
  });
}

function go(i, manual) {
  step = (i + STEPS.length) % STEPS.length; const s = STEPS[step];
  $("title").textContent = `${step + 1}. ${s.title}`;
  $("caption").textContent = s.caption;
  dots.forEach((d, j) => { d.classList.toggle("on", j === step); d.setAttribute("aria-current", String(j === step)); });
  strip.forEach((c, j) => c.classList.toggle("on", j === step));
  drawNet(s); drawBars(s.bars);
  $("ledger").innerHTML = s.ledger.map(([op, amt, cls], j) => `<div class="row ${cls || ""}" style="animation-delay:${cls ? j * 0.25 : 0}s"><span class="i">${j + 1}</span><span class="op">${op}</span><span>${amt}</span></div>`).join("");
  $("shares").textContent = s.shares || "100,000.00";
  $("wnote").textContent = s.note;
  clearInterval(timer);
  if (!manual && !still) timer = setInterval(() => go(step + 1), 4200);
}
$("prev").onclick = () => go(step - 1, true);
$("next").onclick = () => go(step + 1, true);

function frame(t) {
  flows.forEach((f) => {
    const u = ((t / 1600) + f.phase) % 1, e = u < .5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    const pt = f.p.getPointAtLength(e * f.len);
    f.c.setAttribute("cx", pt.x); f.c.setAttribute("cy", pt.y);
    f.c.setAttribute("opacity", Math.min(1, u * 10, (1 - u) * 10));
  });
  requestAnimationFrame(frame);
}

renderControls();
wire();
setDeposit(state.deposit);
loadAgent().then(fillAgentGlimpse);
go(0); if (!still) requestAnimationFrame(frame);
