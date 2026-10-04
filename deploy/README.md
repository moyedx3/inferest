# Deployment

Run one server and an optional agent with Docker Compose. The server includes
the dashboard, API, proxy and keeper. Keep the server port on loopback and use
a host reverse proxy for HTTPS. The optional updater below deploys successful
`main` revisions on an existing Linux host.

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

For a shared-wallet pilot, set `PILOT_CUSTOMER_ADDRESS` to that wallet and
`KEEPER_AUTOMATIC_TRANSACTIONS=false`. The server still reconciles and syncs; reports
and settlements are manual. Set `KEEPER_MIN_BALANCE_ETH` and `KEEPER_MAX_TX_COST_ETH`
to bound the prepared gas and fee ceiling before signing. Run only one keeper and
schedule external wallet transactions separately. Unknown signed settlements keep
the vault closed and block new keeper transactions until receipt or verified operator
reconciliation. Reports lack durable pending-transaction tracking; after a report timeout,
verify its receipt and wallet nonce before another keeper write. See the README's supervised wallet pilot notes.

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

## Automatic hosted updates

The host checks GitHub every five minutes. It fetches `main`, requires successful
push CI for that exact revision, and rebuilds only when application runtime inputs
change. Documentation and tests alone do not restart the server. GitHub errors,
incomplete CI and failed CI leave the current service running. This uses the public
GitHub API; no deployment key or server credential goes into GitHub.

Use a dedicated, clean checkout with an HTTPS GitHub remote, Docker Compose,
Python 3 and a systemd user session. First deploy and verify a known-good image
with the `org.opencontainers.image.revision` label set to its full Git SHA. Keep
all operational files ignored, retain the existing Compose project and database
volume, and keep exactly one server process. The updater recreates only `server`.

Install from a reviewed, merged checkout on the host:

```sh
install -d -m 700 ~/.local/lib/inferest ~/.config/inferest ~/.local/state/inferest-deploy
install -m 600 deploy/update.py ~/.local/lib/inferest/update.py
```

Create `~/.config/inferest/deploy.json` with mode `600`. Use absolute paths and your
existing project name and Compose environment file. For example:

```json
{
  "root": "/home/user/dev/inferest",
  "githubRepo": "moyedx3/inferest",
  "composeEnv": "/home/user/dev/inferest/private/compose.production.env",
  "project": "inferest-production",
  "stateDir": "/home/user/.local/state/inferest-deploy",
  "healthUrl": "http://127.0.0.1:8787"
}
```

The Compose environment file selects `SERVER_ENV_FILE`, `CHAIN_CONFIG_FILE`,
`DEPLOYMENTS_FILE` and `SERVER_PORT` for the existing installation. Keep credentials
in the selected server environment file. Do not print rendered Compose configuration.

```sh
python3 ~/.local/lib/inferest/update.py --config ~/.config/inferest/deploy.json init
python3 ~/.local/lib/inferest/update.py --config ~/.config/inferest/deploy.json run
install -d -m 700 ~/.config/systemd/user
install -m 600 deploy/inferest-deploy.service deploy/inferest-deploy.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now inferest-deploy.timer
```

Enable user lingering once, if necessary, so the timer runs after logout:
`sudo loginctl enable-linger "$USER"`. Check status with
`systemctl --user list-timers inferest-deploy.timer` and
`journalctl --user -u inferest-deploy.service -n 30`.
Inspect the deployed revision and pending recovery with
`python3 ~/.local/lib/inferest/update.py --config ~/.config/inferest/deploy.json status`.

The updater records the running image, reviewed Compose configuration and private
input fingerprints. It stops on unexpected drift. It builds an image tagged and
labeled with the source SHA in an isolated checkout, then checks that `main` has
not changed before switching. Compose health plus read-only HTTP checks must pass.
Persistent state is written atomically before the switch so the next run can
recover an interrupted deployment. A failed candidate rolls back to the previous
image; a failed rollback leaves recovery pending and stops further deployments.
Retain the previous images. Never prune images or volumes during deployment.
The host checkout stays at its operator-reviewed revision; the fetched `main` commit
and the updater's saved revision identify the deployed source. The image override
is supplied by the updater, so use it for updates instead of a bare Compose `up`.

Database and configuration changes need operator review. Changes to `app/store.ts`,
`agent/log.ts` or `compose.yaml` block automatic deployment because image rollback
cannot undo a SQLite migration or safely change the host's mounts and settings.
After reviewing and manually deploying such a change, rebaseline with `init --replace`.
Keep a database backup and the matching encryption key; the updater does not restore
an old database automatically because that could erase newer usage accounting.

Inspect failures before retrying the same revision with `run --retry`.
Repeated builds of a revision that already failed are also suppressed. To stop
polling, use `systemctl --user disable --now inferest-deploy.timer`; an already
running service finishes its current operation. Update the installed script and
unit files explicitly after reviewing deployment-tool changes. Application updates
do not replace the updater itself or enable the agent, paid tools or contract deployment.

Run the deployment tests locally with:

```sh
python3 -m unittest discover -s deploy -p '*_test.py'
```
