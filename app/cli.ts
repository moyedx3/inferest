import { loadConfig } from "./config.ts";
import { secretBox } from "./crypto.ts";
import { openStore } from "./store.ts";
import { makeChain } from "./chain.ts";
import { openRouter } from "./openrouter.ts";
import { toolGateway, x402PayingFetch, type PayingFetchFactory } from "./tools.ts";
import { syncAll, reportAll, settleVault, tick, toolBudgetFor, type KeeperDeps } from "./keeper.ts";
import { createApp } from "./server.ts";
import { createProxy } from "./proxy.ts";
import { settleThroughServer, describeSettle } from "./remote.ts";
import { createAuth } from "./auth.ts";

const cfg = loadConfig();
const store = openStore(cfg.dbPath, { log: (m) => console.log(new Date().toISOString(), m) });
const chain = makeChain(cfg);
const or = openRouter(cfg.openRouterKey);
const box = secretBox(cfg.keyEncryptionKey);
const keeper: KeeperDeps = {
  chain, store, or, params: cfg.params, decrypt: box.decrypt,
  log: (m) => console.log(new Date().toISOString(), m),
};
const noWallet: PayingFetchFactory = () => { throw new Error("TOOL_WALLET_PRIVATE_KEY is not set"); };
const gateway = toolGateway({
  orthogonalKey: cfg.orthogonalKey,
  fetchFn: fetch,
  makePayingFetch: cfg.toolWalletKey ? x402PayingFetch(cfg.toolWalletKey) : noWallet,
  budgetUsd: (h) => toolBudgetFor(store, cfg.params, h),
  record: (h, api, path, usd) => store.recordToolCall(h, api, path, usd),
});
const proxy = createProxy({
  store, params: cfg.params, decrypt: box.decrypt, fetchFn: fetch, dashboardUrl: cfg.publicUrl, log: keeper.log,
});
keeper.drain = proxy.drain; // settlement waits for in-flight metering

const auth = cfg.dynamicEnvironmentId ? createAuth({ environmentId: cfg.dynamicEnvironmentId }) : undefined;

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case "serve": {
    const app = createApp({
      store, or, chain, gateway, params: cfg.params, adminToken: cfg.adminToken, keeper, secrets: box, proxy, auth,
      publicConfig: {
        chainId: cfg.chainId, factory: cfg.factory, splitter: cfg.splitter, usdc: cfg.usdc, target: cfg.target, publicUrl: cfg.publicUrl,
        dynamicEnvironmentId: cfg.dynamicEnvironmentId ?? null, publicRpcUrl: cfg.publicRpcUrl ?? null, chainName: cfg.chainName,
        nativeCurrency: cfg.nativeCurrency, explorer: cfg.explorer ?? null, demoFaucet: cfg.demoFaucet,
      },
    });
    app.listen(cfg.port, () => console.log(`Inferest on http://localhost:${cfg.port} (chat at /v1/chat/completions, MCP at /mcp, login ${auth ? "on" : "off"})`));
    const runTick = () => void tick(keeper).catch((e) => keeper.log(`tick failed: ${e.message}`));
    runTick(); // sync now, so a fresh server does not refuse every vault as stale for its first minute
    setInterval(runTick, 60_000);
    break;
  }
  case "sync": await syncAll(keeper); break;
  case "report": await reportAll(keeper); break;
  case "settle": {
    if (!store.vault(String(arg))) {
      console.log("unknown vault");
      process.exitCode = 1;
      break;
    }
    try {
      const remote = await settleThroughServer(cfg.publicUrl, cfg.adminToken, String(arg));
      if (remote) {
        console.log(`settled through the server at ${cfg.publicUrl}: ${describeSettle(remote)}`);
      } else {
        console.log(`no server at ${cfg.publicUrl}, settling in this process`);
        const result = await settleVault(keeper, String(arg));
        console.log(describeSettle(result));
      }
    } catch (e) {
      console.error(`settle failed: ${(e as Error).message}`);
      process.exitCode = 1;
    }
    break;
  }
  default:
    console.log("usage: node app/cli.ts serve | sync | report | settle <vault>");
    process.exitCode = 1;
}
