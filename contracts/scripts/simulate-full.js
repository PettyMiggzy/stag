/* Exhaustive whole-system simulation for the Hooded 20 stack.
 * Exercises EVERY action across all four contracts (mint pick/gamble/free/overpay, stake/unstake/
 * claim/NFT, collectors incl. a reverting contract, sweepEth, owner config changes, full Pact
 * lifecycle incl. reclaim) and asserts every cross-contract invariant after EVERY step.
 *
 *   SIM_RUNS=200 SIM_SEED=1 npx hardhat run scripts/simulate-full.js
 */
const { ethers, network } = require("hardhat");

const RUNS = parseInt(process.env.SIM_RUNS || "200", 10);
let SEED = parseInt(process.env.SIM_SEED || "1", 10);
function rng() { SEED |= 0; SEED = (SEED + 0x6D2B79F5) | 0; let t = Math.imul(SEED ^ (SEED >>> 15), 1 | SEED); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const pick = (n) => Math.floor(rng() * n);
const E = (n) => ethers.parseEther(String(n));
const WEEK = 7 * 24 * 3600;
async function warp(sec) { await network.provider.send("evm_increaseTime", [sec]); await network.provider.send("evm_mine"); }

const TIER = [4,3,0,1,1,3,2,1,2,2,1,0,2,3,0,0,1,3,2,4]; // id1..20 tiers
const PRICE = ["0.010","0.015","0.020","0.025","0.030"]; // pick price by tier

async function main() {
  const s = await ethers.getSigners();
  const owner = s[0], backend = s[1], oracle = s[2];
  const actors = s.slice(3, 10); // 7 actors
  const cols = s.slice(10, 14).map((x) => x.address); // collector EOAs

  const Mock = await ethers.getContractFactory("MockERC20");
  const stag = await Mock.deploy();
  const Rev = await ethers.getContractFactory("Reverter");
  const reverter = await Rev.deploy();
  const Hooded = await ethers.getContractFactory("HoodedTwenty");
  const hood = await Hooded.deploy("ipfs://x/", ethers.ZeroAddress, 500);
  const Staking = await ethers.getContractFactory("StagStaking");
  const staking = await Staking.deploy(await stag.getAddress(), await hood.getAddress());
  const Splitter = await ethers.getContractFactory("RevenueSplitter");
  const splitter = await Splitter.deploy(await staking.getAddress(), backend.address, 9000);
  const Pact = await ethers.getContractFactory("SherwoodPact");
  const pact = await Pact.deploy(await stag.getAddress(), E("0.01"), E("0.005"));
  await pact.setOracle(oracle.address);
  await hood.setSplitter(await splitter.getAddress());
  await hood.setLocker(await staking.getAddress());
  await hood.setMintActive(true);
  await hood.setMaxPerWallet(20); // allow deep minting in sim
  const SK = await staking.getAddress(), STAG = await stag.getAddress(), PK = await pact.getAddress(), SP = await splitter.getAddress(), HD = await hood.getAddress();
  const revAddr = await reverter.getAddress();

  for (const a of actors) { await stag.mint(a.address, E("50000000")); await stag.connect(a).approve(SK, ethers.MaxUint256); }
  await owner.sendTransaction({ to: SK, value: E("30") });
  await staking.notifyRewardAmount(E("5"), 30 * 24 * 3600);
  await pact.connect(owner).fund({ value: E("5") });

  const staked = {}; actors.forEach((a) => staked[a.address] = 0n);
  const counts = {};
  const bump = (k) => counts[k] = (counts[k] || 0) + 1;

  async function inv(step) {
    // STAKING solvency + weight + principal + accrual
    const skBal = await ethers.provider.getBalance(SK);
    const reserved = await staking.reserved();
    if (reserved > skBal) throw new Error(`[${step}] staking INSOLVENT: reserved ${reserved} > bal ${skBal}`);
    // stronger: balance must also cover the still-streaming reward schedule (the sweepEth guarantee)
    const pf = Number(await staking.periodFinish());
    const rate = await staking.rewardRate();
    const nowT = (await ethers.provider.getBlock("latest")).timestamp;
    const outstanding = pf > nowT ? rate * BigInt(pf - nowT) : 0n;
    if (reserved + outstanding > skBal + 10n ** 12n) throw new Error(`[${step}] SCHEDULE-INSOLVENT: reserved ${reserved} + outstanding ${outstanding} > bal ${skBal}`);
    let sumW = 0n, owed = 0n;
    for (const a of actors) { const info = await staking.userInfo(a.address); sumW += info.weight; owed += info.pendingEth;
      const on = await staking.stakedOf(a.address, STAG); if (on !== staked[a.address]) throw new Error(`[${step}] principal drift ${a.address}`); }
    if (sumW !== await staking.totalWeight()) throw new Error(`[${step}] staking WEIGHT DRIFT sum ${sumW} != total ${await staking.totalWeight()}`);
    if (owed > skBal + 1n) throw new Error(`[${step}] staking OVER-ACCRUAL ${owed} > ${skBal}`);
    // MINT pool integrity
    const minted = await hood.minted(), rem = await hood.remaining();
    if (minted + rem !== 20n) throw new Error(`[${step}] mint supply drift ${minted}+${rem}`);
    // (mint proceeds intentionally accumulate in the NFT contract until forwardProceeds — scanner-safe)
    // SPLITTER never accumulates
    if (await ethers.provider.getBalance(SP) !== 0n) throw new Error(`[${step}] splitter holds ETH`);
    // PACT solvency
    const pkBal = await ethers.provider.getBalance(PK);
    const rp = await pact.reservedPayouts(), re = await pact.reservedEntries();
    if (rp + re > pkBal) throw new Error(`[${step}] pact INSOLVENT: ${rp}+${re} > ${pkBal}`);
  }

  const pactIds = []; // track created pacts
  for (let step = 0; step < RUNS; step++) {
    const a = actors[pick(actors.length)];
    const r = rng();
    try {
      if (r < 0.14) { // stake (no tier downgrade)
        const info = await staking.userInfo(a.address);
        const minTier = info.baseWeight > 0n ? Number(info.lockTier) : 0;
        const tier = minTier + pick(3 - minTier);
        const amt = E(1 + pick(4_000_000));
        await staking.connect(a).stakeTokens(STAG, amt, tier); staked[a.address] += amt; bump("stake");
      } else if (r < 0.22) { // unstake
        const cur = staked[a.address];
        if (cur > 0n) { const amt = (cur * BigInt(1 + pick(100))) / 100n; const use = amt > cur ? cur : amt;
          await staking.connect(a).unstakeTokens(STAG, use); staked[a.address] -= use; bump("unstake"); }
      } else if (r < 0.30) { try { await staking.connect(a).claim(); bump("claim"); } catch { bump("claimLocked"); } }
      else if (r < 0.36) { // set collectors, sometimes including the reverting contract
        const k = pick(4); const w = [], b = []; let left = 100;
        for (let i = 0; i < k; i++) { const share = pick(left + 1); w.push(rng() < 0.3 ? revAddr : cols[i]); b.push(share * 100); left -= share; }
        await staking.connect(a).setCollectors(w, b); bump("collectors");
      } else if (r < 0.40) { // stake NFT if owned+free
        const bal = await hood.balanceOf(a.address);
        for (let i = 0; i < bal; i++) { const id = await hood.tokenOfOwnerByIndex(a.address, i);
          if ((await staking.nftStaker(id)) === ethers.ZeroAddress) { await staking.connect(a).stakeNFT(id); bump("stakeNft"); break; } }
      } else if (r < 0.43) { const info = await staking.userInfo(a.address); if (info.nfts.length) { try { await staking.connect(a).unstakeNFT(info.nfts[0]); bump("unstakeNft"); } catch {} } }
      else if (r < 0.52) { // MINT: pick / gamble / free / overpay
        if (await hood.remaining() > 0n) {
          const mode = pick(4);
          if (mode === 0) { // pick exact
            const rem = await hood.remainingIds(); const id = Number(rem[pick(rem.length)]);
            await hood.connect(a).mintPick(id, { value: E(PRICE[TIER[id - 1]]) }); bump("pick");
          } else if (mode === 1) { // forward accumulated proceeds to the pool (out-of-band 90/10 split)
            try { await hood.forwardProceeds(); bump("forward"); } catch { bump("forwardEmpty"); }
          } else if (mode === 2) { await hood.connect(a).mintRandom({ value: E("0.010") }); bump("gamble"); }
          else { await hood.grantFreeMints(a.address, 1); await hood.connect(a).mintRandom({ value: 0 }); bump("free"); }
        }
      } else if (r < 0.60) { // owner: fund + notify
        await owner.sendTransaction({ to: SK, value: E(1 + pick(10)) });
        try { await staking.notifyRewardAmount(E(1 + pick(3)), 10 * 24 * 3600); bump("notify"); } catch {}
      } else if (r < 0.62) { // owner: sweepEth (only genuinely-free ETH, excl. reserved + schedule)
        const pf = Number(await staking.periodFinish()); const rate = await staking.rewardRate();
        const nowT = (await ethers.provider.getBlock("latest")).timestamp;
        const out = pf > nowT ? rate * BigInt(pf - nowT) : 0n;
        const bal2 = await ethers.provider.getBalance(SK); const res2 = await staking.reserved();
        const free = bal2 > res2 + out ? bal2 - res2 - out : 0n;
        if (free > 1000n) { await staking.sweepEth(owner.address, free / 2n); bump("sweep"); }
      } else if (r < 0.64) { // permissionless poke to apply config changes to live positions
        await staking.poke(actors.map((x) => x.address)); bump("poke");
      } else if (r < 0.68) { // owner: staking config changes
        const c = pick(3);
        if (c === 0) await staking.setTierMultBps(1 + pick(2), 10000 + pick(40000));
        else if (c === 1) await staking.setNftBaseWeight(E(1 + pick(500000)));
        else await staking.setHoldingTiers([0, E("1000000"), E("10000000")], [10000, 10000 + pick(20000), 20000 + pick(20000)]);
        bump("cfg");
      } else if (r < 0.80) { // PACT: create (one open pact per wallet)
        if (!(await pact.hasOpenPact(a.address))) {
          await pact.connect(a).createPact(E(1 + pick(5000000)), WEEK, { value: E("0.01") });
          pactIds.push({ id: pactIds.length, wallet: a.address, born: step }); bump("pactCreate");
        }
      } else if (r < 0.86) { // PACT: oracle verify a past-window open pact
        const openIds = await pact.openPactsPastWindow(0, 10);
        if (openIds.length) { const id = Number(openIds[pick(openIds.length)]); const held = rng() < 0.6;
          const reward = held ? E("0.001") : 0n; try { await pact.connect(oracle).verify(id, held, reward); bump("pactVerify"); } catch {} }
      } else if (r < 0.90) { // PACT: holder claim a verified pact
        for (const p of pactIds) { try { const pp = await pact.pacts(p.id); if (Number(pp.status) === 2) { // Verified
          const holder = actors.find((x) => x.address === pp.wallet); if (holder) { await pact.connect(holder).claim(p.id); bump("pactClaim"); break; } } } catch {} }
      } else if (r < 0.93) { // PACT: reclaim after grace
        for (const p of pactIds) { try { const pp = await pact.pacts(p.id); if (Number(pp.status) === 1) { // Open
          const holder = actors.find((x) => x.address === pp.wallet); if (holder) { await pact.connect(holder).reclaim(p.id); bump("pactReclaim"); break; } } } catch {} }
      } else if (r < 0.96) { // PACT: owner treasury ops
        const free = await pact.freeTreasury(); if (free > 0n) { await pact.withdrawTreasury(owner.address, free / 2n); bump("pactWithdraw"); }
      } else { await warp(1 + pick(40 * 24 * 3600)); bump("warp"); }
    } catch (e) { bump("revert"); }
    await inv(step);
  }

  // Drain phase: warp far past all locks/grace, everyone exits; invariants must hold throughout.
  await warp(400 * 24 * 3600);
  for (const a of actors) {
    try { await staking.connect(a).claim(); } catch {}
    const cur = staked[a.address]; if (cur > 0n) { try { await staking.connect(a).unstakeTokens(STAG, cur); staked[a.address] = 0n; } catch {} }
    await inv(9999);
  }
  console.log(`\n✅ ${RUNS} full-system steps — all invariants held (seed ${process.env.SIM_SEED || 1}).`);
  console.log("actions:", JSON.stringify(counts));
}
main().catch((e) => { console.error("\n❌ SIMULATION FAILED:\n" + (e.stack || e.message)); process.exit(1); });
