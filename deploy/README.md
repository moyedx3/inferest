# Local deployment

Run one server and an optional agent with Docker Compose. The server includes
the dashboard, API, proxy and keeper. Public hosting is not configured.

## Setup

Install Docker with Compose v2. Prepare an Arbitrum fork or virtual testnet and
its Inferest contracts using the [deployment workflow](../docs/06-workflow.md).
Compose does not start Anvil or deploy contracts. The default deployment record
is `contracts/deployments/42161.json`, with `config/arbitrum-one.json` as its config.

From the repository root:

```sh
cp deploy/server.env.example .env.server
chmod 600 .env.server
```

Fill in the keeper key matching the deployment, OpenRouter management key and
funded provider balance. Generate independent `ADMIN_TOKEN` and
`KEY_ENCRYPTION_KEY` values with `openssl rand -hex 32`. Keep the encryption key
stable across restarts. Paid tools also need an Orthogonal key and a funded Base
USDC wallet. Dynamic login is optional; operator-token access works without it.
Never commit credentials. Provider calls can cost real money even on a fork.
For a small demo, set `OPENROUTER_TOTAL_LIMIT_USD=0.9`. This bounds cumulative
provider credit across the database's registered model keys, including past usage.
Settlement does not reset it. Keep one keeper process and preserve the database;
keys outside this registry and paid tools are not covered. Provider billing delays
or in-flight calls can exceed provider limits, so retain spending headroom.

```sh
NODE_VERSION=$(cat .node-version) docker compose build server
docker compose config --quiet
docker compose up --detach --wait server
```

Open <http://localhost:8787>. The port is bound to loopback only. Health checks
verify the Home page responds; they do not verify contracts, providers or login.
Use `config --quiet` to avoid printing resolved secrets.

Compose supplies the container's database and config paths. Override host paths
with `SERVER_ENV_FILE`, `CHAIN_CONFIG_FILE` and `DEPLOYMENTS_FILE`; use absolute
paths. Config and deployment records are mounted read-only and must exist.
`SERVER_PORT` changes the host port; update `PUBLIC_URL` to match.

## RPC endpoints

| Caller | Local fork endpoint |
| --- | --- |
| Container (`RPC_URL`) | `http://host.docker.internal:8545` |
| Browser (`PUBLIC_RPC_URL`) | `http://localhost:8545` |
| Agent to server (set by Compose) | `http://server:8787` |

On Linux, Anvil must listen on an interface reachable from Docker, for example
with `--host 0.0.0.0`; restrict access with the host firewall. For a virtual testnet,
use its operator RPC in `RPC_URL` and a browser-safe endpoint in `PUBLIC_RPC_URL`.
Keep `DEMO_FAUCET=0` and `AGENT_DEMO_DAYS=0` unless using a verified disposable
fork. Chain ID 42161 alone does not distinguish a fork from Arbitrum mainnet.

## Optional agent

```sh
cp deploy/agent.env.example .env.agent
chmod 600 .env.agent
```

Fill in its dedicated wallet, RPC and the server's `ADMIN_TOKEN`. It receives no
keeper, provider-management or encryption key, but its API token is still
operator-wide. Override the file path with `AGENT_ENV_FILE` if needed.

```sh
docker compose --profile agent up --detach --wait
docker compose logs --tail 50 agent
```

The agent shares SQLite and can deposit funds, rotate keys and call paid providers.
Keep exactly one server and one agent per chain state and wallets, including any
native processes. The server restarts automatically; the agent does not because
recovery remains incomplete. Reconcile wallet, vault and database state before
restarting a failed agent. See the [runner safety review](../docs/09-runner-safety-review.md)
before using real funds.

## Data and backups

SQLite lives under `/data` in the `inferest_data` volume. `docker compose down`
preserves it; `down --volumes` deletes it. Stop both writers before backing up,
then copy the whole directory, including SQLite WAL files:

```sh
docker compose --profile agent stop agent server
mkdir -m 700 backup
docker compose cp server:/data/. ./backup/
```

Securely retain the matching encryption key, wallet credentials, chain config
and deployment record. To restore, stop both services and restore `/data` with
ownership writable by UID 1000. Supply the matching encryption key and reconcile
any differences between the backup and current chain state before restarting.

## Verification

```sh
make docker-build
node deploy/smoke.mjs inferest:local
```

The smoke test uses temporary synthetic configuration, checks HTTP access and
SQLite persistence after container recreation, then removes its test resources.
It never starts the agent or calls chain/model providers. CI runs it alongside
Node checks and contract unit tests. Fork tests require manual dispatch on `main`
with `fork_tests` enabled and the `ARBITRUM_RPC_URL` repository secret.

For native setup and commands, see the [root README](../README.md).
