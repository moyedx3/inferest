import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), "inferest-smoke-"));
const project = `inferest-smoke-${process.pid}-${Date.now()}`;
const image = process.argv[2] ?? "inferest:local";
const address = (digit) => `0x${digit.repeat(40)}`;
const config = { chainId: 42161, name: "Smoke fixture", usdc: address("1"), target: address("2") };
const deployment = { chainId: 42161, target: config.target, factory: address("3"), splitter: address("4") };
const env = {
  ...process.env,
  INFEREST_IMAGE: image,
  SERVER_ENV_FILE: join(fixture, "server.env"),
  AGENT_ENV_FILE: join(fixture, "agent.env"),
  CHAIN_CONFIG_FILE: join(fixture, "chain.json"),
  DEPLOYMENTS_FILE: join(fixture, "deployment.json"),
  SERVER_PORT: "0",
};
const files = ["-f", join(root, "compose.yaml")];
const docker = (...args) => execFileSync("docker", args, { cwd: root, env, encoding: "utf8", timeout: 120_000 });
const compose = (...args) => docker("compose", "--env-file", "/dev/null", "--project-name", project, ...files, ...args);
let container;
const run = (code) => docker("exec", container, "node", "--input-type=module", "-e", code);

try {
  writeFileSync(env.CHAIN_CONFIG_FILE, JSON.stringify(config));
  writeFileSync(env.DEPLOYMENTS_FILE, JSON.stringify(deployment));
  writeFileSync(env.SERVER_ENV_FILE, [
    "RPC_URL=http://127.0.0.1:1",
    `KEEPER_PRIVATE_KEY=0x${"1".repeat(64)}`,
    "OPENROUTER_MANAGEMENT_KEY=synthetic-smoke-key",
    `KEY_ENCRYPTION_KEY=${"2".repeat(64)}`,
    `ADMIN_TOKEN=${"smoke-only-".repeat(4)}`,
    "PUBLIC_URL=http://localhost:8787",
    "PUBLIC_RPC_URL=http://localhost:8545",
    "DEMO_FAUCET=0",
  ].join("\n"), { mode: 0o600 });
  writeFileSync(env.AGENT_ENV_FILE, "", { mode: 0o600 });
  // an empty store and loopback RPC keep these requests independent of providers.
  compose("config", "--quiet");
  const full = JSON.parse(compose("--profile", "agent", "config", "--format", "json"));
  assert.equal(full.services.server.restart, "unless-stopped");
  assert.equal(full.services.agent.restart, "no");
  assert.equal(full.services.agent.environment.API_URL, "http://server:8787");
  assert.equal(full.services.server.ports[0].host_ip, "127.0.0.1");
  for (const service of Object.values(full.services)) {
    const binds = service.volumes.filter((volume) => volume.type === "bind");
    assert.equal(binds.length, 2);
    for (const volume of binds) {
      assert.equal(volume.read_only, true);
      assert.equal(volume.bind.create_host_path ?? false, false);
    }
  }
  const record = env.DEPLOYMENTS_FILE;
  env.DEPLOYMENTS_FILE = join(fixture, "missing.json");
  assert.throws(() => compose("up", "--detach", "--no-build", "server"), /bind source path does not exist/);
  assert.equal(existsSync(env.DEPLOYMENTS_FILE), false);
  env.DEPLOYMENTS_FILE = record;
  compose("up", "--detach", "--no-build", "--wait", "--wait-timeout", "60", "server");
  container = compose("ps", "--quiet", "server").trim();
  assert.ok(container);
  assert.equal(docker("inspect", "--format", "{{.Config.User}}", container).trim(), "node");
  assert.equal(run("console.log(process.versions.node)").trim(), readFileSync(join(root, ".node-version"), "utf8").trim());
  run(`
    import assert from "node:assert/strict";
    import { readdirSync } from "node:fs";
    assert.notEqual(process.getuid(), 0);
    for (const path of ["/", "/treasury", "/agents"]) {
      const response = await fetch("http://localhost:8787" + path);
      assert.equal(response.status, 200, path);
      assert.match(await response.text(), /<!doctype html>/i);
    }
    const bundle = await fetch("http://localhost:8787/dynamic.bundle.js");
    assert.equal(bundle.status, 200);
    assert.ok((await bundle.text()).length > 1000);
    const response = await fetch("http://localhost:8787/api/state");
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.config.factory, ${JSON.stringify(deployment.factory)});
    assert.equal(state.config.chainId, 42161);
    assert.equal(state.config.publicRpcUrl, "http://localhost:8545");
    assert.deepEqual(state.vaults, []);
    const denied = await fetch("http://localhost:8787/api/vaults", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(denied.status, 401);
    assert.deepEqual(readdirSync("/opt/inferest").sort(), ["agent", "app", "engine", "node_modules", "package-lock.json", "package.json"]);
    for (const directory of ["app", "agent", "engine"]) {
      for (const path of readdirSync(directory, { recursive: true })) {
        assert.ok(!/(^|\\/)(\\.env[^/]*|private|deployments|.*\\.db(?:-.*)?)(\\/|$)/.test(path), path);
      }
    }
    const { openAgentLog } = await import("./agent/log.ts");
    const log = openAgentLog(process.env.DB_PATH);
    log.setMeta("packaging-smoke", "persisted");
    log.close();
  `);
  const previous = container;
  compose("up", "--detach", "--no-build", "--force-recreate", "--wait", "--wait-timeout", "60", "server");
  container = compose("ps", "--quiet", "server").trim();
  assert.notEqual(container, previous);
  const endpoint = compose("port", "server", "8787").trim();
  assert.match(endpoint, /^127\.0\.0\.1:\d+$/);
  const home = await fetch(`http://${endpoint}/`, { signal: AbortSignal.timeout(5000) });
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<!doctype html>/i);
  run(`
    import assert from "node:assert/strict";
    import { openAgentLog } from "./agent/log.ts";
    const log = openAgentLog(process.env.DB_PATH);
    assert.equal(log.getMeta("packaging-smoke"), "persisted");
    log.close();
  `);
  console.log("Container smoke passed: pages, bundle, config, auth, non-root, image exclusions, and SQLite persistence.");
} catch (error) {
  try { process.stderr.write(compose("logs", "--no-color", "server")); } catch {}
  throw error;
} finally {
  try { compose("down", "--volumes", "--timeout", "10"); }
  finally { rmSync(fixture, { recursive: true, force: true }); }
}
