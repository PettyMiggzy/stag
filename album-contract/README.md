# Stag House Records NFT contracts (Robinhood Chain, chain ID 4663)

- `src/HoodRichAlbum.sol`: ERC-721. One NFT = the whole Hood Rich album. $24.99 USDG, 100 copies, starts paused.
- `src/HoodRichSongs.sol`: ERC-1155. One token id per song, each with its own fixed price and cap, new songs start closed.

Both: buyers pay USDG straight to the payout wallet in the same transaction; the contracts never hold money.
Owner (Ownable2Step) can only pause/unpause, add songs, and edit then freeze metadata. Price and cap cannot be changed after a song is added.

Tests: `forge test` (16 tests), plus the real-USDG mainnet fork test: `forge test --fork-url https://rpc.mainnet.chain.robinhood.com`.
Static analysis (Slither): 0 findings. No outside audit yet.
