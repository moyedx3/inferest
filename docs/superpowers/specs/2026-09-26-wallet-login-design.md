# Wallet login: finance leads sign in through Dynamic, vaults are managed by their owners

_Design, 2026-09-26. Approved in conversation; implementation plan follows this spec._

## Goal

A company's finance lead manages their Inferest vault (register it, create and revoke developer keys, settle) from a login that belongs to them, instead of the single operator token every admin action needs today. Login and wallets come from Dynamic: email one-time codes for a company with no on-chain wallet yet (Dynamic issues it an embedded MPC wallet), or the company's existing treasury wallet connected through Dynamic's wallet connectors (browser extensions, and WalletConnect for hardware wallets and custody consoles). Authorization stays ours and follows the money: a session may manage a vault when one of its verified wallets is that vault's creator.

Success: a judge or a customer with only an email address can open the dashboard, sign in, fund a demo wallet, deposit, create a key, make a model call, watch spend and settle, without ever seeing an operator token; a treasury that already lives in MetaMask, on a Ledger or in a custody console does the same by connecting that wallet; the operator token keeps working for us and for the scripted demos; a deployment without a Dynamic environment id behaves exactly as today.

## Decisions taken

| # | Decision | Chosen | Why |
|---|---|---|---|
| 1 | Identity provider | **Dynamic** (`@dynamic-labs-sdk/client` and `@dynamic-labs-sdk/evm`, headless) | Email, social, passkey and external-wallet login in one SDK, embedded MPC wallets on the free plan, custom EVM networks from our own chain config, and server-side verifiable JWTs |
| 2 | Who is a vault's admin | **The login whose verified wallet is the vault's creator** | Custody stays where the money is; both login paths end in a verified wallet, so one rule covers them; no user table |
| 3 | Login paths | **Email code with an embedded wallet, and "connect treasury wallet" through Dynamic's connectors** | A company with no wallet gets one; a company with a treasury wallet keeps it; a custody console such as Fireblocks connects over WalletConnect with no code specific to it |
| 4 | Session transport | **Dynamic's JWT as a bearer token, verified per request against Dynamic's JWKS** | No session store, no cookie handling, nothing to revoke on our side; tokens expire on Dynamic's schedule |
| 5 | Operator token | **Unchanged** | The keeper, the scripted demos and the settlement escape hatch stay operator-only |
| 6 | Visibility | **State is scoped to the caller** | Several companies on one deployment must not see each other's keys and spend |
| 7 | Demo funding | **A faucet route behind a config flag, for the session's own wallet** | A judge with an email address needs gas and USDC on the demo chain; it cannot exist on a real chain by accident |
| 8 | Dashboard build | **One esbuild bundle for the Dynamic wrapper**, the rest stays plain JavaScript | The SDK needs a bundler; nothing else in the dashboard does |

## 1. Session and authorization

The dashboard signs in through Dynamic and sends the resulting JWT as `Authorization: Bearer <token>` on every `/api` request. The server verifies the token itself in a new module `app/auth.ts`:

- RS256 signature against Dynamic's JWKS for our environment, `https://app.dynamicauth.com/api/v0/sdk/<environmentId>/.well-known/jwks`, fetched once at first use, cached by key id, refetched at most once per minute when a token names an unknown key id.
- `exp` against the clock; the `environment_id` claim against the configured environment id.
- The session is `{ userId: sub, email?, wallets }`, where `wallets` is every entry of `verified_credentials` with `chain === "eip155"`, lowercased and deduplicated.
- `verifyDynamicJwt(token, deps)` takes the environment id, a fetch function and a clock, so tests sign tokens with a locally generated RSA key and a fake JWKS. It never logs a token. Only `node:crypto` is used.

Current Dynamic environments issue tokens that carry only hashes of the user's credentials (`verifiedCredentialsHashes`) and no `verified_credentials` list. For those, the server resolves the wallets through Dynamic's SDK user endpoint (`GET /api/v0/sdk/<environmentId>/users` with the same bearer) and caches the answer per user and credential hash for ten minutes; the hash changes whenever the credential set changes, so a newly created or linked wallet is seen on the next token. Tokens that still carry `verified_credentials` are used as is.

A request is resolved once into one of three callers: the operator (the `x-admin-token` header, unchanged), a session (a valid bearer), or nobody. Every vault-scoped route asks one question: is the caller the operator, or does the session own this vault? The vault's owner is `vaults.customer`, the creator address the factory reported at registration. The answers are 401 with no credentials, 403 with a session that does not own the vault, and 404 for an unknown vault or key, as today.

| Route | Operator | Session |
|---|---|---|
| `POST /api/vaults` (register) | any vault the factory knows | only when the customer the factory reports is one of the session's wallets |
| `POST /api/keys`, `/api/keys/:id/weight`, `/revoke`, `/rotate` | any | own vault only |
| `POST /api/admin/settle` | any | own vault only |
| `POST /api/admin/sync`, `POST /api/admin/report` | all vaults | own vault only: the body carries `vault`, and the route syncs or reports that vault alone |
| `POST /api/admin/pending/clear` | yes | no |
| `POST /api/demo/fund` | yes (any address) | own wallets only, and only when the faucet is enabled |
| `GET /api/state` | every vault | own vaults; with no credentials, the public config and empty lists |
| `/v1/*`, `/mcp` | Inferest keys, unchanged | |

When no Dynamic environment id is configured, bearer tokens are treated as absent (login happens on Dynamic's side; the server only ever verifies), and the dashboard shows the operator form only, so local development and the tests run without a Dynamic account.

## 2. Dashboard

**Sign-in card** (replaces the wallet card's raw `window.ethereum` connect): an email field with "Send code" then a code field with "Verify"; a "Connect treasury wallet" button that lists the wallet providers Dynamic finds (installed extensions plus WalletConnect) as buttons and connects and verifies the chosen one in one step. After an email login the embedded wallet is created at once for the configured chain. A finance lead signs in once per visit: the wallet connection is itself the login for a company whose treasury already sits in a wallet, the email code is the login for a company without one, and a wallet connected inside an existing email session is linked to that user as a further verified credential (so it appears in the same token and either credential opens the same account next time), not a second login. The card then shows who is signed in (email or address), the active wallet address, and "Sign out".

**Deposit** keeps its four transactions (create vault, accept management, approve, deposit) and signs them through a viem wallet client obtained from the Dynamic wallet, then registers the vault with the session. When the faucet is enabled, a "Get demo funds" button appears above the deposit form and funds the session's wallet with gas and USDC on the demo chain.

**Vault cards** list only the session's vaults; key creation with the setup panel, rotate, revoke, settle, sync and report work as today, sent with the bearer. The operator token input moves into a collapsed "Operator" section at the bottom of the page; with the token filled in, the page shows every vault and the operator routes.

**Chains** come from our own config. `GET /api/state` exposes, beside the addresses it already returns, the chain name, native currency, block explorer and a browser-safe public RPC URL. The dashboard passes that as Dynamic's network entry for the chain id, so a local anvil fork of Arbitrum One (chain id 42161 with the RPC overridden to localhost) and any other chain a fork of this repository targets work with no dashboard change. The keeper's own RPC URL, which may carry a provider key, is never sent to the browser.

**Build.** `app/dashboard/src/dynamic.js` wraps the SDK behind these functions: `initDynamic({ environmentId, network })`, `sendEmailCode(email)`, `verifyEmailCode(code)`, `listWalletProviders()`, `connectWallet(providerKey)`, `currentSession()` (token, email, wallets, active address), `walletClient()` (a viem wallet client for the active wallet on the configured chain), `signOut()`. `npm run build:dashboard` bundles it with esbuild to `app/dashboard/dynamic.bundle.js`, git-ignored; `npm run serve` runs the build first; `app.js` imports the bundle and, when the import fails, shows "dashboard bundle missing: run npm run build:dashboard" instead of failing silently.

## 3. Server, config, data

- **Config:** `DYNAMIC_ENVIRONMENT_ID` (optional; login off when absent), `PUBLIC_RPC_URL` (optional; browser-facing RPC for the Dynamic network entry), `DEMO_FAUCET` (`1` enables the faucet; anything else disables it). `.env.example` documents all three. `config/<chain>.json` gains `name`, `nativeCurrency` and `explorer`, which the server passes through.
- **Faucet:** `POST /api/demo/fund { address }` funds the address with 1 ETH-equivalent of the native currency and 100,000 USDC through the chain's cheat methods. The anvil and Tenderly variants that `demo/lib.ts` already implements move into a shared module `app/faucet.ts`, used by the demo helpers and the route. With the flag off the route answers 404, so a real chain cannot expose it.
- **Store:** no schema change. There is no user table; the vault's customer address is the owner and the JWT is the session.
- **Errors:** authorization errors use the existing `{ error }` shape of the admin API; a bearer that fails verification is treated as absent (401), and the reason is logged without the token.

## 4. Demos, tests, docs

- **Treasury demo script:** unchanged in substance; it keeps the raw demo key and the operator token, since a script cannot answer an email code, and `demo/lib.ts` now sends the operator token on reads as well as writes.
- **Judge walkthrough:** a short page `docs/07-walkthrough.md` with the dashboard path: sign in with email, get demo funds, deposit, create a key, run a call with the snippet, watch spend, settle.
- **Agent demo:** unchanged.
- **Tests** (node:test, real HTTP server, in-memory store, fakes): `app/test/auth.test.ts` (valid token; expired; wrong environment; bad signature; unknown key id triggers one refetch and then verifies; no `eip155` credential yields an empty wallet list; malformed token); server tests for each vault-scoped route with a session (own vault 2xx, another vault 403, no credentials 401, operator unchanged), registration against a non-matching customer (403), state scoping for the three callers, the faucet (404 when off, 403 for a foreign address, 200 for an own address), and login disabled when no environment id is configured.
- **Docs:** README (sign-in, the three variables, the build step), workflow doc sections 1 and 2 (who is the admin, how a vault is registered), deck wording.

## 5. Out of scope

A Safe multisig as the treasury (needs an EIP-1271 signature or a Safe app; the natural next step), several admins per vault or transferring ownership, the agent demo signing through Dynamic, Fireblocks Flow, social login configuration beyond enabling it in Dynamic's dashboard, and the public host itself (its own task; this design needs only `PUBLIC_URL` and `PUBLIC_RPC_URL` to point at it).

## Acceptance

1. With a Dynamic environment configured, a fresh email login on the dashboard creates an embedded wallet, funds it through the faucet on the demo chain, deposits, registers the vault, creates a key, and the key's model call is metered and shown; the vault is listed only for that login.
2. A second login cannot see the first login's vault in state and gets 403 on every route naming it.
3. A treasury wallet connected through Dynamic (an injected wallet in a browser) can register a vault it created and manage it.
4. The operator token behaves exactly as before on every route, and the scripted treasury and agent demos run unchanged.
5. With no environment id configured, every existing test passes and the dashboard works with the operator token alone.
