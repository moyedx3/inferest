// The Home page: the calculator. It reads only GET /api/agent, for the demo agent preset's deposit, and loads no wallet code.
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

/** GET /api/agent: the demo agent's parked value for its preset. Any failure leaves 500. */
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

renderControls();
wire();
setDeposit(state.deposit);
loadAgent();
