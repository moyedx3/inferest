import { readFileSync } from "node:fs";
import { HACKATHON_PARAMS, type Params } from "../engine/ledger.ts";

type Hex = `0x${string}`;

export type Config = {
  rpcUrl: string; chainId: number; usdc: Hex; target: Hex; factory: Hex; splitter: Hex;
  keeperKey: Hex; openRouterKey: string; orthogonalKey: string; toolWalletKey?: Hex;
  adminToken: string; dbPath: string; port: number; params: Params;
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
  const railFee = Number(env.RAIL_FEE ?? "0");
  if (!(railFee >= 0 && railFee < 1)) throw new Error("RAIL_FEE must be in [0, 1)");
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
    dbPath: env.DB_PATH ?? "inferest.db",
    port: Number(env.PORT ?? 8787),
    params: { ...HACKATHON_PARAMS, railFee },
  };
}
