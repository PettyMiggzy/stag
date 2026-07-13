// Randomized invariant simulation for SherwoodVault.
//   npx hardhat run scripts/simulate-vault.js
// Random actors stake/unstake NFTs (custody + lock-in-place) and claim streamed ETH rewards while
// the owner funds/streams and tweaks weights. Core invariants asserted after every step.
const { ethers } = require("hardhat");

const N = parseInt(process.env.SIM_RUNS || "400", 10);
let _s = (0x9e3779b9 ^ parseInt(process.env.SIM_SEED || "4663")) >>> 0;
const rnd = () => { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 0x100000000; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const E = (n) => ethers.parseEther(String(n));

async function main() {
  const signers = await ethers.getSigners();
  const owner = signers[0];
  const actors = signers.slice(1, 6);

  const vault = await (await ethers.getContractFactory("SherwoodVault")).deploy(owner.address);
  const V = await vault.getAddress();
  const custody = await (await ethers.getContractFactory("MockNFT")).deploy();
  const lockN = await (await ethers.getContractFactory("MockLockableNFT")).deploy();
  await lockN.setLocker(V);
  const CA = await custody.getAddress(), LA = await lockN.getAddress();
  await vault.addCollection(CA, E("10000"), false);
  await vault.addCollection(LA, E("10000"), true);
  const weights = { [CA]: E("10000"), [LA]: E("10000") };
  const lockInPlace = { [CA]: false, [LA]: true };

  // shadow model: active stakes = { key: {actor, collection, tokenId, weight} }
  const stakes = {};              // key = collection+':'+tokenId
  const nextId = { [CA]: 1, [LA]: 1 };
  const counts = {}; const tally = (k) => counts[k] = (counts[k] || 0) + 1;

  const assertInvariants = async (step) => {
    // 1) totalWeight == Σ weightOf ; weightOf[u] == Σ snapshot weights of u's active stakes
    let sumW = 0n; const perUser = {};
    for (const k in stakes) { const s = stakes[k]; perUser[s.actor] = (perUser[s.actor] || 0n) + s.weight; }
    for (const a of actors) {
      const wOn = await vault.weightOf(a.address);
      const wModel = perUser[a.address] || 0n;
      if (wOn !== wModel) throw new Error(`[${step}] weightOf ${a.address} chain ${wOn} != model ${wModel}`);
      sumW += wOn;
    }
    if ((await vault.totalWeight()) !== sumW) throw new Error(`[${step}] totalWeight != Σ weightOf`);
    // 2) custody: vault owns NFT; lock-in-place: locked && staker owns
    for (const k in stakes) {
      const s = stakes[k];
      if (lockInPlace[s.collection]) {
        const c = await ethers.getContractAt("MockLockableNFT", s.collection);
        if ((await c.ownerOf(s.tokenId)).toLowerCase() !== s.actor.toLowerCase()) throw new Error(`[${step}] lockNFT ${k} not in staker wallet`);
        if (!(await c.locked(s.tokenId))) throw new Error(`[${step}] lockNFT ${k} not locked`);
      } else {
        const c = await ethers.getContractAt("MockNFT", s.collection);
        if ((await c.ownerOf(s.tokenId)).toLowerCase() !== V.toLowerCase()) throw new Error(`[${step}] custody NFT ${k} not held by vault`);
      }
    }
    // 3) SOLVENCY: contract ETH balance >= Σ earned (can pay everyone right now)
    let owed = 0n;
    for (const a of actors) owed += await vault.earned(a.address);
    const bal = await ethers.provider.getBalance(V);
    if (bal + 5n < owed) throw new Error(`[${step}] INSOLVENT: bal ${bal} < Σ earned ${owed}`);
    // 4) reserved <= balance
    if ((await vault.reserved()) > bal + 5n) throw new Error(`[${step}] reserved > balance`);
  };

  for (let step = 0; step < N; step++) {
    const actor = pick(actors);
    const action = pick(["stake", "stake", "unstake", "claim", "donate", "notify", "time", "weight", "toggle"]);
    try {
      if (action === "stake") {
        const col = pick([CA, LA]);
        const c = await ethers.getContractAt(lockInPlace[col] ? "MockLockableNFT" : "MockNFT", col);
        const id = nextId[col]++;
        await (await c.mint(actor.address, id)).wait();
        if (!lockInPlace[col]) await (await c.connect(actor).approve(V, id)).wait();
        // collection may be disabled → expect revert handled by catch
        await (await vault.connect(actor).stake(col, id)).wait();
        stakes[col + ":" + id] = { actor: actor.address, collection: col, tokenId: id, weight: weights[col] };
        tally("stake");
      } else if (action === "unstake") {
        const mine = Object.keys(stakes).filter((k) => stakes[k].actor === actor.address);
        if (!mine.length) { tally("unstake-skip"); }
        else {
          const k = pick(mine); const s = stakes[k];
          await (await vault.connect(actor).unstake(s.collection, s.tokenId)).wait();
          delete stakes[k]; tally("unstake");
        }
      } else if (action === "claim") {
        await (await vault.connect(actor).claim()).wait(); tally("claim");
      } else if (action === "donate") {
        await (await vault.connect(owner).donate({ value: E(pick(["0.5", "1", "2"])) })).wait(); tally("donate");
      } else if (action === "notify") {
        const bal = await ethers.provider.getBalance(V);
        const reserved = await vault.reserved();
        const avail = bal > reserved ? bal - reserved : 0n;
        if (avail > E("0.1")) {
          const amt = avail / 2n; // stream half of free balance
          await (await vault.connect(owner).notifyRewardAmount(amt, pick([50, 100, 200]))).wait(); tally("notify");
        } else tally("notify-skip");
      } else if (action === "time") {
        await ethers.provider.send("evm_increaseTime", [pick([10, 60, 300]) ]); await ethers.provider.send("evm_mine", []); tally("time");
      } else if (action === "weight") {
        const col = pick([CA, LA]); const w = E(pick(["5000", "10000", "20000"]));
        await (await vault.connect(owner).addCollection(col, w, lockInPlace[col])).wait();
        weights[col] = w; tally("weight"); // affects only future stakes; model uses per-stake snapshot
      } else if (action === "toggle") {
        const col = pick([CA, LA]);
        await (await vault.connect(owner).setCollectionEnabled(col, rnd() < 0.7)).wait(); tally("toggle");
      }
    } catch (e) {
      const m = String(e.message);
      if (/INSOLVENT|!=|not held|not locked|not in staker|reserved >/.test(m)) throw e;
      tally("revert");
    }
    await assertInvariants(step);
  }

  console.log(`\n✅ ${N} simulation steps — ALL INVARIANTS HELD`);
  console.log("active stakes:", Object.keys(stakes).length, "| tally:", JSON.stringify(counts));
}
main().then(() => process.exit(0)).catch((e) => { console.error("\n❌ SIM FAILED:", e.message); process.exit(1); });
