import { parseAbi, parseEventLogs, parseUnits } from "https://esm.sh/viem@2.56.9";
import { snippets } from "/snippets.js";

const factoryAbi = parseAbi([
  "function createVault(address target, string name, string symbol) returns (address)",
  "event VaultCreated(address indexed customer, address indexed vault, address indexed target)",
]);
const vaultAbi = parseAbi([
  "function acceptManagement()",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const erc20Abi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

const $ = (id) => document.getElementById(id);
const log = (m) => { $("log").textContent += m + "\n"; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const show = (id, on) => { $(id).style.display = on ? "" : "none"; };
let cfg, dyn = null, session = null, myVault;

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
    renderSession();
    log("session expired, sign in again");
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

/** No login on this page: hide the sign-in controls, say why, and open the operator section. */
function loginOff(msg) {
  dyn = null;
  session = null;
  if (msg) $("operatorhint").textContent = msg;
  show("operatorhint", true);
  show("loggedout", false);
  show("loggedin", false);
  $("operator").open = true;
}

function renderSession() {
  const on = session !== null;
  show("loggedout", !on);
  show("loggedin", on);
  show("depositcard", on && Boolean(cfg.publicRpcUrl));
  show("fund", on && cfg.demoFaucet);
  if (on) {
    $("who").textContent = session.email ?? session.address ?? "";
    $("address").textContent = session.address ?? "(no wallet yet)";
    const active = (session.address ?? "").toLowerCase();
    $("walletlist").innerHTML = (session.wallets ?? []).map((w) => {
      const on = w.toLowerCase() === active;
      return `<button class="pick${on ? " on" : ""}" data-address="${esc(w)}">${esc(w.slice(0, 6) + "..." + w.slice(-4))}${on ? " (active)" : ""}</button>`;
    }).join(" ");
  }
}

$("sendcode").onclick = async () => {
  try { await dyn.sendEmailCode($("email").value.trim()); show("codebox", true); } catch (e) { alert(String(e.message ?? e)); }
};
$("verify").onclick = async () => {
  try { session = await dyn.verifyEmailCode($("code").value.trim()); myVault = undefined; renderSession(); await render(); } catch (e) { alert(String(e.message ?? e)); }
};
/** Lists the browser's wallets as buttons in `container`; one connects (signed out) or links (signed in). */
function renderProviders(container) {
  container.innerHTML = "";
  for (const p of dyn.listWalletProviders()) {
    const b = document.createElement("button");
    b.textContent = p.name;
    b.onclick = async () => {
      try {
        await dyn.connectWallet(p.key);
        if (session) { if (!syncSession()) return; } else { session = dyn.currentSession(); }
        myVault = undefined;
        renderSession();
        await render();
      } catch (e) { alert(String(e.message ?? e)); }
    };
    container.appendChild(b);
  }
  if (!container.children.length) container.textContent = "no wallet found in this browser";
}
$("connectwallet").onclick = () => renderProviders($("providers"));
$("linkwallet").onclick = () => renderProviders($("linkproviders"));
/** A wallet button under "Signed in as" makes that wallet the one that signs. */
$("loggedin").addEventListener("click", async (e) => {
  const b = e.target.closest("button.pick");
  if (!b) return;
  try {
    if (!syncSession()) return;
    session = await dyn.chooseWallet(b.dataset.address);
    renderSession();
  } catch (err) { log(String(err.message ?? err)); }
});
$("signout").onclick = async () => {
  try { await dyn.signOut(); } catch (e) { log(String(e.message ?? e)); }
  session = null; myVault = undefined; renderSession();
  try { await render(); } catch (e) { log(String(e.message ?? e)); }
};

$("fund").onclick = async () => {
  if (!syncSession()) return;
  try {
    const r = await api("/api/demo/fund", { address: session.address });
    log(`funded ${session.address}: ${r.usdc / 1e6} USDC and gas`);
  } catch (e) { log(String(e)); }
};

async function tx(wallet, pub, address, abi, functionName, args) {
  const hash = await wallet.writeContract({ address, abi, functionName, args });
  await pub.waitForTransactionReceipt({ hash });
  log(`${functionName}: ${hash}`);
  return hash;
}

$("open").onclick = async () => {
  if (!syncSession()) return;
  $("open").disabled = true;
  try {
    const wallet = await dyn.walletClient();
    const pub = dyn.publicClient();
    const code = await wallet.request({ method: "eth_getCode", params: [cfg.factory, "latest"] });
    if (!code || code === "0x") {
      log(`your wallet is not on the demo chain: point ${cfg.chainName} (chain ${cfg.chainId}) at ${cfg.publicRpcUrl} in your wallet and try again`);
      return;
    }
    const amount = parseUnits($("amount").value, 6);
    const hash = await wallet.writeContract({ address: cfg.factory, abi: factoryAbi, functionName: "createVault", args: [cfg.target, "Inferest Vault", "infVAULT"] });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    myVault = parseEventLogs({ abi: factoryAbi, logs: receipt.logs })[0].args.vault;
    log(`vault: ${myVault}`);
    await tx(wallet, pub, myVault, vaultAbi, "acceptManagement", []);
    await tx(wallet, pub, cfg.usdc, erc20Abi, "approve", [myVault, amount]);
    await tx(wallet, pub, myVault, vaultAbi, "deposit", [amount, session.address]);
    await api("/api/vaults", { vault: myVault, label: "Treasury" });
    await render();
  } catch (e) { log(String(e.message ?? e)); } finally { $("open").disabled = false; }
};

$("withdraw").onclick = async () => {
  if (!syncSession()) return;
  try {
    const wallet = await dyn.walletClient();
    const pub = dyn.publicClient();
    const vault = myVault ?? (await api("/api/state")).vaults[0]?.vault;
    const shares = await pub.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [session.address] });
    await tx(wallet, pub, vault, vaultAbi, "redeem", [shares, session.address, session.address]);
  } catch (e) { log(String(e.message ?? e)); }
};

/** Signed in, sync and report act on this login's vault; in operator mode they act on every vault. */
const scope = () => (session && myVault ? { vault: myVault } : {});
$("sync").onclick = async () => {
  if (!syncSession()) return;
  try { await api("/api/admin/sync", scope()); await render(); } catch (e) { log(String(e.message ?? e)); }
};
$("report").onclick = async () => {
  if (!syncSession()) return;
  try { await api("/api/admin/report", scope()); await render(); } catch (e) { log(String(e.message ?? e)); }
};
$("addkey").onclick = async () => {
  if (!syncSession()) return;
  try {
    const vault = myVault ?? (await api("/api/state")).vaults[0]?.vault;
    if (!vault) { alert("no vault yet"); return; }
    const r = await api("/api/keys", { vault, name: $("keyname").value, weight: Number($("weight").value) });
    showKey(`New key: ${$("keyname").value}`, r.key);
    await render();
  } catch (e) { log(String(e.message ?? e)); }
};

let panelList = [];
let panelIndex = 0;
/** Opens the setup panel with a secret that is shown once. */
function showKey(title, secret) {
  const base = cfg.publicUrl ?? location.origin;
  panelList = snippets(base, secret);
  $("paneltitle").textContent = title;
  $("secret").textContent = secret;
  $("baseurl").textContent = base;
  $("tabs").innerHTML = "";
  for (const [i, s] of panelList.entries()) {
    const b = document.createElement("button");
    b.textContent = s.name;
    b.onclick = () => showTab(i);
    $("tabs").appendChild(b);
  }
  showTab(0);
  $("panel").classList.add("open");
  $("panel").scrollIntoView({ behavior: "smooth" });
}
function showTab(i) {
  panelIndex = i;
  $("snippet").textContent = panelList[i].text;
  for (const [j, b] of [...$("tabs").children].entries()) b.classList.toggle("on", j === i);
}
$("copysecret").onclick = () => { const s = $("secret").textContent; if (s) navigator.clipboard.writeText(s); };
$("copysnippet").onclick = () => { if (panelList[panelIndex]) navigator.clipboard.writeText(panelList[panelIndex].text); };
$("closepanel").onclick = () => {
  $("panel").classList.remove("open");
  $("secret").textContent = "";
  $("snippet").textContent = "";
  $("tabs").innerHTML = "";
  panelList = [];
  panelIndex = 0;
};

async function render() {
  const s = await api("/api/state");
  cfg = s.config;
  if (!myVault && s.vaults.length) myVault = s.vaults[0].vault;
  $("vaults").innerHTML = s.vaults.map((v) => `
    <div class="card">
      <h3>${esc(v.label)} <span class="muted">${esc(v.vault)}</span></h3>
      <p>Yield in Splitter: <b>$${v.yieldUsd.toFixed(2)}</b>
        ${v.frozen ? "<b>(frozen: loss pending)</b>" : ""} ${v.settling ? "<b>(settling)</b>" : ""}
        &middot; period ${esc(v.period)}
        &middot; provider backstop: limit $${v.orLimit.toFixed(2)}, used $${v.orUsage.toFixed(2)}${v.hasOpenRouterKey ? "" : " (no provider key yet)"}</p>
      <table><tr><th>Key</th><th>Weight</th><th>Budget</th><th>Models</th><th>Tools</th><th>Left</th><th></th></tr>
      ${v.keys.map((k) => `<tr class="${k.revoked ? "revoked" : ""}"><td>${esc(k.name)}${k.revoked ? " (revoked)" : ""}</td><td>${k.weight}</td>
        <td>$${k.budget.toFixed(2)}</td><td>$${k.modelSpent.toFixed(4)}</td><td>$${k.toolSpent.toFixed(4)}</td><td>$${k.remaining.toFixed(2)}</td>
        <td>${k.revoked ? "" : `<button class="rotate" data-id="${esc(k.id)}" data-name="${esc(k.name)}">Rotate</button>
          <button class="revoke" data-id="${esc(k.id)}" data-name="${esc(k.name)}">Revoke</button>`}</td></tr>`).join("")}
      </table>
      <button class="settle" data-vault="${esc(v.vault)}">Settle now</button>
    </div>`).join("") || `<p class="muted">${emptyText()}</p>`;
}
/** What the empty vault list says, by who is looking. */
function emptyText() {
  if (session || $("token").value) return "No vault yet.";
  return cfg.dynamicEnvironmentId ? "Sign in to see your vaults." : "Type the operator token to see vaults.";
}
$("vaults").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  try {
    if (b.classList.contains("settle")) {
      const r = await api("/api/admin/settle", { vault: b.dataset.vault });
      log(`settle: ${JSON.stringify(r)}`);
    } else if (b.classList.contains("revoke")) {
      if (!confirm(`Revoke key ${b.dataset.name}? Its next request gets 401.`)) return;
      await api(`/api/keys/${b.dataset.id}/revoke`, {});
      log(`revoked ${b.dataset.name}`);
    } else if (b.classList.contains("rotate")) {
      const r = await api(`/api/keys/${b.dataset.id}/rotate`, {});
      showKey(`Rotated key: ${b.dataset.name}`, r.key);
    } else {
      return;
    }
    await render();
  } catch (err) {
    log(String(err));
  }
});
$("token").addEventListener("change", () => { render().catch((e) => log(String(e))); });

loadConfig().then(loadDynamic).then(render).catch((e) => log(String(e)));
