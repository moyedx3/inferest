// The only file that touches Dynamic's SDK. Bundled by `npm run build:dashboard`; the dashboard imports the bundle.
import { createDynamicClient, initializeClient, sendEmailOTP, verifyOTP, getAvailableWalletProvidersData, connectAndVerifyWithWalletProvider, getPrimaryWalletAccount, getWalletAccounts, getSelectedWalletAccount, setSelectedWalletAccount, switchActiveNetwork, logout, refreshAuth } from "@dynamic-labs-sdk/client";
import { createWaasWalletAccounts, getChainsMissingWaasWalletAccounts } from "@dynamic-labs-sdk/client/waas";
import { addEvmExtension } from "@dynamic-labs-sdk/evm";
import { addWalletConnectEvmExtension } from "@dynamic-labs-sdk/evm/wallet-connect";
import { createWalletClientForWalletAccount, createPublicClientFromNetworkData } from "@dynamic-labs-sdk/evm/viem";

let client = null;
let network = null;
let otp = null;
/** The wallet that signs: the one this login last chose, kept by the SDK across reloads. */
let active = null;

const evmAccounts = () => getWalletAccounts().filter((w) => w.chain === "EVM");

/** Makes `account` the signing wallet and asks the SDK to remember it. */
async function choose(account) {
  active = account ?? null;
  if (active) await setSelectedWalletAccount({ walletAccount: active }).catch(() => {});
}

/** Our chain as Dynamic describes a network; placed first so it is the default for every wallet. */
function networkFor(cfg) {
  return {
    chain: "EVM",
    networkId: String(cfg.chainId),
    name: `evm-${cfg.chainId}`,
    displayName: cfg.chainName,
    iconUrl: cfg.explorer ? `${cfg.explorer}/favicon.ico` : "",
    nativeCurrency: cfg.nativeCurrency,
    rpcUrls: { http: [cfg.publicRpcUrl] },
    blockExplorerUrls: cfg.explorer ? [cfg.explorer] : [],
    testnet: Boolean(cfg.demoFaucet), // a fork with a faucet is not a production chain
  };
}

/**
 * Creates and initializes the client for this environment. `cfg` is the dashboard's /api/state config. When
 * `publicRpcUrl` is set, our network replaces Dynamic's own entry for the chain id (a fork needs its own RPC).
 */
export async function initDynamic(cfg) {
  network = cfg.publicRpcUrl ? networkFor(cfg) : null;
  client = createDynamicClient({
    environmentId: cfg.dynamicEnvironmentId,
    autoInitialize: false,
    metadata: { name: "Inferest", universalLink: location.origin },
    transformers: network ? { networksData: (list) => [network, ...list.filter((n) => n.networkId !== network.networkId)] } : undefined,
  });
  addEvmExtension();
  await addWalletConnectEvmExtension().catch(() => {}); // no WalletConnect project id configured: extensions stay browser-only
  await initializeClient();
  if (client.token) await refreshAuth().catch(() => {}); // a restored session gets a fresh token that lists every wallet
  active = getSelectedWalletAccount() ?? getPrimaryWalletAccount();
  return currentSession();
}

export async function sendEmailCode(email) {
  otp = await sendEmailOTP({ email });
}

/** Verifies the code, then makes sure the login has an EVM embedded wallet. */
export async function verifyEmailCode(code) {
  if (!otp) throw new Error("send a code first");
  await verifyOTP({ otpVerification: otp, verificationToken: code });
  otp = null;
  const missing = getChainsMissingWaasWalletAccounts();
  if (missing.includes("EVM")) await createWaasWalletAccounts({ chains: ["EVM"] });
  // the token issued at verification predates the wallet; a refresh re-issues it with the wallet as a verified credential
  await refreshAuth();
  await choose(evmAccounts()[0]);
  return currentSession();
}

/** Installed extensions and WalletConnect, EVM only, as buttons: { key, name, icon }. */
export function listWalletProviders() {
  return getAvailableWalletProvidersData()
    .filter((p) => p.chain === "EVM")
    .map((p) => ({ key: p.key, name: p.metadata.displayName, icon: p.metadata.icon }));
}

/** Connects a treasury wallet and signs Dynamic's login message; inside an existing session it links the wallet. */
export async function connectWallet(key) {
  await choose(await connectAndVerifyWithWalletProvider({ walletProviderKey: key }));
  await refreshAuth(); // the token must carry the newly verified wallet before the server will accept it as an owner
  return currentSession();
}

/** The token's claims, read without verification: the browser only shows them, the server verifies. */
function payloadOf(token) {
  try { return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return {}; }
}

/** What the dashboard needs about the login: the bearer, who, the wallet that signs, and every wallet it could pick. */
export function currentSession() {
  if (!client || !client.token) return null;
  return {
    token: client.token,
    email: payloadOf(client.token).email ?? null,
    address: active ? active.address : null,
    wallets: evmAccounts().map((w) => w.address),
  };
}

/** Makes the session's EVM wallet at `address` the one that signs, and remembers the choice. */
export async function chooseWallet(address) {
  const account = evmAccounts().find((w) => w.address.toLowerCase() === String(address).toLowerCase());
  if (!account) throw new Error(`wallet ${address} is not in this session`);
  await choose(account);
  return currentSession();
}

/** A viem WalletClient for the chosen wallet on our chain. */
export async function walletClient() {
  const primary = active;
  if (!primary) throw new Error("no wallet in this session");
  if (network) {
    await switchActiveNetwork({ networkId: network.networkId, walletAccount: primary }).catch(() => {
      throw new Error(`switch your wallet to ${network.displayName} (chain ${network.networkId}) and try again`);
    });
  }
  return createWalletClientForWalletAccount({ walletAccount: primary });
}

/** A viem PublicClient for our chain (reads and receipts). */
export function publicClient() {
  if (!network) throw new Error("PUBLIC_RPC_URL is not configured");
  return createPublicClientFromNetworkData({ networkData: network });
}

export async function signOut() {
  await logout();
  otp = null;
  active = null;
}
