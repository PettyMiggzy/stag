# STAG Pad by Jarvis - deployed on Robinhood Chain (chain 4663)

Built and deployed by Jarvis the Dev, King Petty's AI assistant. The code is the Robin Labs Pad V4 relaunch
stack, unchanged (the compiled bytecode matches it exactly); only comments and the Jarvis header differ.
Quote asset: USDG. Platform share on the house pad: 20%.

Deployed in blocks 87453016 - 87453138 (13 transactions). All ten contracts show a Sourcify match.

| contract | address |
|---|---|
| RobinTreasury (owner: the STAG owner wallet) | 0x32E53bc783F1FB0432A06225350EB65c85E949e8 |
| RobinHook | 0x319Fdb13053C5CFf7F610bd05AAE891D870dA8Cc |
| RobinFeeDesk | 0xF24FB67f3e43dE6b23284C504E1831EC74F11215 |
| RobinPortal (main portal) | 0xAA34Fc6CD722344B61592E07369634BD72e8226d |
| PadRevenueSplitter implementation | 0x6C084EC17cf2C7956F9f6614803BC33d4289e51A |
| RobinPadFactory (ownership offered to the owner wallet; call acceptOwnership()) | 0xA856E63Ae02856A668a00A7fE7bAf7Ce337Fd3Cf |
| PadPortalTemplate (#1) | 0x35ce2C68bFf8F4e06375e8a8B39a139b0cfBA52D |
| HolderTokenDeployer | 0x5C36F449F51D37525D0386e6F4C0Ea34A7B45FB9 |
| HolderPadTemplate (#2, approved) | 0xAEe8da7E1D0a62D79Dd25d47015ca8CD6f3B58cE |
| House pad "STAG Pad by Jarvis" (HolderPadPortal) - point the site at this | 0xE078f4C3818eC6a87FE6DA08e0c1706dC479ff81 |

Owner wallet: 0x7696Cd99d1EbC0F3A5a4A8525377ec35C6Ca196D (owns the treasury and the house pad now).
Deployer wallet (holds no funds): 0xdB4F6fa0A30df7e093CeA5d1a9509c5Cddde4777.

Rebuild: `bash script/setup-deps.sh && forge build` (solc 0.8.26, cancun, pinned in foundry.toml).

## Site

https://stag-pad.vercel.app (source: ../pad-web). Reads this deployment by default; see pad-web/.env.example.
