import { parseAbi, parseEventLogs, parseUnits, formatUnits } from "https://esm.sh/viem@2.56.9";
import { snippets, NOTES } from "/snippets.js";

const factoryAbi = parseAbi([
  "function createVault(address target, string name, string symbol) returns (address)",
  "event VaultCreated(address indexed customer, address indexed vault, address indexed target)",
]);
const vaultAbi = parseAbi([
  "function acceptManagement()",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);

const PLACEHOLDER = "sk-inf-YOUR-KEY";
const KEY_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg>`;
const svg = (paths) => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  link: svg(`<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`),
  box: svg(`<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>`),
  stop: svg(`<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/>`),
  lock: svg(`<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`),
};
const TAB_NAMES = { "OpenAI SDK (Python)": "Python", "OpenAI SDK (Node)": "Node", "MCP tools (same key)": "MCP" };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const show = (id, on) => { $(id).hidden = !on; };
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const usd = (n, digits = 2) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
/** Spend figures: four decimals below a cent, so a single model call is visible in the row it moved. */
const spent = (n) => usd(n, n > 0 && n < 0.01 ? 4 : 2);
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);

let cfg, dyn = null, session = null, myVault;
let lastState = null;
/** What the chosen wallet holds, read from the chain: { vault, principal, shares, sharesDecimals, usdc }. */
let wallet = null;
let newKeyId = null;
let loginIsOff = false;
const events = [];

/** One row in the Activity list, newest first. Replaces the old raw log; secrets never go here. */
function activity({ icon = "•", title, detail = "", tx = "", error = false }) {
  events.unshift({ at: Date.now(), icon: error ? "!" : icon, title, detail, tx, error });
  if (error && document.body.dataset.state === "out") $("nologin").textContent = `${title}: ${detail}`; // the feed is hidden until sign-in
  renderActivity();
}
const fail = (title) => (e) => activity({ title, detail: String(e?.message ?? e), error: true });

/**
 * Takes the SDK's live session, whose token Dynamic refreshes on its own. Returns false (and signs the page out)
 * when the SDK no longer has one; true otherwise, including when there is no login to follow.
 */
function syncSession() {
  if (!dyn || !session) return true;
  const live = dyn.currentSession();
  if (live === null) {
    session = null;
    myVault = undefined;
    wallet = null;
    renderSession();
    closePanel();
    activity({ title: "Session expired", detail: "sign in again", error: true });
    return false;
  }
  session = live;
  return true;
}

/** Every API call carries the session's bearer, or the operator token when one is typed in. */
function headers() {
  const h = { "Content-Type": "application/json" };
  if (session) h.Authorization = `Bearer ${session.token}`;
  const token = $("token").value;
  if (token) h["x-admin-token"] = token;
  return h;
}
async function api(path, body) {
  syncSession();
  const r = await fetch(path, body === undefined ? { headers: headers() } : { method: "POST", headers: headers(), body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.status);
  return j;
}

async function loadConfig() {
  cfg = (await api("/api/state")).config;
  $("network").textContent = `${cfg.chainName ?? `chain ${cfg.chainId}`}${cfg.demoFaucet ? " · demo fork" : ""}`;
  $("contracts").innerHTML = [["Factory", cfg.factory], ["Splitter", cfg.splitter], ["USDC", cfg.usdc]]
    .filter(([, a]) => a).map(([k, a]) => `<span>${k}<b>${esc(short(a))}</b></span>`).join(" ");
}

/** Loads the Dynamic bundle when the server has a login environment; says so when the bundle was not built. */
async function loadDynamic() {
  if (!cfg.dynamicEnvironmentId) { loginOff(null); return; }
  try {
    dyn = await import("/dynamic.bundle.js");
  } catch {
    loginOff("dashboard bundle missing: run npm run build:dashboard");
    return;
  }
  try {
    session = await dyn.initDynamic(cfg);
  } catch (e) {
    const msg = `login unavailable: ${e.message ?? e}`;
    $("nologin").textContent = msg;
    loginOff(msg);
    return;
  }
  renderSession();
}

/** No login on this page: the sign-in card holds the operator token instead of email and wallet. */
function loginOff(msg) {
  dyn = null;
  session = null;
  if (msg) $("operatorhint").textContent = msg;
  show("operatorhint", true);
  show("loggedout", false);
  show("loginfine", false);
  loginIsOff = true;
  placeOperatorField();
}

/**
 * With login off the token field lives in the sign-in card while the page is signed out, and in the open
 * footer section once a token is typed, so a mistyped token can always be corrected without a reload.
 */
function placeOperatorField() {
  if (!loginIsOff) return;
  const out = document.body.dataset.state === "out";
  const home = out ? $("operatorslot") : $("operator");
  if ($("operatorfield").parentElement === home) return;
  home.appendChild($("operatorfield"));
  show("operator", !out);
  $("operator").open = !out; // opened once, when the field arrives; the user may close it after that
}

function renderSession() {
  const on = session !== null;
  show("whochip", on);
  show("signout", on);
  show("linkwallet", on);
  show("fund", on && Boolean(cfg.demoFaucet));
  show("depositcard", on && Boolean(cfg.publicRpcUrl));
  if (on) {
    $("who").textContent = session.email ?? "";
    $("address").textContent = session.address ? short(session.address) : "(no wallet yet)";
    const active = (session.address ?? "").toLowerCase();
    const wallets = session.wallets ?? [];
    $("walletlist").innerHTML = wallets.length > 1 ? wallets.map((w) => {
      const sel = w.toLowerCase() === active;
      return `<button class="pick${sel ? " on" : ""}" data-address="${esc(w)}">${esc(short(w))}</button>`;
    }).join(" ") : "";
  } else {
    $("walletlist").innerHTML = "";
    $("linkproviders").innerHTML = "";
  }
  setPageState();
}

/** out: nobody to show vaults to; novault: a caller with no vault yet; vault: a caller looking at a vault. */
function setPageState() {
  const caller = session !== null || $("token").value !== "";
  document.body.dataset.state = !caller ? "out" : currentVault() ? "vault" : "novault";
  placeOperatorField();
}

/** The vault the page shows: the one this login just created or picked, else the first the caller may see. */
function currentVault() {
  const vaults = lastState?.vaults ?? [];
  return vaults.find((v) => v.vault === myVault?.toLowerCase()) ?? vaults[0];
}

$("sendcode").onclick = async () => {
  try { await dyn.sendEmailCode($("email").value.trim()); show("codebox", true); $("code").focus(); } catch (e) { fail("Sign-in code not sent")(e); }
};
$("verify").onclick = async () => {
  try { session = await dyn.verifyEmailCode($("code").value.trim()); myVault = undefined; wallet = null; renderSession(); await render(); } catch (e) { fail("Code not accepted")(e); }
};
/** Lists the browser's wallets as buttons in `container`; one connects (signed out) or links (signed in). */
function renderProviders(container) {
  container.innerHTML = "";
  for (const p of dyn.listWalletProviders()) {
    const b = document.createElement("button");
    b.className = "btn btn-small";
    b.textContent = p.name;
    b.onclick = async () => {
      try {
        await dyn.connectWallet(p.key);
        if (session) { if (!syncSession()) return; } else { session = dyn.currentSession(); }
        myVault = undefined;
        wallet = null;
        container.innerHTML = "";
        renderSession();
        await render();
      } catch (e) { fail("Wallet not connected")(e); }
    };
    container.appendChild(b);
  }
  if (!container.children.length) container.textContent = "No wallet found in this browser.";
}
$("connectwallet").onclick = () => renderProviders($("providers"));
$("linkwallet").onclick = () => renderProviders($("linkproviders"));
/** A wallet button in the top bar makes that wallet the one that signs. */
$("walletlist").addEventListener("click", async (e) => {
  const b = e.target.closest("button.pick");
  if (!b) return;
  try {
    if (!syncSession()) return;
    session = await dyn.chooseWallet(b.dataset.address);
    wallet = null;
    renderSession();
    await render();
  } catch (err) { fail("Wallet not switched")(err); }
});
$("signout").onclick = async () => {
  try { await dyn.signOut(); } catch (e) { fail("Sign out")(e); }
  session = null; myVault = undefined; wallet = null; renderSession();
  closePanel(); // a key shown to this login must not outlive the session on a shared screen
  try { await render(); } catch (e) { fail("Refresh failed")(e); }
};

$("fund").onclick = async () => {
  if (!syncSession()) return;
  try {
    const r = await api("/api/demo/fund", { address: session.address });
    activity({ icon: "◇", title: "Demo funds received", detail: `${(r.usdc / 1e6).toLocaleString("en-US")} USDC and gas to ${short(session.address)}` });
    await readWallet();
  } catch (e) { fail("Demo funds")(e); }
};

const TX_TITLES = { acceptManagement: "Management accepted", approve: "USDC approved", deposit: "Deposited", redeem: "Withdrew everything" };
async function tx(wallet, pub, address, abi, functionName, args, detail = "") {
  const hash = await wallet.writeContract({ address, abi, functionName, args });
  await pub.waitForTransactionReceipt({ hash });
  activity({ icon: functionName === "redeem" ? "↑" : "↓", title: TX_TITLES[functionName] ?? functionName, detail, tx: hash });
  return hash;
}

/** With a vault: approve and deposit into it. Without: create the vault, accept management, approve, deposit. */
$("open").onclick = async () => {
  if (!syncSession()) return;
  $("open").disabled = true;
  try {
    const w = await dyn.walletClient();
    const pub = dyn.publicClient();
    const code = await w.request({ method: "eth_getCode", params: [cfg.factory, "latest"] });
    if (!code || code === "0x") {
      activity({ title: "Wrong chain", detail: `point ${cfg.chainName} (chain ${cfg.chainId}) at ${cfg.publicRpcUrl} in your wallet and try again`, error: true });
      return;
    }
    if (!(Number($("amount").value) > 0)) {
      activity({ title: "Deposit", detail: "enter an amount above zero", error: true });
      return;
    }
    const amount = parseUnits($("amount").value, 6);
    const amountText = `${Number($("amount").value).toLocaleString("en-US")} USDC`;
    await readWallet(); // a fresh balance, so the check below never trusts a figure from before a fund or a transfer
    if (wallet?.usdc != null && amount > wallet.usdc) {
      activity({ title: "Deposit", detail: `${amountText} is more than the ${Number(formatUnits(wallet.usdc, 6)).toLocaleString("en-US")} USDC in your wallet`, error: true });
      return;
    }
    let vault = currentVault()?.vault;
    if (!vault) {
      const hash = await w.writeContract({ address: cfg.factory, abi: factoryAbi, functionName: "createVault", args: [cfg.target, "Inferest Vault", "infVAULT"] });
      const receipt = await pub.waitForTransactionReceipt({ hash });
      vault = parseEventLogs({ abi: factoryAbi, logs: receipt.logs })[0].args.vault;
      myVault = vault;
      activity({ icon: "◆", title: "Vault created", detail: short(vault), tx: hash });
      await tx(w, pub, vault, vaultAbi, "acceptManagement", []);
      await tx(w, pub, cfg.usdc, erc20Abi, "approve", [vault, amount]);
      await tx(w, pub, vault, vaultAbi, "deposit", [amount, session.address], `${amountText} from ${short(session.address)}`);
      await api("/api/vaults", { vault, label: "Treasury" });
    } else {
      await tx(w, pub, cfg.usdc, erc20Abi, "approve", [vault, amount]);
      await tx(w, pub, vault, vaultAbi, "deposit", [amount, session.address], `${amountText} from ${short(session.address)}`);
    }
    wallet = null;
    await render();
  } catch (e) { fail("Deposit failed")(e); } finally { $("open").disabled = false; }
};

$("withdraw").onclick = async () => {
  if (!syncSession()) return;
  try {
    const w = await dyn.walletClient();
    const pub = dyn.publicClient();
    const vault = currentVault()?.vault;
    const shares = await pub.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [session.address] });
    await tx(w, pub, vault, vaultAbi, "redeem", [shares, session.address, session.address], `all shares to ${short(session.address)}`);
    wallet = null;
    await render();
  } catch (e) { fail("Withdraw failed")(e); }
};

/** Signed in, sync and report act on the shown vault; in operator mode they act on every vault. */
const scope = () => (session && currentVault() ? { vault: currentVault().vault } : {});
$("sync").onclick = async () => {
  if (!syncSession()) return;
  try {
    await api("/api/admin/sync", scope());
    await render();
    const v = currentVault();
    activity({ icon: "⇄", title: "Limits synced", detail: v ? `backstop ${usd(v.orLimit)}, used ${spent(v.orUsage)}` : "" });
  } catch (e) { fail("Sync failed")(e); }
};
$("report").onclick = async () => {
  if (!syncSession()) return;
  try {
    await api("/api/admin/report", scope());
    await render();
    const v = currentVault();
    activity({ icon: "↻", title: "Yield reported", detail: v ? `${usd(v.yieldUsd)} in the Splitter` : "" });
  } catch (e) { fail("Report failed")(e); }
};
$("settle").onclick = async () => {
  const v = currentVault();
  if (!v || !syncSession()) return;
  try {
    const r = await api("/api/admin/settle", { vault: v.vault });
    if (r.usageMicro === null) activity({ icon: "✓", title: "Nothing to settle", detail: `period ${v.period} had no settlement to send` });
    else activity({ icon: "✓", title: r.pending ? "Settlement sent" : `Settled period ${v.period}`, detail: `usage ${spent(Number(r.usageMicro) / 1e6)} to float${r.pending ? ", waiting for its receipt" : ""}`, tx: r.tx ?? "" });
    wallet = null; // the leftover came back as shares: read principal and shares again
    await render();
  } catch (e) { fail("Settle failed")(e); }
};
$("addkey").onclick = async () => {
  if (!syncSession()) return;
  try {
    const vault = currentVault()?.vault;
    if (!vault) return;
    const name = $("keyname").value;
    const r = await api("/api/keys", { vault, name, weight: Number($("weight").value) });
    newKeyId = r.id;
    await render(); // the new row must be in state before the banner takes its baseline
    showKey(`New key: ${name}`, r.key, r.id);
    activity({ icon: "+", title: "Key created", detail: `${name}, weight ${$("weight").value}` });
  } catch (e) { fail("Key not created")(e); }
};

let panelSecret = null;
let panelIndex = 0;
/** The key the open banner shows, what it had spent when shown, and the timer that watches for its first call. */
let panelKey = null;
let watchTimer = null;
const WATCH_MS = 4000;
/** Opens the banner with a secret that is shown once; the snippets use it until the banner is closed. */
function showKey(title, secret, keyId) {
  panelSecret = secret;
  const k = currentVault()?.keys.find((x) => x.id === keyId);
  panelKey = keyId ? { id: keyId, base: k?.spent ?? 0, metered: false } : null;
  clearInterval(watchTimer);
  if (panelKey) watchTimer = setInterval(() => { render().catch(() => {}); }, WATCH_MS);
  renderResult();
  $("paneltitle").textContent = title;
  $("secret").textContent = secret;
  show("panel", true);
  renderSnippets();
  $("use-a-key").scrollIntoView({ behavior: "smooth" });
}
/** The six client setups, with the shown secret or the placeholder. */
function renderSnippets() {
  const list = snippets(cfg.publicUrl ?? location.origin, panelSecret ?? PLACEHOLDER);
  $("tabs").innerHTML = "";
  for (const [i, s] of list.entries()) {
    const b = document.createElement("button");
    b.textContent = TAB_NAMES[s.name] ?? s.name.replace(/ \(.*\)$/, "");
    b.title = s.name;
    b.className = i === panelIndex ? "on" : "";
    b.onclick = () => { panelIndex = i; renderSnippets(); };
    $("tabs").appendChild(b);
  }
  $("snippet").textContent = list[panelIndex].text;
}
$("copysecret").onclick = () => { if (panelSecret) navigator.clipboard.writeText(panelSecret); };
$("copysnippet").onclick = () => navigator.clipboard.writeText($("snippet").textContent);
/** Closes the banner and takes the secret out of the page and the snippets. */
function closePanel() {
  panelSecret = null;
  panelKey = null;
  clearInterval(watchTimer);
  renderResult();
  $("secret").textContent = "";
  show("panel", false);
  renderSnippets();
}
$("closepanel").onclick = closePanel;

/**
 * The line under the snippet: while the banner is open it waits for the shown key's first metered call, then
 * shows what that call cost and what the key has left. The page polls state until then, and stops once it has.
 */
function renderResult() {
  const k = panelKey && currentVault()?.keys.find((x) => x.id === panelKey.id);
  show("result", Boolean(k));
  if (!k) return;
  const cost = k.spent - panelKey.base;
  if (cost > 0 && !panelKey.metered) { panelKey.metered = true; clearInterval(watchTimer); }
  $("resultstatus").textContent = panelKey.metered ? "200" : "···";
  $("resultstatus").className = `status${panelKey.metered ? "" : " wait"}`;
  $("resulttext").textContent = panelKey.metered ? `First call metered against ${k.name}` : `Run the snippet. This line updates when ${k.name}'s first call is metered.`;
  $("resultcost").textContent = panelKey.metered ? `cost ${spent(cost)} · left ${usd(k.remaining)}` : "";
}

function renderNotes() {
  $("notes").innerHTML = NOTES.map((n) => `<li><i class="noteicon">${ICONS[n.icon] ?? ""}</i><div>
    <b class="${/^\d/.test(n.title) ? "mono" : ""}">${esc(n.title)}</b><span>${esc(n.text)}</span></div></li>`).join("");
}

/** Reads principal, shares and the USDC balance for the chosen wallet. Needs a wallet session and the browser RPC. */
async function readWallet() {
  const v = currentVault();
  if (!dyn || !session?.address || !cfg.publicRpcUrl) { wallet = null; return; }
  try {
    const pub = dyn.publicClient();
    const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
    const usdc = await read(cfg.usdc, erc20Abi, "balanceOf", [session.address]);
    let principal = null, shares = null, sharesDecimals = 6;
    if (v) {
      shares = await read(v.vault, vaultAbi, "balanceOf", [session.address]);
      sharesDecimals = Number(await read(v.vault, vaultAbi, "decimals"));
      principal = await read(v.vault, vaultAbi, "convertToAssets", [shares]);
    }
    wallet = { vault: v?.vault, usdc, principal, shares, sharesDecimals };
  } catch {
    wallet = null; // an unreachable RPC only hides the wallet figures
  }
  renderTreasury();
}

function renderTreasury() {
  const v = currentVault();
  const s = lastState;
  const w = wallet && wallet.vault === v?.vault ? wallet : null;
  const principal = w?.principal != null ? Number(formatUnits(w.principal, 6)) : null;

  // tag: period and flags, or a picker when the caller sees several vaults
  if (s && s.vaults.length > 1) {
    $("treasurytag").innerHTML = `Treasury · <select id="vaultpick">${s.vaults.map((x) =>
      `<option value="${esc(x.vault)}"${x.vault === v?.vault ? " selected" : ""}>${esc(x.label)} ${esc(short(x.vault))} · period ${x.period}</option>`).join("")}</select>`;
    $("vaultpick").onchange = (e) => { myVault = e.target.value; wallet = null; render().catch(fail("Refresh failed")); };
  } else {
    $("treasurytag").innerHTML = v ? `Treasury · period ${esc(v.period)}` : "Treasury · no vault yet";
  }
  if (v?.frozen) $("treasurytag").insertAdjacentHTML("beforeend", ` <span class="flag">frozen: loss pending</span>`);
  if (v?.settling) $("treasurytag").insertAdjacentHTML("beforeend", ` <span class="flag">settling</span>`);

  $("headline").innerHTML = !v
    ? `Put idle USDC to work.<span class="second">Deposit once. Your keys open as the interest comes in.</span>`
    : principal !== null
      ? `Your ${esc(usd(principal, 0))} stays put.<span class="second">Only the interest it earns pays for inference.</span>`
      : `Your principal stays put.<span class="second">Only the interest it earns pays for inference.</span>`;

  // deposit card
  $("deposittitle").textContent = v ? "Add to principal" : "Create your vault";
  $("open").textContent = v ? "Deposit" : "Create vault and deposit";
  $("walletbalance").textContent = w ? `Wallet balance ${Number(formatUnits(w.usdc, 6)).toLocaleString("en-US")} USDC` : "";
  const funded = !v && Boolean(w && w.usdc > 0n); // before the vault, a funded wallet needs no second click
  $("fund").textContent = funded ? "✓ Funded" : "Get demo funds";
  $("fund").disabled = funded;
  $("stepfunds").className = `step${w && w.usdc > 0n ? " done" : ""}`;
  $("stepfunds").querySelector(".num").textContent = w && w.usdc > 0n ? "✓" : "1";

  if (!v) return;
  const keys = v.keys;
  const used = sum(keys, (k) => k.spent);
  const open = Math.max(0, v.credit - used);
  $("yield").textContent = usd(v.yieldUsd);
  $("vaultname").textContent = `${v.label} vault`;
  $("vaultlink").textContent = `${short(v.vault)} ↗`;
  if (cfg.explorer) $("vaultlink").href = `${cfg.explorer}/address/${v.vault}`; else $("vaultlink").removeAttribute("href");
  $("usedamt").textContent = spent(used);
  $("openamt").textContent = usd(open);
  const share = v.credit > 0 ? used / v.credit : 0;
  $("barused").hidden = used <= 0;
  $("barused").style.flex = `0 0 ${Math.min(100, Math.max(12, share * 100))}%`;
  $("principalbar").hidden = principal === null;
  $("principal").textContent = principal !== null ? usd(principal) : "";
  $("models").textContent = spent(sum(keys, (k) => k.modelSpent));
  const live = keys.filter((k) => !k.revoked).length;
  $("modelsnote").textContent = `through the proxy, ${live} key${live === 1 ? "" : "s"}`;
  $("tools").textContent = spent(sum(keys, (k) => k.toolSpent));
  $("backstop").textContent = v.hasOpenRouterKey ? `${spent(v.orUsage)} / ${usd(v.orLimit)}` : "none";
  $("backstopnote").textContent = v.hasOpenRouterKey ? "OpenRouter key, synced" : "no provider key yet";
  $("sharescell").hidden = w?.shares == null;
  if (w?.shares != null) {
    $("shares").textContent = `${Number(formatUnits(w.shares, w.sharesDecimals)).toLocaleString("en-US", { maximumFractionDigits: 1 })} infVAULT`;
    $("sharesnote").textContent = `in ${short(session?.address)}`;
  }
  $("pvperiod").textContent = `period ${v.period} → ${v.period + 1}`;
  $("pvusage").textContent = spent(v.preview.usage);
  $("pvfee").textContent = usd(v.preview.fee);
  $("pvreturned").textContent = usd(v.preview.returned);
}

function renderKeys() {
  const v = currentVault();
  $("keyshead").innerHTML = `${v ? "Every key spends only yield." : "Keys come after the vault."}<span class="second">Split by weight. Unused yield comes back, less 10%.</span>`;
  $("addkey").disabled = !v;
  const keys = v?.keys ?? [];
  if (!keys.length) {
    $("keyrows").innerHTML = `<tr><td colspan="6" class="empty"><b>No keys yet</b>${v
      ? "Create one above. It spends from this period's yield."
      : "Create one after your first deposit. It opens as soon as the vault has earned yield."}</td></tr>`;
    return;
  }
  $("keyrows").innerHTML = keys.map((k) => {
    const pct = (x) => (k.budget > 0 && x > 0 ? Math.max(1, Math.min(100, (x / k.budget) * 100)) : 0);
    const bar = `${pct(k.modelSpent) ? `<i style="width:${pct(k.modelSpent)}%"></i>` : ""}${pct(k.toolSpent) ? `<i style="width:${pct(k.toolSpent)}%"></i>` : ""}`;
    const created = new Date(k.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `<tr class="${k.revoked ? "revoked" : ""}">
      <td><div class="keyname"><span class="glyph">${KEY_ICON}</span><div><b>${esc(k.name)}</b>${k.id === newKeyId && !k.revoked ? `<span class="badge new">new</span>` : ""}${k.revoked ? `<span class="badge revoked">revoked</span>` : ""}
        <small>${k.revoked ? "Revoked" : `Created ${esc(created)}`}</small></div></div></td>
      <td class="amt faint">×${esc(k.weight)}</td>
      <td class="amt">${usd(k.budget)}</td>
      <td class="spend"><div class="nums"><span class="amt">${spent(k.spent)}</span><small>${k.revoked ? "" : `models ${spent(k.modelSpent)} · tools ${spent(k.toolSpent)}`}</small></div><div class="spendbar">${bar}</div></td>
      <td class="amt"><b style="font-weight:500">${k.revoked ? "—" : usd(k.remaining)}</b></td>
      <td class="actions">${k.revoked ? "" : `<button class="btn btn-small rotate" data-id="${esc(k.id)}" data-name="${esc(k.name)}">Rotate</button><button class="btn btn-small btn-danger revoke" data-id="${esc(k.id)}" data-name="${esc(k.name)}">Revoke</button>`}</td>
    </tr>`;
  }).join("");
}
$("keyrows").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  try {
    if (b.classList.contains("revoke")) {
      if (!confirm(`Revoke key ${b.dataset.name}? Its next request gets 401.`)) return;
      await api(`/api/keys/${b.dataset.id}/revoke`, {});
      activity({ icon: "✕", title: "Key revoked", detail: b.dataset.name });
    } else if (b.classList.contains("rotate")) {
      const r = await api(`/api/keys/${b.dataset.id}/rotate`, {});
      showKey(`Rotated key: ${b.dataset.name}`, r.key, b.dataset.id);
      activity({ icon: "↺", title: "Key rotated", detail: `${b.dataset.name}, same budget` });
    } else {
      return;
    }
    await render();
  } catch (err) { fail("Key action failed")(err); }
});

/** Session events, then the shown vault's settlements from the server that the session has not already listed. */
function renderActivity() {
  const v = currentVault();
  const seen = new Set(events.map((e) => e.tx).filter(Boolean));
  const settled = (lastState?.settlements ?? []).filter((s) => s.vault === v?.vault && !seen.has(s.tx))
    .map((s) => ({ at: s.at, icon: "✓", title: "Settled", detail: `usage ${spent(Number(s.usageMicro) / 1e6)} to float`, tx: s.tx }));
  const rows = [...events, ...settled].sort((a, b) => b.at - a.at);
  const when = (at) => {
    const d = new Date(at);
    return d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
      : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };
  const link = (tx) => (!tx ? "" : cfg?.explorer
    ? `<a href="${esc(cfg.explorer)}/tx/${esc(tx)}" target="_blank" rel="noopener">${esc(short(tx))} ↗</a>`
    : `<span class="mono faint">${esc(short(tx))}</span>`);
  $("activity").innerHTML = rows.length ? rows.map((r) => `<li class="${r.error ? "error" : ""}">
      <time>${esc(when(r.at))}</time><span class="glyph">${esc(r.icon)}</span>
      <div class="what"><b>${esc(r.title)}</b><span>${esc(r.detail)}</span></div>${link(r.tx)}</li>`).join("")
    : `<li class="none">Nothing yet in this session.</li>`;
}

async function render() {
  const s = await api("/api/state");
  cfg = s.config;
  lastState = s;
  if (myVault && !s.vaults.some((v) => v.vault === myVault.toLowerCase())) myVault = undefined;
  setPageState();
  renderTreasury();
  renderKeys();
  renderActivity();
  renderResult();
  if (session && (!wallet || wallet.vault !== currentVault()?.vault)) await readWallet();
}

$("token").addEventListener("change", () => { render().catch(fail("Refresh failed")); });

renderNotes();
loadConfig()
  .then(() => { renderSnippets(); return loadDynamic(); })
  .then(() => { renderSession(); return render(); })
  .catch(fail("Page failed to load"));
