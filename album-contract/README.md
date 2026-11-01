# Stag House Records NFT contracts (Robinhood Chain, chain ID 4663)

Deployed 2026-11-01:
- HoodRichAlbum (ERC-721, whole album, $24.99 USDG, 100 copies):  0xd5456ed4f9B45c9e13E3825B80f46A9c45dA1764
- HoodRichSongs (ERC-1155, any number of songs AND albums, each with its own price and cap): 0xdC4fCcD5be9CAd4975d09393E5F1a4AAaeF227c4
Owner and payout wallet: 0x72938Daaf3c2Fa4bEf722E1263a5766755788392
Pay token: USDG 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 (6 decimals)

The contracts never hold money: buyers pay USDG straight to the payout wallet in the same transaction.
Price and cap of an item cannot change after it is added. Use /admin/ on the Records site to open sales and add new songs or albums.

`flat/` has single-file versions of both contracts for verifying on the block explorer (Solidity 0.8.26, optimizer on, 200 runs, EVM cancun, no viaIR).
Tests: `forge test` (18 tests) and `forge test --fork-url https://rpc.mainnet.chain.robinhood.com` (real USDG). Slither: 0 findings. No outside audit yet.
