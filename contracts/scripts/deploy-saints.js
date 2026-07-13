/* Deploy Sherwood Saints (5x 1/1) + SaintsSplitter to Robinhood Chain (4663).
 *   SAINTS_BURN_SINK=0x... DEPLOYER_KEY=0x... npx hardhat run scripts/deploy-saints.js --network rhmainnet
 *
 * Deploys the splitter (60% buy-burn / 30% staking pool / 10% team), then the NFT, wires them,
 * and leaves mint INACTIVE (flip on at reveal via setMintActive(true)).
 * Keep DEPLOYER_KEY in your shell env ONLY — never commit a key.
 */
const { ethers } = require("hardhat");

const BASE_URI  = process.env.SAINTS_BASE_URI || "https://stagwifhood.fun/assets/nft/saints/metadata/";
const POOL      = process.env.SAINTS_POOL    || "0x2faA6672546912e7cDec4E1AaCF1eeF52bA524fF"; // StagStaking reward pool
const TEAM      = process.env.SAINTS_TEAM    || "0xb6A5059356332A0B222e9D21b1f72f3617d12516"; // team / admin
const BURN_SINK = process.env.SAINTS_BURN_SINK;                                                // buy-and-burn wallet (REQUIRED)
const ROYALTY_BPS = process.env.SAINTS_ROYALTY_BPS || "500"; // 5% secondary royalty
const BURN_BPS = "6000", POOL_BPS = "3000"; // 60 / 30 / (team = remainder 10)

async function main() {
  if (!BURN_SINK) throw new Error("set SAINTS_BURN_SINK to the buy-and-burn wallet address");
  for (const [n, a] of [["POOL", POOL], ["TEAM", TEAM], ["BURN_SINK", BURN_SINK]]) ethers.getAddress(a); // checksum guard

  const [deployer] = await ethers.getSigners();
  console.log("deployer:", deployer.address, "\n");

  const splitter = await (await ethers.getContractFactory("SaintsSplitter"))
    .deploy(BURN_SINK, POOL, TEAM, BURN_BPS, POOL_BPS);
  await splitter.waitForDeployment();
  const spAddr = await splitter.getAddress();
  console.log("SaintsSplitter :", spAddr, `(${BURN_BPS/100}% burn / ${POOL_BPS/100}% pool / ${(10000-BURN_BPS-POOL_BPS)/100}% team)`);

  // royalties route through the splitter too, so secondary sales also feed burn/pool/team
  const saints = await (await ethers.getContractFactory("SherwoodSaints"))
    .deploy(BASE_URI, spAddr, ROYALTY_BPS);
  await saints.waitForDeployment();
  const nAddr = await saints.getAddress();
  console.log("SherwoodSaints :", nAddr);

  await (await saints.setSplitter(spAddr)).wait();
  console.log("wired splitter; mint is INACTIVE — call setMintActive(true) at reveal.");
  console.log("\nNext: set window.SAINTS_ADDRESS on the site, then verify:");
  console.log(`  npx hardhat verify --network rhmainnet ${spAddr} ${BURN_SINK} ${POOL} ${TEAM} ${BURN_BPS} ${POOL_BPS}`);
  console.log(`  npx hardhat verify --network rhmainnet ${nAddr} "${BASE_URI}" ${spAddr} ${ROYALTY_BPS}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
