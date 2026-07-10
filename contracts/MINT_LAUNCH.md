# The Hooded 20 — FAST mint launch (get selling today)

Goal: launch the NFT mint now, collect ETH, wire staking later. The NFT is already
**lockable**, so doing this first is safe — staking plugs in afterward.

Deploy ONE contract now: **`HoodedTwenty.sol`** (proceeds go straight to your wallet for
now). Deploy the RevenueSplitter + StagStaking later, then `setSplitter` to start the
60/40 split. Deployer needs a little ETH on Robinhood Chain for gas.

## Network (add to wallet)
| | |
|---|---|
| Name | Robinhood Chain |
| Chain ID | **4663** |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Currency | ETH |
| Explorer | `https://robinhoodchain.blockscout.com` |

## Deploy in Remix (remix.ethereum.org, desktop)
1. New file `HoodedTwenty.sol` → paste `contracts/HoodedTwenty.sol` (Remix auto-resolves the
   `@openzeppelin` imports).
2. Compile with **Solidity 0.8.26**.
3. Deploy tab → Environment = **Injected Provider** (MetaMask on Robinhood Chain).
4. Constructor args:
   | arg | value |
   |---|---|
   | `_price` | `11500000000000000`  ← 0.0115 ETH ≈ **$20** (re-peggable via `setMintPrice`) |
   | `baseURI_` | `https://stagwifhood.fun/assets/nft/stagwifhood/metadata/` |
   | `_splitter` | `0xece5d15e567c801c835029a49b2e4067b0eb63aa`  ← your wallet (proceeds land here for now) |
   | `royaltyBps` | `500`  ← 5% secondary royalty |
5. **Deploy.**
6. On the deployed contract, call **`setMintActive(true)`**.
7. (optional) test one `mint()` sending `0.0115` ETH → you should receive a random Hooded stag.

## After deploy
- **Send me the deployed NFT contract address** → I wire the site's mint button + "Coming Soon"
  → live, pointed at it.
- 20 supply, random, **no duplicates** (built in), "sold out" after #20.
- $20 is pegged at today's ETH (~$1,748). If ETH moves a lot, call `setMintPrice(newWei)` to re-peg.

## Notes
- This launches the mint BEFORE the professional audit. HoodedTwenty is the simple,
  heavily-reviewed contract; the complex staking waits for the audit — fine to phase it.
- When staking is ready: deploy RevenueSplitter(pool=StagStaking, owner=0xece5…) + StagStaking,
  then on the NFT call `setSplitter(<splitter>)`, `setRoyalty(<splitter>,500)`, `setLocker(<staking>)`.
