/* Randomized invariant simulation for the Hooded 20 stack.
 * Runs N (default 300) random steps across many actors and asserts core invariants
 * after every step. Exits non-zero on the first violation.
 *
 *   npx hardhat run scripts/simulate.js
 *   SIM_RUNS=300 SIM_SEED=1 npx hardhat run scripts/simulate.js
 */
const { ethers, network } = require("hardhat");

const RUNS = parseInt(process.env.SIM_RUNS || "300", 10);
let SEED = parseInt(process.env.SIM_SEED || "1", 10);
function rng() { SEED |= 0; SEED = (SEED + 0x6D2B79F5) | 0; let t = Math.imul(SEED ^ (SEED >>> 15), 1 | SEED); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const pick = (n) => Math.floor(rng() * n);
const E = (n) => ethers.parseEther(String(n));

async function warp(sec) { await network.provider.send("evm_increaseTime", [sec]); await network.provider.send("evm_mine"); }

async function main() {
  const signers = await ethers.getSigners();
  const owner = signers[0];
  const actors = signers.slice(1, 9); // 8 actors
  const Mock = await ethers.getContractFactory("MockERC20");
  const stag = await Mock.deploy();
  const Hooded = await ethers.getContractFactory("HoodedTwenty");
  const hood = await Hooded.deploy("ipfs://x/", ethers.ZeroAddress, 0);
  await hood.setMintActive(true);
  const Staking = await ethers.getContractFactory("StagStaking");
  const staking = await Staking.deploy(await stag.getAddress(), await hood.getAddress());
  await hood.setLocker(await staking.getAddress());
  const SK = await staking.getAddress(), STAG = await stag.getAddress();

  // fund actors with STAG; give the pool some ETH + a first reward period
  for (const a of actors) { await stag.mint(a.address, E("50000000")); await stag.connect(a).approve(SK, ethers.MaxUint256); }
  await owner.sendTransaction({ to: SK, value: E("50") });
  await staking.notifyRewardAmount(E("10"), 30 * 24 * 3600);

  // pre-mint a few NFTs to actors (free) for NFT-staking coverage
  for (let i = 0; i < 4; i++) { await hood.grantFreeMints(actors[i].address, 1); await hood.connect(actors[i]).mintRandom({ value: 0 }); }

  const staked = {};   // actor => bigint STAG staked (mirror)
  actors.forEach((a) => staked[a.address] = 0n);

  async function checkInvariants(step) {
    const bal = await ethers.provider.getBalance(SK);
    const reserved = await staking.reserved();
    // INV1 solvency: never owe more than held
    if (reserved > bal) throw new Error(`[step ${step}] INSOLVENT: reserved ${reserved} > balance ${bal}`);
    // INV2 weight consistency: Σ user weight == totalWeight
    let sum = 0n;
    for (const a of actors) sum += (await staking.userInfo(a.address)).weight;
    const tw = await staking.totalWeight();
    if (sum !== tw) throw new Error(`[step ${step}] WEIGHT DRIFT: Σuser ${sum} != totalWeight ${tw}`);
    // INV3 principal: mirror matches on-chain stakedOf
    for (const a of actors) {
      const on = await staking.stakedOf(a.address, STAG);
      if (on !== staked[a.address]) throw new Error(`[step ${step}] PRINCIPAL DRIFT ${a.address}: on ${on} mirror ${staked[a.address]}`);
    }
    // INV4 claimable never exceeds balance
    let owed = 0n;
    for (const a of actors) owed += await staking.earned(a.address);
    if (owed > bal + 1n) throw new Error(`[step ${step}] OVER-ACCRUAL: earned ${owed} > balance ${bal}`);
  }

  const counts = {};
  for (let step = 0; step < RUNS; step++) {
    const a = actors[pick(actors.length)];
    const r = rng();
    try {
      if (r < 0.34) { // stake (tier can't be lowered on an active position)
        const info = await staking.userInfo(a.address);
        const minTier = info.baseWeight > 0n ? Number(info.lockTier) : 0;
        const tier = minTier + pick(3 - minTier);
        const amt = E(1 + pick(5_000_000));
        await staking.connect(a).stakeTokens(STAG, amt, tier);
        staked[a.address] += amt; counts.stake = (counts.stake || 0) + 1;
      } else if (r < 0.52) { // unstake partial
        const cur = staked[a.address];
        if (cur > 0n) { const amt = (cur * BigInt(1 + pick(100))) / 100n; const use = amt > cur ? cur : amt;
          await staking.connect(a).unstakeTokens(STAG, use); staked[a.address] -= use; counts.unstake = (counts.unstake || 0) + 1; }
      } else if (r < 0.66) { // claim (often reverts locked — expected)
        try { await staking.connect(a).claim(); counts.claim = (counts.claim || 0) + 1; } catch { counts.claimLocked = (counts.claimLocked || 0) + 1; }
      } else if (r < 0.74) { // set collectors
        const k = pick(4); const w = [], b = []; let left = 100;
        for (let i = 0; i < k; i++) { const share = pick(left + 1); w.push(signers[10 + i].address); b.push(share * 100); left -= share; }
        await staking.connect(a).setCollectors(w, b); counts.collectors = (counts.collectors || 0) + 1;
      } else if (r < 0.80) { // stake an owned NFT
        const balN = await hood.balanceOf(a.address);
        for (let i = 0; i < balN; i++) { const id = await hood.tokenOfOwnerByIndex(a.address, i);
          if ((await staking.nftStaker(id)) === ethers.ZeroAddress) { await staking.connect(a).stakeNFT(id); counts.stakeNft = (counts.stakeNft || 0) + 1; break; } }
      } else if (r < 0.85) { // unstake an NFT
        const info = await staking.userInfo(a.address);
        if (info.nfts.length > 0) { try { await staking.connect(a).unstakeNFT(info.nfts[0]); counts.unstakeNft = (counts.unstakeNft || 0) + 1; } catch {} }
      } else if (r < 0.95) { // time warp
        await warp(1 + pick(40 * 24 * 3600)); counts.warp = (counts.warp || 0) + 1;
      } else { // owner tops up + new reward period
        await owner.sendTransaction({ to: SK, value: E(1 + pick(20)) });
        try { await staking.notifyRewardAmount(E(1 + pick(5)), 10 * 24 * 3600); counts.notify = (counts.notify || 0) + 1; } catch {}
      }
    } catch (e) {
      // legitimate reverts (bad amount, locked, etc.) are fine — only invariant breaks matter
      counts.revert = (counts.revert || 0) + 1;
    }
    await checkInvariants(step);
  }

  // Final: everyone warps past locks and fully exits; pool must remain solvent throughout.
  await warp(120 * 24 * 3600);
  for (const a of actors) {
    try { await staking.connect(a).claim(); } catch {}
    const cur = staked[a.address];
    if (cur > 0n) { try { await staking.connect(a).unstakeTokens(STAG, cur); staked[a.address] = 0n; } catch {} }
    await checkInvariants(9999);
  }
  console.log(`\n✅ ${RUNS} simulation steps — all invariants held (seed ${process.env.SIM_SEED || 1}).`);
  console.log("action counts:", JSON.stringify(counts));
}

main().catch((e) => { console.error("\n❌ SIMULATION FAILED:\n" + (e.stack || e.message)); process.exit(1); });
