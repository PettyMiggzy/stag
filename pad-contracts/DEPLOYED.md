# STAG Pad - deployed on Robinhood Chain (chain 4663)

Built and deployed by Jarvis the Dev, King Petty's AI assistant (the Jarvis header is at the top of every source file).
Quote asset: USDG. Platform share on the house pad: 20%. Buying and selling with ETH is routed by the site/SDK
through Uniswap's router; no contract here is involved in that leg.

Deployed 2026-10-13 in blocks around 87533000 (13 transactions). All ten contracts are an exact match on Sourcify,
built with the metadata hash on so the bytecode is unique to this source.

| contract | address |
|---|---|
| StagTreasury (owner: the STAG owner wallet) | 0x6E71373E6F0823d664a51E6476152aFD0208A325 |
| StagHook | 0x3523741dD9c66870C04a7A7e409470f1Fd4F68Cc |
| StagFeeDesk | 0xd991Be3882d4ACf61F8ADb8b2c4A8A865A4f5886 |
| StagPortal (main portal) | 0x53403484Fa8c01fD60C91a88C05138C3b0068502 |
| PadRevenueSplitter implementation | 0x4a64de2191d95E9401Bd5810525A3de8Be61fe35 |
| StagPadFactory (ownership offered to the owner wallet; call acceptOwnership()) | 0xCdC800FbDC88c3ac1C4133Ca4d7Af48d8B968181 |
| PadPortalTemplate (#1) | 0x2C7c144cDDBF9C3b0C4aA3E9E7E01d6af6d1B883 |
| HolderTokenDeployer | 0xCb9Df568038bEF945d800b9b57f288F161Dca60E |
| HolderPadTemplate (#2, approved) | 0xADa5fCEdC6b2d67560fD250abE951eD9021618D3 |
| House pad "STAG Pad" (HolderPadPortal) - point the site at this | 0x5B91a07eD3421980aed3c423b311a8d42E914F64 |

Owner wallet: 0x7696Cd99d1EbC0F3A5a4A8525377ec35C6Ca196D (owns the treasury and the house pad; the factory is offered to it, call acceptOwnership()).
Deployer wallet (holds no funds beyond dust): 0xdB4F6fa0A30df7e093CeA5d1a9509c5Cddde4777.

Rebuild: `bash script/setup-deps.sh && forge build` (solc 0.8.26, cancun, pinned in foundry.toml).

## Site

https://stag-pad.vercel.app (source: ../pad-web). Reads this deployment by default; see pad-web/.env.example.
