# Walkthrough: from an email address to a metered model call

_The path a customer or a reviewer follows on a running Inferest dashboard. Ten minutes, no wallet needed._

1. **Open `/treasury`** on the server's public URL. In the "Sign in to your treasury" card, enter your email and press "Send code", then the six-digit code and "Verify". Dynamic creates an embedded wallet for you; your email and its short address show in the top bar. (A treasury that already lives in MetaMask, on a Ledger or in a custody console presses "Connect treasury wallet" instead; on a demo fork, first point that wallet's network for this chain id at the demo RPC shown on the page, or the transactions go to the real chain.)
2. **Get demo funds** (demo chains only, the lime button on the deposit card): one click funds your wallet with gas and 100,000 USDC on the fork. The first step of the checklist ticks.
3. **Create vault and deposit**: four transactions signed by your wallet: create the vault, accept management, approve, deposit. The checklist gives way to the yield card; the hatched Principal bar shows what your shares are worth, and they are in your wallet. Later deposits go into the same vault with two signatures (approve, deposit).
4. **Report yield** so the keeper books the yield (on a fork, time can be moved forward first), then **Sync limits**, both under the settle card. The yield card shows the period's yield, the Used and Open credit bar and the provider backstop.
5. **Create key**: name it, keep weight 1. The page scrolls to Use a key, where the lime banner shows the key once and the code window's tabs (curl, Python, Node, Vercel AI SDK, Agent config, MCP) carry it. Copy the curl line and run it; the answer comes back through the proxy.
6. **Watch spend**: the key's row in the Keys table shows the call's cost under Spend this period; Left shrinks by the same amount.
7. **Rotate or revoke** the key from its row; a revoked key gets 401 on its next call.
8. **Settle now**: the "If you settle now" card previews it. Usage goes to the float, 10% of the leftover to Inferest, the rest returns to your wallet as shares; the period increments and the settlement appears under Activity with its transaction.
9. **Sign out**: the page goes back to the sign-in view. Sign in again with the same email (or the same wallet) and your vault is back.

What you did not do: hand anyone a key, top up a card, or trust the operator with your principal.

## Agents

Open **`/agents`**; no sign-in. The page shows the hosted agent from `GET /api/agent` and polls it every ten seconds.

- **The head** names the run count and the vault's period; the headline gives the book's total.
- **The book** splits it: the blue part is parked in the agent's Inferest vault at the named source and rate, the soft blue part works in its wallet as USDC and paper positions. The thin line marks the floor the vault never goes under. Open positions list entry, mark and the change so far.
- **The thinking budget** is the Treasury page's yield card over the agent's vault: the yield earned this period, what the models and paid tools used, the provider backstop, and what a settlement now would do.
- **Runs** lists every run, newest first: the chain date, the status (thinking, done, out of budget, failed), the note, what it did (deposits, moves between sources, paper trades, and anything the fence refused), the tool calls and what the run cost.
- **Yield sources** lists the allowlisted vaults with their rates; the one it is parked in says "here".
- **Activity** lists the settlements and the runs' transactions.
- **Your own agent** has the agent config and MCP setups with a placeholder key, and a link to get a real key on Treasury.

A new run appears every `AGENT_INTERVAL_MS`. On a fork with `AGENT_DEMO_DAYS` set, the chain clock moves forward before each run, so the run dates jump by days and yield accrues between them. When the period's yield is used up, the proxy answers the agent with 402 `insufficient_quota`, and the run shows "out of budget" until the vault earns more.
