# Inference proxy: Inferest keys in front of OpenRouter

_Design, 2026-09-25. Approved in conversation; implementation plan follows this spec._

## Goal

Developers and agents use **Inferest-issued API keys** (`sk-inf-...`) instead of OpenRouter keys. Requests on an Inferest key go to an endpoint on the Inferest server, which checks the key's remaining yield budget, forwards the request to OpenRouter with the customer's company key, streams the answer back, and records the cost against the key. Admins get per-key budgets, instant revocation and rotation, without one OpenRouter key per developer.

Hard rule carried over from the build: **no key can ever spend past the company's booked yield.** Principal never moves.

Success: the treasury and agent demos run unchanged except that the keys are ours; a developer's existing OpenAI-compatible client works by changing only the base URL and the key; the same key authenticates to the MCP tools endpoint.

## Decisions taken

| # | Decision | Chosen | Why |
|---|---|---|---|
| 1 | OpenRouter behind the proxy | **One OpenRouter key per company vault**, its limit kept by the keeper at the company's booked credit | Real-time per-developer budgets in the proxy, and a hard backstop on OpenRouter so a proxy bug cannot spend past yield |
| 2 | Request formats | **OpenAI-compatible chat completions only** (`POST /v1/chat/completions`), plus `GET /v1/models` relayed for SDKs that list models | Covers curl, the OpenAI SDK, the Vercel AI SDK, IDEs, OpenClaw and Hermes; one metering path |
| 3 | Budget check | **Local check before, meter after** | The check is a store read, microseconds; one in-flight request may overshoot by its own cost, bounded by `max_tokens` and the model price, and the OpenRouter backstop caps the company total |
| 4 | Loss or unreported drop in yield | **Freeze in both layers** | The proxy refuses the vault's keys and the keeper pins the company key's limit to its current usage until the next report |
| 5 | Who manages keys | **Our admin token**, as today | Wallet login for company admins is an independent follow-up spec |
| 6 | Developer-facing setup | **In scope**: a setup panel with the secret shown once and copyable snippets, plus revoke and rotate per key | Needed the moment keys stop being OpenRouter keys |
| 7 | Hosting | **Inside the existing server process** | One process, one database, one deploy; a separate service adds nothing at this scale |

## 1. Architecture and request flow

A developer's client sends an OpenAI-format request to `POST /v1/chat/completions` on the Inferest server with `Authorization: Bearer sk-inf-...`. The server:

1. Hashes the bearer, looks up the Inferest key, and rejects an unknown or revoked key with 401.
2. Computes the key's remaining budget from the store (booked yield in the Splitter, weights, this period's metered spend) and rejects with 402 when nothing is left or the vault is frozen.
3. Forwards the request body to OpenRouter unchanged except for two things: the company vault's OpenRouter key replaces the bearer, and `usage.include` is set so the response carries the cost. Streaming and non-streaming both pass through byte for byte.
4. Reads the cost from the response (the final event of a stream, the `usage` object otherwise) and records one `model_calls` row against the key: model, cost, OpenRouter generation id, period.

OpenRouter still holds one key per company vault; the keeper keeps that key's limit at the company's remaining credit, so a proxy bug cannot spend past yield. The MCP endpoint keeps working with the same Inferest key. Per-developer attribution comes from our rows; OpenRouter only sees the company key.

New module: `app/proxy.ts` (route handlers, upstream forwarding, stream relay, cost capture). `app/server.ts` mounts it. `app/openrouter.ts` gains the calls the design needs (generation lookup; per-company key creation, limit and deletion already exist as `createKey`, `setLimit`, and a new `deleteKey`).

## 2. Data model

Schema version 3, migrated on open (additive: new table, new columns; existing rows from demos are disposable).

- **`keys`** becomes the Inferest key table.
  - `id TEXT PRIMARY KEY` (random, ours; replaces the OpenRouter hash), `vault`, `name`, `weight`, `secret_sha256` (of the `sk-inf-...` secret, shown once), `created_at INTEGER`, `revoked_at INTEGER NULL`.
  - `baseline` and `usage_total` (OpenRouter cumulative usage) are removed; spend is our own per-period rows.
- **`model_calls`**: `id INTEGER PRIMARY KEY`, `key_id`, `vault`, `period`, `model`, `cost_usd REAL NULL`, `generation_id TEXT UNIQUE`, `status TEXT` (`recorded` or `pending`), `at INTEGER`. The model counterpart of `tool_calls`.
- **`vaults`** gains `or_key_hash TEXT`, `or_key_secret TEXT` (encrypted; see section 5) and `settling INTEGER NOT NULL DEFAULT 0` (set while a settlement is in progress so the proxy refuses new requests; see section 3). Registering a vault creates that key on OpenRouter with limit 0. Deleting a vault (not a route today) would delete it.
- **`pending_settlements.baselines`** holds a per-key spend snapshot (`{ keyId, spentUsd }[]`) instead of OpenRouter usage totals; `startNewPeriod` is a period bump only.
- **`tool_calls.key_hash`** is renamed `key_id` for consistency.

Per-period spend for a key is `sum(model_calls.cost_usd where status = recorded) + sum(tool_calls.price)` for the vault's current period. Pending model calls count as zero until resolved.

Rotating a key replaces `secret_sha256` on the same row, so budget and history stay with the developer. Revoking sets `revoked_at`; the row and its history remain for settlement and the dashboard.

Store methods added: `addKey({ id, vault, name, weight, secretSha256 })`, `rotateKey(id, secretSha256)`, `revokeKey(id)`, `keyById`, `keyBySecret` (unchanged), `recordModelCall({ keyId, model, costUsd, generationId })`, `recordPendingModelCall({ keyId, model, generationId })`, `resolveModelCall(generationId, costUsd)`, `listPendingModelCalls()`, `spendForKey(id)` and `spendForVault(vault)` for the current period, `setVaultOpenRouterKey(vault, hash, encryptedSecret)`.

## 3. Budget math and the keeper

`app/limits.ts` keeps its formula; only its inputs change.

- **Per key:** `credit_i = yieldInSplitter × (1 − railFee) × weight_i / Σ weights`; `spent_i` = this period's recorded model cost plus tool spend; `remaining_i = max(credit_i − spent_i, 0)`, with the existing proportional scaling so the sum of remaining never exceeds the pool. Revoked keys keep their spend in the sums and get no credit (weight treated as 0).
- **Per company:** each minute the keeper reads the company OpenRouter key's cumulative usage and sets its limit to `usageTotal_OR + Σ remaining_i`. That is the backstop in OpenRouter's cumulative terms. One read and one write per company per minute.
- **Freeze:** on a pending loss the proxy refuses every key of that vault with 402, and the keeper pins the company key's limit to its current usage. Both release on the next report.
- **Settlement:** the freeze step marks the vault as settling in the store (`vaults.settling = 1`) so the proxy refuses new requests for it, waits for in-flight calls to finish metering (bounded, default ten seconds), then reads spend. Usage for `settle` is `Σ recorded model cost / (1 − railFee) + Σ tool spend` for the period. The persisted settlement flow (pending record before broadcast, reconciliation, retry within the month, escape hatch) is unchanged. After settlement the flag clears and the period increments.
- **Cross-check:** once a day the keeper compares the company key's cumulative usage on OpenRouter with the sum of recorded model costs since the vault was registered and logs the drift with the vault id. It corrects nothing; it is the alarm for lost metering.

Overshoot bounds: one in-flight request per key beyond its remaining budget, and one keeper tick of lag on the company backstop.

## 4. Metering

- **Normal path.** OpenRouter puts `usage.cost` in the response when `usage: { include: true }` is in the request. Non-streaming: read from the relayed JSON body. Streaming: relay every SSE event untouched and parse the final event that carries `usage`; write the row as that event passes through.
- **Idempotency.** `model_calls.generation_id` is unique, so recording can be retried without double counting.
- **Client gone early.** If the developer's client disconnects mid-stream, the proxy keeps reading OpenRouter's stream to the end so the usage event still arrives (OpenRouter bills the whole generation regardless). If the upstream connection fails before usage arrives but a generation id is known, the proxy writes a `pending` row.
- **Pending rows.** Every keeper tick resolves pending rows through OpenRouter's generation lookup (`GET /api/v1/generation?id=...`, which returns `total_cost`) and marks them `recorded`. A row unresolved after a day is logged for an operator.
- **Budget during lag.** Spend counts as soon as the row exists, so a key's remaining budget is current within one request.

## 5. Errors and security

- **Authentication.** Missing, unknown or revoked bearer: 401 in OpenAI error shape (`{ "error": { "message", "type": "authentication_error", "code": 401 } }`). Secrets are compared by hash, as the MCP endpoint does today.
- **Budget.** Exhausted or frozen: 402 with `type: "insufficient_quota"`, a message naming the remaining budget in dollars and the dashboard URL. 402 is non-retryable for clients.
- **Upstream errors.** An OpenRouter 4xx or 5xx is relayed with its status and body. Two rewrites: OpenRouter's "key limit exceeded" (the backstop fired before our sync caught up) becomes our 402; a network failure to OpenRouter becomes 502 with a short message.
- **Request handling.** Only `POST /v1/chat/completions` and `GET /v1/models`. Bodies capped at 4 MB. The body is forwarded as received apart from `usage.include`; the model is not rewritten. Response headers that identify OpenRouter are dropped; content type, transfer encoding and cache headers pass through.
- **Company OpenRouter key.** Stored encrypted (AES-256-GCM) with `KEY_ENCRYPTION_KEY` from the environment; decrypted in memory only when forwarding; never returned by any route. The server refuses to start without the variable.
- **Revocation.** Immediate: the next request on a revoked key gets 401. Nothing on OpenRouter changes.
- **Admin routes** stay behind the admin token: `POST /api/keys` (create, returns the secret once), `POST /api/keys/:id/revoke`, `POST /api/keys/:id/rotate` (returns the new secret once), `POST /api/keys/:id/weight`, plus the existing vault and keeper routes.
- **Logging.** One line per call: key id, model, cost, duration, status. Never the prompt, never a secret.

## 6. Dashboard

- **Key creation** opens a panel (replacing the browser alert) with the secret shown once, a copy button, and tabs of ready-to-paste snippets with the secret filled in: curl, OpenAI SDK (Python and Node), Vercel AI SDK, agent config (`OPENROUTER_API_KEY` and `OPENROUTER_BASE_URL` pointing at the Inferest server, which is how OpenClaw and Hermes take a custom endpoint), and the MCP tools URL with the same key as bearer. The panel states the base URL, that model ids are OpenRouter's, and that a 402 means the key's yield budget is used up.
- **Per key** the vault table gains revoke and rotate buttons. Rotate opens the same panel with the new secret. Revoked keys stay listed, greyed, with their spend.
- **Per vault** the card shows the company OpenRouter backstop limit next to the yield figure.
- **`GET /setup`** renders the same snippets with a placeholder key for developers who lost the tab.

## 7. Demos, tests, migration

- `demo/lib.ts` points `chat()` at the Inferest server's `/v1/chat/completions`; both demo scripts otherwise run unchanged. The agent demo keeps its MCP connection.
- Tests (node:test, fakes for upstream and chain, real in-memory store): proxy unit tests (streaming and non-streaming cost capture, client disconnect mid-stream, upstream failure producing a pending row, pending resolution by lookup, 401 unknown and revoked, 402 exhausted and frozen, upstream error relay, the two rewrites, body cap); store migration to version 3 and the new methods; keeper tests adapted to one OpenRouter key per company and metered spend; settlement snapshot and freeze-wait tests; server tests for the new admin routes and the setup page. Existing tests keep passing or are adapted with their assertions intact.
- Migration: schema version 3 on open, additive only.
- Docs: README (keys are Inferest keys; setup), workflow doc sections 2 and 3, deck wording.

## 8. Out of scope

Wallet login for company admins (next spec), Anthropic Messages format, per-key model allowlists, rate limits beyond budget, a separate proxy service, prompt logging, migrating existing OpenRouter per-developer keys (demo data only).

## Acceptance

1. A request with a fresh Inferest key returns the model's answer through the proxy, and a `model_calls` row with the generation id and cost appears within the same request for non-streaming and by the final event for streaming.
2. A key with no remaining budget gets 402 with the remaining amount and the dashboard URL; a revoked key gets 401 on the next request.
3. Per-key spend and the company OpenRouter limit agree with the limits math on every keeper tick; the daily drift check logs zero drift in a clean run.
4. The treasury demo runs end to end with Inferest keys, and settlement usage equals the sum of recorded model costs plus tool spend.
5. A client disconnect mid-stream still yields a recorded cost; an upstream failure yields a pending row that the next tick resolves.
