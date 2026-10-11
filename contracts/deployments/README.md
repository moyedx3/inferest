# Contract deployments

[`arbitrum-one.json`](arbitrum-one.json) records the Inferest contracts deployed on
Arbitrum One (chain ID `42161`) on 2026-10-04. It contains public addresses,
deployment transactions, initial roles, build settings, and verification records.
Roles and the target allowlist are a snapshot at deployment, not live state.

| Contract | Address |
| --- | --- |
| VaultFactory | [0x90c07624f98cC3F0360D0e120CD7e6081132f12c](https://arbiscan.io/address/0x90c07624f98cC3F0360D0e120CD7e6081132f12c) |
| Splitter | [0xBB2Bb56fadD96569c256e3092bF6c8e48c98C684](https://arbiscan.io/address/0xBB2Bb56fadD96569c256e3092bF6c8e48c98C684) |
| YieldDonatingTokenizedStrategy implementation | [0x86be0549C6252b3630B8C64A6BD85ABC30582aB0](https://arbiscan.io/address/0x86be0549C6252b3630B8C64A6BD85ABC30582aB0) |
| Fluid USDC target (existing dependency) | [0x1A996cb54bb95462040408C06122D45D6Cdb6096](https://arbiscan.io/address/0x1A996cb54bb95462040408C06122D45D6Cdb6096) |
| Native USDC (existing dependency) | [0xaf88d065e77c8cC2239327C5EDb3A432268e5831](https://arbiscan.io/address/0xaf88d065e77c8cC2239327C5EDb3A432268e5831) |

The factory creates individual customer vaults. The implementation address above
is shared strategy logic, not a customer deposit address.

The three Inferest contracts have Sourcify creation and runtime verification
results of `match`; their verification links are in the JSON. These results do
not constitute a security audit. This deployment is a limited mainnet pilot.

## Monad fork

[`monad-fork.json`](monad-fork.json) records the Inferest contracts deployed on
2026-10-11 to a Tenderly Virtual TestNet that forks Monad mainnet (chain ID `143`,
kept), over Aave's static USDC wrapper. It is a private fork with test money only.
The record names the fork, its block and its keeper so a host can run the demo
against it, and is replaced when the fork is recreated and the contracts
redeployed. `Deploy.s.sol` writes `143.json` during execution; that file stays
ignored.

## Generated files

[`../script/Deploy.s.sol`](../script/Deploy.s.sol) writes `<chainId>.json`, including
`42161.json`, during execution. A dry run can produce this file without broadcasting
transactions. An Arbitrum One fork can also use chain ID `42161`, so the filename
alone does not establish a mainnet deployment. Later runs overwrite it.

Keep generated files ignored. Maintain `arbitrum-one.json` as the reviewed public
record, with successful mainnet transaction hashes and blocks, and `monad-fork.json`
as the record of the Monad fork (test money only, replaced when the fork is
recreated). Keep credentials,
environment files, and private operational reports out of this directory.

Service and Docker deployment instructions belong in [`../../deploy/`](../../deploy/).
