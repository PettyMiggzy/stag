# The Hooded 20 — Go-Live Checklist (Robinhood Chain mainnet 4663)

Everything below is built, tested (25 passing), and committed. These are the human steps to launch.
⚠️ These contracts custody real ETH and forfeit balances — a security review before mainnet is strongly recommended.

## 1. Deploy the contracts
```bash
cd contracts
npm install
npx hardhat test                       # confirm 25 passing
RH_RPC_URL=https://rpc.mainnet.chain.robinhood.com \
DEPLOYER_KEY=0x<owner private key>     # the wallet that will OWN all contracts
npx hardhat run scripts/deploy.js --network rhmainnet
```
Deploys NFT → staking → splitter → pact, wires them, grants 20 free mints to the whitelist
`0x5db7…575f`, and writes `contracts/deployed.json`.

Split is **90% → staking pool / 10% → `0xb6a5…12516`** (owner/backend). If instead you want 100%
of mint proceeds to `0xb6a5…12516`, skip the splitter and `setSplitter(0xb6a5…)` on the NFT.

## 2. Wire the frontend
Paste the four addresses into **`js/hooded-config.js`** (or the **/admin → Deployed Addresses** card,
which stores them in your browser). Mint, stake, and admin pages all read from there.

## 3. Fund + open (all from /admin, connect the owner wallet)
- **Staking → Fund pool** (send ETH) then **Start** a reward period (amount + days). Mint proceeds
  accumulate in the NFT contract (kept out of the signed mint tx for wallet-scanner safety — see
  `WALLET_SAFETY.md`); periodically hit **Mint Control → Forward** (`forwardProceeds`) to split them
  90/10 into the pool, then re-notify. A cron/keeper can call `forwardProceeds()` instead.
- **Mint Control → Activate Mint.**
- Tune tier prices / gamble weights / lock & holding multipliers if desired (defaults are already set:
  pick 0.010→0.030, gamble 0.010 with Mythic ~0.7%; locks 1×/1.5×/2×; holdings 1M→2× / 10M→3×).

## 4. Test free (mainnet)
From the whitelist wallet `0x5db7…575f`, mint a stag (Pick or Surprise Draw) at **0 cost** — its 20
free-mint allowance is granted at deploy.

## 5. Sherwood Pact (proof-of-hold) — after the bubble-map indexer is live
The Pact contract is deployed and tested; its off-chain verifier depends on the **separate Neon bubble-map
DB** (see the Map repo). Once that indexer is running:
- **/admin → Sherwood Pact:** set entry/refund (ETH equiv of $11/$5), set the **oracle** to the indexer's
  signer wallet, and **fund the treasury** for reward payouts.
- The verifier reads $STAG transfer history to confirm continuous holding, then the oracle calls
  `verify(id, held, reward)`.

## What's proven by the test suite (contracts/test)
Tiered pick pricing + underpay guard · weighted gamble no-dupes · free-mint allowlist · 90/10 forwarding ·
lock-in-place · weight stacking to 6× · reward accrual · early penalty + forfeit · lock-gated claim ·
collector splits · funding solvency · full Pact lifecycle + treasury solvency.
