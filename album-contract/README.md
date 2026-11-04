# Stag House Records catalog contract (Robinhood Chain, chain ID 4663)

LIVE: HoodRichSongs (ERC-1155 catalog): 0x895c3c2cC2790Db976EB03b0Fae17EB5594aaCA4
Deployed 2026-11-04. 8 songs (items 1-8) at 0.0022 ETH, the Hood Rich album (item 9) at 0.011 ETH, 100 copies each.
Label cut 20% -> label wallet 0x72938Daaf3c2Fa4bEf722E1263a5766755788392; artist 80% -> Winslow 0xC3e89fC7F9d3594DE794EA4C60E5E4D7d59AB055.
Paid in Robinhood Chain ETH only. The contract never holds funds. Add more songs, albums and artists any time from /admin/ (no redeploy).
Each item's artist wallet, label cut and copy limit are locked when it is added. Prices can be updated by the owner (buyers are protected).

HoodRichAlbum.sol is an older single-album contract that was NOT deployed (the album is item 9 of the catalog).
Tests: forge test (43 tests); forge test --match-contract ForkTest --fork-url https://rpc.mainnet.chain.robinhood.com
Slither: only an informational note about the intended payout call. No outside audit yet.
