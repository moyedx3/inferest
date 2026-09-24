# Landscape

_Source: [`../sources/yield-to-inference-2026-09-24.md`](../sources/yield-to-inference-2026-09-24.md). Vault company notes: `Companies/Orbio.md`, `Companies/Touchmark.md`._

**Turning crypto into inference credit is already being done.** Every existing player funds it with its own token. Nobody funds it with neutral yield on blue-chip assets (USDC lending, ETH and SOL staking). That is the differentiation.

| Service | Funded by | Credit rail | Relation to us |
|---|---|---|---|
| [Venice](https://docs.venice.ai/overview/vvv-diem) (VVV, DIEM) | Staking its own token VVV | Own inference; 1 DIEM = $1 of credit per day | Closest precedent. Principal kept, credit issued daily |
| [Orbio](https://www.orbio.so/protocol) (ORBIO, CREDIT) | 50% of its own token's trading fees | Gateway built on OpenRouter | Converts fees into OpenRouter credit and distributes to holders |
| [Touchmark](https://touchmark.ai/) | Buyer prepayment | Forward contracts with open-weight model providers | Not yield, but treats inference as a financial product |
| x402 inference gateways ([BlockRun](https://pypi.org/project/blockrun-llm/), ClawRouter) | USDC in the agent's wallet | Pay per request in USDC | Substitute for ICP2, and a possible output rail |
| [OpenRouter](https://openrouter.ai/docs/guides/overview/auth/management-api-keys) | Card or USDC prepay | Routes 400+ models | The rail we ride on |

---

## Venice is the benchmark

Stake VVV, mint DIEM, and each DIEM yields $1 of API credit every day, permanently ([CoinMarketCap](https://coinmarketcap.com/cmc-ai/venice-ai/what-is/)). VVV recently reached a market cap of about $1.5B ([Cryptopolitan](https://www.cryptopolitan.com/venice-vvv-token-hits-record-34-as-its-privacy-ai-staking-model-draws-fresh-bets/)). **There is demand for "lock principal, receive inference daily."**

## Orbio is the rail design to study

Buy CREDIT on-chain and activate it, and it converts to API balance. An agent can do this with no human payment step ([Orbio](https://www.orbio.so/protocol)).

## x402 gateways are the agent-side alternative

SDKs already let an agent use 80+ models paying per request with only a wallet signature ([BlockRun](https://pypi.org/project/blockrun-llm/)). Rather than compete, Inferest should sit underneath them: keep the agent wallet's principal in a vault and fund its x402 payments from the interest.
