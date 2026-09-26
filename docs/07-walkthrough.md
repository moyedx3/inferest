# Walkthrough: from an email address to a metered model call

_The path a customer or a reviewer follows on a running Inferest dashboard. Ten minutes, no wallet needed._

1. **Open the dashboard** at the server's public URL. Enter your email under "Sign in" and press "Send code", then the six-digit code and "Verify". Dynamic creates an embedded wallet for you; its address shows under "Signed in as". (A treasury that already lives in MetaMask, on a Ledger or in a custody console presses "Connect treasury wallet" instead; on a demo fork, first point that wallet's network for this chain id at the demo RPC shown on the page, or the transactions go to the real chain.)
2. **Get demo funds** (demo chains only): one click funds your wallet with gas and 100,000 USDC on the fork.
3. **Create vault and deposit**: four transactions signed by your wallet: create the vault, accept management, approve, deposit. The vault card appears; the shares are in your wallet.
4. **Report yield** so the keeper books the yield (on a fork, time can be moved forward first), then **Sync limits**. The card shows yield in the Splitter and the provider backstop.
5. **Create key**: name it, keep weight 1. The panel shows the key once, with snippets for curl, the OpenAI SDKs, the Vercel AI SDK, agent configs and MCP. Copy the curl line and run it; the answer comes back through the proxy.
6. **Watch spend**: the key's Models column moves by the call's cost; Left shrinks by the same amount.
7. **Rotate or revoke** the key from its row; a revoked key gets 401 on its next call.
8. **Settle now**: usage goes to the float, 10% of the leftover to Inferest, the rest returns to your wallet as shares; the period increments.
9. **Sign out**: the vault list empties. Sign in again with the same email (or the same wallet) and it is back.

What you did not do: hand anyone a key, top up a card, or trust the operator with your principal.
