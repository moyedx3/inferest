import { createWalletClient, createPublicClient, custom, parseAbi, parseEventLogs, parseUnits } from "https://esm.sh/viem@2.56.9";
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
let wallet, pub, account, cfg, myVault;

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json", "x-admin-token": $("token").value }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.status);
  return j;
}

async function tx(address, abi, functionName, args) {
  const hash = await wallet.writeContract({ address, abi, functionName, args, account, chain: null });
  await pub.waitForTransactionReceipt({ hash });
  log(`${functionName}: ${hash}`);
  return hash;
}

$("connect").onclick = async () => {
  [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
  wallet = createWalletClient({ transport: custom(window.ethereum) });
  pub = createPublicClient({ transport: custom(window.ethereum) });
  $("account").textContent = account;
};

$("open").onclick = async () => {
  const amount = parseUnits($("amount").value, 6);
  const hash = await wallet.writeContract({ address: cfg.factory, abi: factoryAbi, functionName: "createVault",
    args: [cfg.target, "Inferest Vault", "infVAULT"], account, chain: null });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  myVault = parseEventLogs({ abi: factoryAbi, logs: receipt.logs })[0].args.vault;
  log(`vault: ${myVault}`);
  await tx(myVault, vaultAbi, "acceptManagement", []);
  await tx(cfg.usdc, erc20Abi, "approve", [myVault, amount]);
  await tx(myVault, vaultAbi, "deposit", [amount, account]);
  await api("/api/vaults", { vault: myVault, label: "Treasury" });
  await render();
};

$("withdraw").onclick = async () => {
  const shares = await pub.readContract({ address: myVault, abi: vaultAbi, functionName: "balanceOf", args: [account] });
  await tx(myVault, vaultAbi, "redeem", [shares, account, account]);
};

$("sync").onclick = async () => { await api("/api/admin/sync", {}); await render(); };
$("report").onclick = async () => { await api("/api/admin/report", {}); await api("/api/admin/sync", {}); await render(); };
$("addkey").onclick = async () => {
  const vault = myVault ?? (await api("/api/state")).vaults[0]?.vault;
  const r = await api("/api/keys", { vault, name: $("keyname").value, weight: Number($("weight").value) });
  showKey(`New key: ${$("keyname").value}`, r.key);
  await render();
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
  $("vaults").innerHTML = s.vaults.map((v) => `
    <div class="card">
      <h3>${esc(v.label)} <span class="muted">${esc(v.vault)}</span></h3>
      <p>Yield in Splitter: <b>$${v.yieldUsd.toFixed(2)}</b>
        ${v.frozen ? "<b>(frozen: loss pending)</b>" : ""} ${v.settling ? "<b>(settling)</b>" : ""}
        &middot; period ${v.period}
        &middot; provider backstop: limit $${v.orLimit.toFixed(2)}, used $${v.orUsage.toFixed(2)}${v.hasOpenRouterKey ? "" : " (no provider key yet)"}</p>
      <table><tr><th>Key</th><th>Weight</th><th>Budget</th><th>Models</th><th>Tools</th><th>Left</th><th></th></tr>
      ${v.keys.map((k) => `<tr class="${k.revoked ? "revoked" : ""}"><td>${esc(k.name)}${k.revoked ? " (revoked)" : ""}</td><td>${k.weight}</td>
        <td>$${k.budget.toFixed(2)}</td><td>$${k.modelSpent.toFixed(4)}</td><td>$${k.toolSpent.toFixed(4)}</td><td>$${k.remaining.toFixed(2)}</td>
        <td>${k.revoked ? "" : `<button class="rotate" data-id="${esc(k.id)}" data-name="${esc(k.name)}">Rotate</button>
          <button class="revoke" data-id="${esc(k.id)}" data-name="${esc(k.name)}">Revoke</button>`}</td></tr>`).join("")}
      </table>
      <button class="settle" data-vault="${esc(v.vault)}">Settle now</button>
    </div>`).join("");
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

render().catch((e) => log(String(e)));
