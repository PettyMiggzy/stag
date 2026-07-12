# Stag Locker — handoff brief

**What it is:** a permissionless token + LP locker for **any** project on Robinhood Chain (chainId 4663).
Lock ERC-20 tokens or a Uniswap V3 LP position until a date you choose, prove you can't rug, and let
**anyone** verify it on a public page. Built to be **handed off / white-labeled** — branded $STAG but usable
by the whole chain. Revenue = an optional flat ETH creation fee per lock (admin-set, can be 0).

## Status (what's done)
- ✅ **Contract** `contracts/StagLocker.sol` — self-audited, one real bug fixed (stranded-NFT on bad
  `safeTransferFrom` data). Admin has **no** power to touch locked assets — only `setFee`.
- ✅ **Tests** `test/StagLocker.test.js` + `contracts/mocks/Mocks.sol` — **16/16 passing**
  (Hardhat, Solidity 0.8.24, viaIR, evmVersion `paris`, OpenZeppelin **5.0.2**).
- ✅ **Front-end** `public/locker.html` — connect wallet + network guard, Lock (ERC-20 or V3 LP),
  My Locks (withdraw / extend / top-up), and a **public Verify** tab (paste any token/LP address →
  all its locks + amounts + owners + unlock dates, no wallet needed). Self-contained, ethers v6 via CDN.
- ✅ **Branding** `public/brand/` — antler-shackle padlock logo (`logo.png` / `icon.png`) + a clean
  hero banner (`hero.png`). No characters/NFT art baked in — drop in your own if you want.

## What's left (do these to go live)
1. **Deploy** to Robinhood Chain: `npm i && npm run deploy` with env
   `DEPLOYER_KEY` / `LOCKER_TREASURY` / `LOCKER_ADMIN` (keep the key in your shell env, never commit it).
   Launch with fee = 0, raise later via `setFee`. Then `npx hardhat verify` on Blockscout.
2. **Paste the deployed address** into `public/locker.html` — set `window.STAG_LOCKER_ADDRESS`
   or edit the `LOCKER` const near the top of the `<script>`. That's the only wiring step.
3. **Host the page** — it's static. Drop `public/` on Vercel/any host, or add it as a route on the
   $STAG site (this is where it belongs — NOT in the catboy repo). Point brand asset paths accordingly.
4. Optional but recommended: **third-party audit** before other projects' money goes in.

## Where it should live
This is a **$STAG / stagwifhood** product. Put this folder in the **stagwifhood repo** (or its own repo),
not the catboy one. Everything here is self-contained: contract, tests, front-end, branding, deploy script.

## Robinhood Chain facts
- chainId **4663** · RPC `https://rpc.mainnet.chain.robinhood.com` · gas token ETH · explorer `https://robinhoodchain.blockscout.com`
- Uniswap V3 NonfungiblePositionManager: `0x73991a25c818bf1f1128deaab1492d45638de0d3`

See `README.md` in this folder for the full spec, self-audit findings, and contract details.
