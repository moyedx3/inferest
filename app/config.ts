import { readFileSync } from "node:fs";
import { HACKATHON_PARAMS, type Params } from "../engine/ledger.ts";

type Hex = `0x${string}`;

export type Config = {
  rpcUrl: string; chainId: number; usdc: Hex; target: Hex; factory: Hex; splitter: Hex;
  keeperKey: Hex; openRouterKey: string; orthogonalKey: string; toolWalletKey?: Hex;
  openRouterTotalLimitUsd?: number;
  adminToken: string; keyEncryptionKey: string; publicUrl: string; dbPath: string; port: number; params: Params;
  /** Allowlisted ERC-4626 yield sources, the first one being `target`, the default the Treasury page creates over. */
  targets: { address: Hex; name: string }[];
  /** Dynamic environment whose logins the server accepts; login is off when unset. */
  dynamicEnvironmentId?: string;
  /** Browser-facing RPC for the dashboard's wallet; never the keeper's rpcUrl. */
  publicRpcUrl?: string;
  /** Whether POST /api/demo/fund exists (DEMO_FAUCET=1). */
  demoFaucet: boolean;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  explorer?: string;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`missing env ${k}`);
    return v;
  };
  const chain = JSON.parse(readFileSync(env.CHAIN_CONFIG ?? "config/arbitrum-one.json", "utf8"));
  const dep = JSON.parse(readFileSync(need("DEPLOYMENTS"), "utf8"));
  if (Number(dep.chainId) !== Number(chain.chainId)) {
    throw new Error(`chain id mismatch: deployments ${dep.chainId} vs chain config ${chain.chainId}`);
  }
  if (String(dep.target).toLowerCase() !== String(chain.target).toLowerCase()) {
    throw new Error(`target mismatch: deployments ${dep.target} vs chain config ${chain.target}`);
  }
  const targets: { address: Hex; name: string }[] = Array.isArray(chain.targets) && chain.targets.length
    ? chain.targets.map((t: { address: string; name?: string }) => ({ address: t.address as Hex, name: String(t.name ?? "yield source") }))
    : [{ address: chain.target as Hex, name: String(chain.targetName ?? "yield source") }];
  if (targets[0].address.toLowerCase() !== String(chain.target).toLowerCase()) throw new Error("the first of targets must be target");
  const allowlisted = new Set((Array.isArray(dep.targets) ? dep.targets : [dep.target]).map((a: string) => String(a).toLowerCase()));
  for (const t of targets) if (!allowlisted.has(t.address.toLowerCase())) throw new Error(`target ${t.address} is not allowlisted in the deployment`);
  const railFee = Number(env.RAIL_FEE ?? "0");
  if (!(railFee >= 0 && railFee < 1)) throw new Error("RAIL_FEE must be in [0, 1)");
  const keyEncryptionKey = need("KEY_ENCRYPTION_KEY");
  if (!/^[0-9a-f]{64}$/i.test(keyEncryptionKey)) throw new Error("KEY_ENCRYPTION_KEY must be 32 bytes as 64 hex characters");
  const adminToken = need("ADMIN_TOKEN");
  if (adminToken.length < 32) console.warn("ADMIN_TOKEN is under 32 characters; use openssl rand -hex 32");
  const port = Number(env.PORT ?? 8787);
  const openRouterTotalLimitUsd = env.OPENROUTER_TOTAL_LIMIT_USD?.trim()
    ? Number(env.OPENROUTER_TOTAL_LIMIT_USD) : undefined;
  if (openRouterTotalLimitUsd !== undefined && (!Number.isFinite(openRouterTotalLimitUsd) || openRouterTotalLimitUsd < 0)) {
    throw new Error("OPENROUTER_TOTAL_LIMIT_USD must be finite and nonnegative");
  }
  return {
    rpcUrl: need("RPC_URL"),
    chainId: Number(dep.chainId),
    usdc: chain.usdc,
    target: dep.target,
    factory: dep.factory,
    splitter: dep.splitter,
    targets,
    keeperKey: need("KEEPER_PRIVATE_KEY") as Hex,
    openRouterKey: need("OPENROUTER_MANAGEMENT_KEY"),
    openRouterTotalLimitUsd,
    orthogonalKey: env.ORTHOGONAL_API_KEY ?? "",
    toolWalletKey: env.TOOL_WALLET_PRIVATE_KEY ? (env.TOOL_WALLET_PRIVATE_KEY as Hex) : undefined,
    adminToken,
    keyEncryptionKey,
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    dbPath: env.DB_PATH ?? "inferest.db",
    port,
    params: { ...HACKATHON_PARAMS, railFee },
    dynamicEnvironmentId: env.DYNAMIC_ENVIRONMENT_ID || undefined,
    publicRpcUrl: env.PUBLIC_RPC_URL ? env.PUBLIC_RPC_URL.replace(/\/+$/, "") : undefined,
    demoFaucet: env.DEMO_FAUCET === "1",
    chainName: String(chain.name ?? `chain ${dep.chainId}`),
    nativeCurrency: chain.nativeCurrency ?? { name: "Ether", symbol: "ETH", decimals: 18 },
    explorer: chain.explorer ? String(chain.explorer) : undefined,
  };
}
