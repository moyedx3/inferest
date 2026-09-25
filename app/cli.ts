import { loadConfig } from "./config.ts";
import { secretBox } from "./crypto.ts";
import { openStore } from "./store.ts";
import { makeChain } from "./chain.ts";
import { openRouter } from "./openrouter.ts";
import { toolGateway, x402PayingFetch, type PayingFetchFactory } from "./tools.ts";
import { syncAll, reportAll, settleVault, tick, toolBudgetFor, type KeeperDeps } from "./keeper.ts";
import { createApp } from "./server.ts";
import { createProxy } from "./proxy.ts";

const cfg = loadConfig();
const store = openStore(cfg.dbPath);
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

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case "serve": {
    const app = createApp({
      store, or, chain, gateway, params: cfg.params, adminToken: cfg.adminToken, keeper, secrets: box, proxy,
      publicConfig: { chainId: cfg.chainId, factory: cfg.factory, splitter: cfg.splitter, usdc: cfg.usdc, target: cfg.target },
    });
    app.listen(cfg.port, () => console.log(`Inferest on http://localhost:${cfg.port} (chat at /v1/chat/completions, MCP at /mcp)`));
    setInterval(() => void tick(keeper).catch((e) => keeper.log(`tick failed: ${e.message}`)), 60_000);
    break;
  }
  case "sync": await syncAll(keeper); break;
  case "report": await reportAll(keeper); break;
  case "settle":
    if (!store.vault(String(arg))) {
      console.log("unknown vault");
      process.exitCode = 1;
      break;
    }
    console.log(await settleVault(keeper, String(arg)));
    break;
  default:
    console.log("usage: node app/cli.ts serve | sync | report | settle <vault>");
    process.exitCode = 1;
}
