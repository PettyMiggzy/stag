/* Route accumulated NFT mint revenue into the reward pools and stream it to stakers.
 *   STREAM_DAYS=30 npx hardhat run scripts/route-revenue.js --network rhmainnet
 *
 * Turns REAL SALES into visible staker rewards (no need to spend your own ETH):
 *   1. WANTED  → repoint its splitter to the Sherwood Vault (100% to pool; you burn manually),
 *                then sweep its ETH into the Vault (Saints/WANTED stakers earn there).
 *   2. HOODED  → sweep its ETH to the RevenueSplitter (90% → Stag Staking pool, unchanged).
 *   3. Stream the newly-arrived ETH to stakers in each pool over STREAM_DAYS.
 *
 * Idempotent + safe: skips empty sweeps, streams only the net-new uncommitted ETH (with a small
 * buffer so notifyRewardAmount can never revert "insufficient ETH funded").
 */
const { ethers } = require("hardhat");

const HOODED  = process.env.HOODED_ADDR  || "0x4384cB362D908d36266bDF3C31F18DB95EB127dc";
const WANTED  = process.env.WANTED_ADDR  || "0x35c57109217319Df9feF0499F56b3f6a68d50931";
const STAKING = process.env.STAKING_ADDR || "0x2faA6672546912e7cDec4E1AaCF1eeF52bA524fF";
const VAULT   = process.env.WANTED_VAULT || "0x9eeE6eFe6540C3e3AC515D052c99ad4b389a344c";
const DAYS    = Number(process.env.STREAM_DAYS || "30");

const nftAbi  = ["function forwardProceeds()", "function setSplitter(address)", "function splitter() view returns (address)", "function owner() view returns (address)"];
const poolAbi = ["function notifyRewardAmount(uint256,uint256)", "function rewardRate() view returns (uint256)", "function periodFinish() view returns (uint256)", "function reserved() view returns (uint256)", "function owner() view returns (address)"];
const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
const f = (v) => ethers.formatEther(v);

async function streamNew(name, poolAddr, signer, provider, durSec) {
  const pool = new ethers.Contract(poolAddr, poolAbi, signer);
  const [bal, reserved, rate, pf, blk] = await Promise.all([
    provider.getBalance(poolAddr), pool.reserved(), pool.rewardRate(), pool.periodFinish(), provider.getBlock("latest"),
  ]);
  const now = BigInt(blk.timestamp);
  const outstanding = now < pf ? rate * (pf - now) : 0n;      // ETH already committed to the live stream
  const avail = bal > reserved ? bal - reserved : 0n;          // uncommitted-by-accrual
  let amount = avail > outstanding ? avail - outstanding : 0n; // genuinely NEW ETH
  amount = (amount * 95n) / 100n;                              // 5% buffer → notify never reverts on rounding/accrual
  const MIN = ethers.parseEther("0.0005");                    // below this it's dust already committed — skip, don't waste gas
  if (amount < MIN) { console.log(`   ${name}: nothing new to stream — pool ${f(bal)} ETH already fully committed to the live stream`); return; }
  try {
    console.log(`   ${name}: streaming ${f(amount)} ETH over ${DAYS}d…`);
    await (await pool.notifyRewardAmount(amount, durSec)).wait();
    console.log(`   ${name}: ✓`);
  } catch (e) {
    console.log(`   ${name}: skip — already fully committed (${(e.shortMessage || e.message || "").slice(0, 50)})`);
  }
}

async function main() {
  const [d] = await ethers.getSigners();
  const provider = d.provider;
  const durSec = BigInt(Math.round(DAYS * 86400));
  console.log("owner:", d.address, "| stream:", DAYS, "days\n");

  // 1) WANTED → Vault (100% to pool), then sweep
  const wanted = new ethers.Contract(WANTED, nftAbi, d);
  if (!eq(await wanted.owner(), d.address)) throw new Error("you are not the WANTED owner");
  if (!eq(await wanted.splitter(), VAULT)) {
    console.log("1) WANTED: repointing splitter → Vault (100% to pool, manual burn)…");
    await (await wanted.setSplitter(VAULT)).wait(); console.log("   repointed ✓");
  } else console.log("1) WANTED: splitter already → Vault");
  const wbal = await provider.getBalance(WANTED);
  if (wbal > 0n) { console.log(`   sweeping ${f(wbal)} ETH → Vault…`); await (await wanted.forwardProceeds()).wait(); console.log("   swept ✓"); }
  else console.log("   no WANTED ETH to sweep");

  // 2) HOODED → RevenueSplitter (90% → Stag Staking pool)
  const hooded = new ethers.Contract(HOODED, nftAbi, d);
  const hbal = await provider.getBalance(HOODED);
  if (hbal > 0n) { console.log(`\n2) HOODED: sweeping ${f(hbal)} ETH → splitter (90% → staking pool)…`); await (await hooded.forwardProceeds()).wait(); console.log("   swept ✓"); }
  else console.log("\n2) HOODED: no ETH to sweep");

  // 3) stream the newly-arrived ETH
  console.log("\n3) streaming to stakers:");
  await streamNew("Sherwood Vault (Saints/WANTED)", VAULT, d, provider, durSec);
  await streamNew("Stag Staking (token/Hooded)", STAKING, d, provider, durSec);

  console.log("\n✅ Real mint revenue routed + streaming. Stakers now earn from actual sales.");
}
main().catch((e) => { console.error("\n❌", e.message || e); process.exit(1); });
