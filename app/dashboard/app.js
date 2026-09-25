import { createWalletClient, createPublicClient, custom, parseAbi, parseEventLogs, parseUnits } from "https://esm.sh/viem@2.56.9";

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
  alert(`Copy this key now, it is shown once:\n\n${r.key}`);
  await render();
};

async function render() {
  const s = await api("/api/state");
  cfg = s.config;
  $("vaults").innerHTML = s.vaults.map((v) => `
    <div class="card">
      <h3>${esc(v.label)} <span class="muted">${esc(v.vault)}</span></h3>
      <p>Yield in Splitter: <b>$${v.yieldUsd.toFixed(2)}</b> ${v.frozen ? "<b>(frozen: loss pending)</b>" : ""} &middot; period ${v.period}</p>
      <table><tr><th>Key</th><th>Weight</th><th>Budget</th><th>Spent</th><th>Tools</th><th>Left</th></tr>
      ${v.keys.map((k) => `<tr><td>${esc(k.name)}</td><td>${k.weight}</td><td>$${k.budget.toFixed(2)}</td>
        <td>$${k.spent.toFixed(4)}</td><td>$${k.toolSpent.toFixed(4)}</td><td>$${k.remaining.toFixed(2)}</td></tr>`).join("")}
      </table>
      <button onclick="window.settle('${esc(v.vault)}')">Settle now</button>
    </div>`).join("");
}
window.settle = async (vault) => { const r = await api("/api/admin/settle", { vault }); log(`settle: ${JSON.stringify(r)}`); await render(); };

render().catch((e) => log(String(e)));
