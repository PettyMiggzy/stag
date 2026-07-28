/* Deploy WANTED (21x 1/1 outlaws) + WantedBounty to Robinhood Chain (4663).
 *   DEPLOYER_KEY=0x... npx hardhat run scripts/deploy-wanted.js --network rhmainnet
 *
 * Does the whole launch wiring EXCEPT the two things only the owner's wallet should do
 * (fund 87,000 $STAG + flip mint live). Prints those as the final steps.
 *
 * 1. deploys SherwoodWanted (ERC-721, tiered price) — royalties route to the Saints splitter
 * 2. wires the splitter (buy-burn / pool / team)
 * 3. sets the tiered prices: Rare $20 / Epic $25 / Legendary $30 / Mythic $35 (as ETH)
 * 4. deploys WantedBounty(STAG, wanted, expiry) and sets the 21 bounties (87,000 $STAG total)
 * 5. leaves mint INACTIVE and bounties UNLOCKED — owner funds + locks + goes live
 */
const { ethers } = require("hardhat");

const BASE_URI = process.env.WANTED_BASE_URI || "https://stagwifhood.fun/assets/nft/wanted/metadata/";
const STAG     = "0xcC142366735c882F7885d3c747db99e45E13E453";
const SPLITTER = process.env.WANTED_SPLITTER || "0x101a344172f15ABe969027ea06624305F4a63082"; // SaintsSplitter (60/30/10) — reuse or override
const VAULT    = process.env.WANTED_VAULT || "0x9eeE6eFe6540C3e3AC515D052c99ad4b389a344c";     // SherwoodVault (NFT staking)
const VAULT_WEIGHT = process.env.WANTED_VAULT_WEIGHT || (10_000n * 10n ** 18n).toString();      // reward weight / staked WANTED (matches Saints)
const ROYALTY_BPS = process.env.WANTED_ROYALTY_BPS || "500"; // 5%
const EXPIRY_DAYS = Number(process.env.WANTED_EXPIRY_DAYS || "365"); // owner can reclaim unclaimed bounties after this

// tier ETH prices (recompute if ETH moves a lot; owner can also reset via setTokenPrices/setMintPrice)
const P_RARE = ethers.parseEther("0.01072"); // $20  — flat base (ids 17-21)
const P_EPIC = ethers.parseEther("0.01340"); // $25  (ids 12-16)
const P_LEGN = ethers.parseEther("0.01608"); // $30  (ids 8-11)
const P_MYTH = ethers.parseEther("0.01876"); // $35  (ids 1-7)

// token id -> bounty in whole $STAG (matches metadata; total 87,000)
const BOUNTY = { 1:6000,2:6000,3:6000,4:6000,5:6000,6:6000,7:6000, 8:5000,9:5000,10:5000,11:5000,
                 12:3000,13:3000,14:3000,15:3000,16:3000, 17:2000,18:2000,19:2000,20:2000,21:2000 };

async function main() {
  const [d] = await ethers.getSigners();
  console.log("deployer:", d.address, "\n");

  // 1) NFT
  const wanted = await (await ethers.getContractFactory("SherwoodWanted")).deploy(BASE_URI, SPLITTER, ROYALTY_BPS);
  await wanted.waitForDeployment();
  const wAddr = await wanted.getAddress();
  console.log("SherwoodWanted :", wAddr);

  // 2) splitter wire
  await (await wanted.setSplitter(SPLITTER)).wait();

  // 3) tiered prices: flat = Rare, overrides for the higher tiers
  await (await wanted.setMintPrice(P_RARE)).wait();
  const ids = [], prices = [];
  for (let i = 1; i <= 7; i++)  { ids.push(i); prices.push(P_MYTH); }
  for (let i = 8; i <= 11; i++) { ids.push(i); prices.push(P_LEGN); }
  for (let i = 12; i <= 16; i++){ ids.push(i); prices.push(P_EPIC); }
  // 17-21 use flat P_RARE (no override needed)
  await (await wanted.setTokenPrices(ids, prices)).wait();
  console.log("prices set: Rare 0.01072 / Epic 0.01340 / Legn 0.01608 / Myth 0.01876 ETH");

  // 4) bounty contract + bounties
  const now = Math.floor(Date.now() / 1000);
  const expiry = now + EXPIRY_DAYS * 86400;
  const bounty = await (await ethers.getContractFactory("WantedBounty")).deploy(STAG, wAddr, expiry);
  await bounty.waitForDeployment();
  const bAddr = await bounty.getAddress();
  console.log("WantedBounty   :", bAddr, "(expiry", new Date(expiry * 1000).toISOString().slice(0,10) + ")");

  const bids = Object.keys(BOUNTY).map(Number);
  const bamts = bids.map((i) => ethers.parseEther(String(BOUNTY[i]))); // $STAG has 18 decimals
  await (await bounty.setBounties(bids, bamts)).wait();
  const total = bids.reduce((s, i) => s + BOUNTY[i], 0);
  console.log(`bounties set: ${total.toLocaleString()} $STAG across ${bids.length} ids`);

  // 5) point WANTED's locker at the vault so lock-in-place staking works (deployer owns WANTED)
  await (await wanted.setLocker(VAULT)).wait();
  console.log("locker set to SherwoodVault:", VAULT);

  console.log("\n=== paste into js/hooded-config.js ===");
  console.log(`  wanted: '${wAddr}',`);
  console.log(`  wantedBounty: '${bAddr}',`);
  console.log("\n=== OWNER does these from the owner wallet ===");
  console.log(`  1. Fund bounty:  STAG.transfer(${bAddr}, ${total} * 1e18)   // ${total.toLocaleString()} $STAG — MUST fund the full total BEFORE step 2 (lock() now reverts if underfunded)`);
  console.log(`  2. Lock bounty:  WantedBounty(${bAddr}).lock()   // verifies balance >= ${total.toLocaleString()} $STAG, then freezes`);
  console.log(`  3. Add to Vault: SherwoodVault(${VAULT}).addCollection(${wAddr}, "${VAULT_WEIGHT}", true)   // LOCK-IN-PLACE (true) — NOT custody`);
  console.log(`  4. Go live:      SherwoodWanted(${wAddr}).setMintActive(true)`);
  console.log("\nVerify:");
  console.log(`  npx hardhat verify --network rhmainnet ${wAddr} "${BASE_URI}" ${SPLITTER} ${ROYALTY_BPS}`);
  console.log(`  npx hardhat verify --network rhmainnet ${bAddr} ${STAG} ${wAddr} ${expiry}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
