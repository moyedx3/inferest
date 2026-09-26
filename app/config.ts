import { readFileSync } from "node:fs";
import { HACKATHON_PARAMS, type Params } from "../engine/ledger.ts";

type Hex = `0x${string}`;

export type Config = {
  rpcUrl: string; chainId: number; usdc: Hex; target: Hex; factory: Hex; splitter: Hex;
  keeperKey: Hex; openRouterKey: string; orthogonalKey: string; toolWalletKey?: Hex;
  adminToken: string; keyEncryptionKey: string; publicUrl: string; dbPath: string; port: number; params: Params;
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
  const railFee = Number(env.RAIL_FEE ?? "0");
  if (!(railFee >= 0 && railFee < 1)) throw new Error("RAIL_FEE must be in [0, 1)");
  const keyEncryptionKey = need("KEY_ENCRYPTION_KEY");
  if (!/^[0-9a-f]{64}$/i.test(keyEncryptionKey)) throw new Error("KEY_ENCRYPTION_KEY must be 32 bytes as 64 hex characters");
  const port = Number(env.PORT ?? 8787);
  return {
    rpcUrl: need("RPC_URL"),
    chainId: Number(dep.chainId),
    usdc: chain.usdc,
    target: dep.target,
    factory: dep.factory,
    splitter: dep.splitter,
    keeperKey: need("KEEPER_PRIVATE_KEY") as Hex,
    openRouterKey: need("OPENROUTER_MANAGEMENT_KEY"),
    orthogonalKey: env.ORTHOGONAL_API_KEY ?? "",
    toolWalletKey: env.TOOL_WALLET_PRIVATE_KEY ? (env.TOOL_WALLET_PRIVATE_KEY as Hex) : undefined,
    adminToken: need("ADMIN_TOKEN"),
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
