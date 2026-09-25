# Risks

_Source: [`../sources/yield-to-inference-2026-09-24.md`](../sources/yield-to-inference-2026-09-24.md)._

**Ignorable for the hackathon. Two must be solved before commercializing: terms of service and custody.**

| Risk | What it is | Hackathon | Commercial response |
|---|---|---|---|
| **OpenRouter terms** | Standard terms forbid reselling model API access ([terms](https://openrouter.ai/terms)). Enterprise terms allow serving the customer's end customers ([enterprise terms](https://openrouter.ai/terms-of-service-enterprise)) | Proceed | Enterprise contract, or run a rail that allows resale (Venice etc.) in parallel |
| **Custody and asset management regulation** | Taking customer assets into a vault raises custody and asset management issues. Operating from Korea also puts virtual asset service provider registration in scope | Per-customer YDS vault, shares in the customer's wallet; only yield reaches our Splitter | Same structure; legal review of whether holding and spending customer yield is itself regulated. See `06-workflow.md` |
| Smart contracts | Vault, curator and oracle risk. Each vault has its own trust assumptions | Accept | Audited vaults only, spread across curators, per-vault caps |
| Rate changes | APY moves with borrowing demand. sUSDe fell from double digits to about 5% ([Eco](https://eco.com/support/en/articles/15182156-usdc-yield-in-2026-where-to-earn-interest-on-usdc)) | Irrelevant | Open limits against earned yield only; show an expected credit range on the dashboard |
| Rail dependence | OpenRouter already removed its crypto top-up API once. Credits can expire a year after purchase, and crypto payments are non-refundable ([RouterPlex](https://routerplex.com/blog/openrouter-top-up-fees)) | Irrelevant | Multi-rail credit router, keep the float short |
| Accounting and tax | Receiving yield and consuming credit may each be a taxable event | Irrelevant | Reporting for ICP1, professional review |

**Non-custodial design is both the regulatory answer and the sales pitch.** "Your principal never leaves your wallet" is the shortest sentence that persuades a treasury CFO.

## Added by vault note 51

| Risk | What it is |
|---|---|
| **Dollar ceiling** | Open-weight models are about a third of tokens but 11% of enterprise AI spend (Menlo). If margin rides on dollars, cheap-model routing caps it |
| Instant liquidity caps yield | Instant-redemption sources pay 4 to 5%; higher yields (USD.AI 7.02%, GAIB) come with queues or 30-day cooldowns |
| Metering disputes | We meter usage and we sell it. Needs per-request audit logs |
| Market timing | The intersection of on-chain treasuries and meaningful AI spend is narrow today. It widens as agent wallets grow |
