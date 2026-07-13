// Deploy StagLocker to Robinhood Chain.
//   DEPLOYER_KEY=0x... npx hardhat run scripts/deploy.js --network robinhood
// Keep DEPLOYER_KEY in your shell env ONLY - never commit it.
const { ethers } = require("hardhat");

// Robinhood Chain Uniswap V3 NonfungiblePositionManager (address(0) to disable V3 locks).
const POSITION_MANAGER = process.env.LOCKER_PM || "0x73991a25c818bf1f1128deaab1492d45638de0d3";
// Cost model: NO ETH fee — instead BURN $STAG scaled by lock duration (2M per 30 days), and
// holders of >= 10M $STAG lock for FREE (no burn). ETH flat fee left at 0 (admin can add one).
const FLAT_FEE_WEI = process.env.LOCKER_FEE_WEI || "0";
const FEE_RECIPIENT = process.env.LOCKER_TREASURY;      // required: where any ETH fees go
const ADMIN = process.env.LOCKER_ADMIN;                 // required: fee/burn control only
const STAG = process.env.LOCKER_STAG || "0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49";
const FREE_MIN = process.env.LOCKER_FREE_MIN || (10_000_000n * 10n ** 18n).toString(); // 10M $STAG → free
const BURN_PER = process.env.LOCKER_BURN_PER || (2_000_000n * 10n ** 18n).toString();   // 2M $STAG...
const BURN_PERIOD = process.env.LOCKER_BURN_PERIOD || (30 * 24 * 60 * 60).toString();   // ...per 30 days

async function main() {
  if (!FEE_RECIPIENT || !ADMIN) throw new Error("set LOCKER_TREASURY and LOCKER_ADMIN env vars");
  const Locker = await ethers.getContractFactory("StagLocker");
  const locker = await Locker.deploy(POSITION_MANAGER, FLAT_FEE_WEI, FEE_RECIPIENT, ADMIN);
  await locker.waitForDeployment();
  const addr = await locker.getAddress();
  console.log("StagLocker deployed:", addr);
  // wire the burn/waiver config. onlyOwner — works only if you deploy FROM the admin key.
  try {
    await (await locker.setFeeExemption(STAG, FREE_MIN)).wait();     // hold >= 10M $STAG → free
    await (await locker.setBurnConfig(BURN_PER, BURN_PERIOD)).wait(); // else burn 2M $STAG / 30 days
    console.log(`configured: free >= ${FREE_MIN} $STAG; else burn ${BURN_PER} per ${BURN_PERIOD}s of lock`);
  } catch (e) {
    console.log(`\n⚠ could not configure (deployer != admin). From the ADMIN wallet, call:`);
    console.log(`  setFeeExemption("${STAG}", "${FREE_MIN}")  then  setBurnConfig("${BURN_PER}", "${BURN_PERIOD}")\n`);
  }
  console.log("Verify: npx hardhat verify --network robinhood", addr, POSITION_MANAGER, FLAT_FEE_WEI, FEE_RECIPIENT, ADMIN);
}
main().catch((e) => { console.error(e); process.exit(1); });
