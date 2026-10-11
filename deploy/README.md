# Local deployment

Run one server and an optional agent with Docker Compose. The server includes
the dashboard, API, proxy and keeper. Public hosting is not configured.

## Setup

Install Docker with Compose v2. Prepare an Arbitrum fork or virtual testnet and
its Inferest contracts using the [deployment workflow](../docs/06-workflow.md).
Compose does not start Anvil or deploy contracts. The default deployment record
is `contracts/deployments/42161.json`, with `config/arbitrum-one.json` as its config.
A Monad demo runs as a second instance beside it on a fork of Monad mainnet; see
[the section below](#a-second-instance-on-a-monad-fork).

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
fork, such as the Monad fork below. Chain ID 42161 alone does not distinguish a
fork from Arbitrum mainnet, and chain ID 143 alone does not distinguish one from Monad.

## A second instance on a Monad fork

One host can run the Arbitrum instance and a Monad demo side by side. Each
instance is its own Compose project with its own database volume, env file,
image tag, port and hostname; they share only the checkout. The Monad instance
runs on a Tenderly Virtual TestNet that forks Monad mainnet with chain id 143
kept: the yield source is Aave's static USDC wrapper itself, the fork's cheat
methods are the faucet and the clock, and nothing on it is real value.
`config/monad.json` is the chain config; `contracts/deployments/monad-fork.json`
records the Inferest contracts on that fork, the fork itself, and the keeper
under `initialRoles`. The status page's Monad section has the fork's facts.

```sh
cp deploy/monad-fork.env.example .env.monad
chmod 600 .env.monad
```

Fill in the fork's admin RPC as `RPC_URL` (from the Tenderly dashboard; it is a
credential, because it accepts the cheat methods), the keeper key that matches
the record (from the founder), the instance's public origin as `PUBLIC_URL`, and
fresh `ADMIN_TOKEN` and `KEY_ENCRYPTION_KEY` values. Never reuse another
instance's encryption key or admin token. `DEMO_FAUCET=1` serves "Get demo
funds" through the cheat methods, so no faucet wallet exists; give the keeper
its gas the same way, here 10 MON:

```sh
cast rpc tenderly_setBalance '["<keeper address>"]' 0x8ac7230489e80000 --rpc-url "$RPC_URL"
```

Leave the keeper bounds empty. The provider and the paid tools cost real money
on this instance too, so keep `OPENROUTER_TOTAL_LIMIT_USD` small; the cap counts
only this instance's own keys, and two instances on one management key add up.

Put the project's settings in the shell for every `docker compose` command on
it; without them the defaults address the Arbitrum project. The image gets its
own tag so the running Arbitrum containers keep theirs.

```sh
export COMPOSE_PROJECT_NAME=inferest-monad INFEREST_IMAGE=inferest:monad SERVER_PORT=8788
export SERVER_ENV_FILE=$PWD/.env.monad CHAIN_CONFIG_FILE=$PWD/config/monad.json
export DEPLOYMENTS_FILE=$PWD/contracts/deployments/monad-fork.json
NODE_VERSION=$(cat .node-version) docker compose build server
docker compose config --quiet
docker compose up --detach --wait server
```

SQLite lives in the `inferest-monad_data` volume; back it up as in
[Data and backups](#data-and-backups) with the same settings in the shell and
a directory of its own, such as `backup-monad`.

Give the instance its own hostname at the reverse proxy and point it at the
port, for example in a Caddyfile:

```
monad.example.com {
    reverse_proxy 127.0.0.1:8788
}
```

`PUBLIC_URL` must be that origin, and the Dynamic environment's allowed origins
must include it, or the sign-in card fails its origin check; the same
environment id can serve several origins. The dashboard adds the fork to
Dynamic's network list from `PUBLIC_RPC_URL` by itself, with the network pill
reading `Monad · demo chain`; embedded wallets use the fork. A visitor's own
wallet on chain 143 has to point at the public RPC as well, or its transactions
go to Monad mainnet, as the walkthrough warns. No explorer is configured: the
free Tenderly plan has no public explorer page, so the pages show no
transaction links, and project members read transactions in the Tenderly
dashboard. A wallet's first "Get demo funds" click gives it 1 MON and
100,000 USDC. To move the clock by hand, six months here, then Report yield on
the page:

```sh
cast rpc evm_increaseTime 0xf099c0 --rpc-url "$RPC_URL"
cast rpc evm_mine --rpc-url "$RPC_URL"
```

If the fork is gone, make a new Virtual TestNet of Monad in the Tenderly
dashboard with chain id 143 and state sync off, deploy with the root README's
deploy line against its admin RPC with
`TARGET_VAULT=0xC554aFfE2f581F5E0811e0D42D484ECaC5c6B8e2` and a keeper of your
own, then replace `contracts/deployments/monad-fork.json` (`Deploy.s.sol`
writes `143.json`; copy its addresses in) and the keeper key in `.env.monad`.

For the agent profile on this instance, copy `deploy/agent.env.example` to
`.env.monad-agent` with the admin RPC as `RPC_URL` (the runner moves the clock
through it), this instance's `ADMIN_TOKEN`, a fresh wallet and
`AGENT_DEMO_DAYS=7`, then run the agent commands from
[Optional agent](#optional-agent) with `AGENT_ENV_FILE=$PWD/.env.monad-agent`
beside the settings above. The agent's first start funds its wallet through the
faucet route, and each run moves the clock a week before it reports.

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
