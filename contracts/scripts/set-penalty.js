/* Restore (or change) the early-unstake penalty on StagStaking — "turn the lock back on".
 *   npx hardhat run scripts/set-penalty.js --network rhmainnet          (defaults to 15%)
 *   PENALTY_BPS=1000 npx hardhat run scripts/set-penalty.js --network rhmainnet   (10%)
 *
 * bps: 1500 = 15% (original), max 3000 = 30%. Applies to unstaking BEFORE the lock matures.
 */
const { ethers } = require("hardhat");
const STAKING = process.env.STAKING_ADDR || "0x2faA6672546912e7cDec4E1AaCF1eeF52bA524fF";
const BPS = BigInt(process.env.PENALTY_BPS || "1500");
const abi = ["function setEarlyPenaltyBps(uint256)", "function earlyPenaltyBps() view returns (uint256)", "function owner() view returns (address)"];

async function main() {
  const [d] = await ethers.getSigners();
  const c = new ethers.Contract(STAKING, abi, d);
  if ((await c.owner()).toLowerCase() !== d.address.toLowerCase()) throw new Error("you are not the StagStaking owner");
  const cur = await c.earlyPenaltyBps();
  console.log(`current early-unstake penalty: ${Number(cur) / 100}%`);
  if (cur === BPS) { console.log("already set — nothing to do."); return; }
  console.log(`setting penalty → ${Number(BPS) / 100}%…`);
  await (await c.setEarlyPenaltyBps(BPS)).wait();
  console.log(`✅ lock is back on — early unstake now costs ${Number(await c.earlyPenaltyBps()) / 100}% (+ forfeits pending rewards).`);
}
main().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
