/* Restore the real staking lock durations — the actual "lock", and the fix for the "0d" tiers.
 *   npx hardhat run scripts/set-lock-tiers.js --network rhmainnet            (30 / 60 / 90 days)
 *   TIER_DAYS=15,45,90 npx hardhat run scripts/set-lock-tiers.js --network rhmainnet
 *
 * The three tiers were sitting at 3600s (1 hour) — so the site rounded them to "0d" and the
 * early-unstake penalty never triggered (nothing was ever "early"). This sets them back to real
 * locks. Each tier: 1 hour ≤ duration ≤ 365 days.
 *
 * ⚠️ HEADS UP: this re-locks EXISTING stakers to the tier they chose. Someone on the 2×/90-day
 *    tier who staked recently becomes locked until 90 days after their stake. That's the point of a
 *    lock, but they staked while it was ~0-day, so expect questions. New stakers get the full lock.
 */
const { ethers } = require("hardhat");
const STAKING = process.env.STAKING_ADDR || "0x2faA6672546912e7cDec4E1AaCF1eeF52bA524fF";
const DAYS = (process.env.TIER_DAYS || "30,60,90").split(",").map((x) => parseInt(x.trim(), 10));
const abi = ["function setTierDuration(uint8,uint256)", "function tierInfo() view returns (uint256[3],uint256[3])", "function owner() view returns (address)"];

async function main() {
  if (DAYS.length !== 3 || DAYS.some((d) => !(d > 0))) throw new Error("TIER_DAYS must be 3 positive numbers, e.g. 30,60,90");
  const [d] = await ethers.getSigners();
  const c = new ethers.Contract(STAKING, abi, d);
  if ((await c.owner()).toLowerCase() !== d.address.toLowerCase()) throw new Error("you are not the StagStaking owner");

  const before = (await c.tierInfo())[0].map((x) => +(Number(x) / 86400).toFixed(3));
  console.log("current locks (days):", before.join(" / "));
  for (let t = 0; t < 3; t++) {
    const secs = Math.round(DAYS[t] * 86400);
    console.log(`tier ${t}: → ${DAYS[t]} days…`);
    await (await c.setTierDuration(t, secs)).wait();
  }
  const after = (await c.tierInfo())[0].map((x) => Math.round(Number(x) / 86400));
  console.log(`✅ locks restored: ${after.join(" / ")} days — the site will now show ${after.join("d / ")}d and the 15% early-unstake penalty is live again.`);
}
main().catch((e) => { console.error("❌", e.message || e); process.exit(1); });
