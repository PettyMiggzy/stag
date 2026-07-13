// Deploy StagLocker to Robinhood Chain.
//   DEPLOYER_KEY=0x... npx hardhat run scripts/deploy.js --network robinhood
// Keep DEPLOYER_KEY in your shell env ONLY - never commit it.
const { ethers } = require("hardhat");

// Robinhood Chain Uniswap V3 NonfungiblePositionManager (address(0) to disable V3 locks).
const POSITION_MANAGER = process.env.LOCKER_PM || "0x73991a25c818bf1f1128deaab1492d45638de0d3";
// Flat creation fee in wei — set to ~$20 in ETH at launch (e.g. ~0.0067 ETH ≈ $20 at $3k/ETH).
// Holders of >= 5M $STAG pay 0 (see fee waiver below); everyone else pays this.
const FLAT_FEE_WEI = process.env.LOCKER_FEE_WEI || "6700000000000000"; // ~0.0067 ETH ≈ $20
const FEE_RECIPIENT = process.env.LOCKER_TREASURY;      // required: where fees go
const ADMIN = process.env.LOCKER_ADMIN;                 // required: fee control only
// Fee waiver: hold >= this much $STAG → lock for free.
const STAG = process.env.LOCKER_STAG || "0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49";
const STAG_MIN = process.env.LOCKER_STAG_MIN || (5_000_000n * 10n ** 18n).toString(); // 5M $STAG

async function main() {
  if (!FEE_RECIPIENT || !ADMIN) throw new Error("set LOCKER_TREASURY and LOCKER_ADMIN env vars");
  const Locker = await ethers.getContractFactory("StagLocker");
  const locker = await Locker.deploy(POSITION_MANAGER, FLAT_FEE_WEI, FEE_RECIPIENT, ADMIN);
  await locker.waitForDeployment();
  const addr = await locker.getAddress();
  console.log("StagLocker deployed:", addr);
  // wire the hold-to-lock-free waiver (5M $STAG). onlyOwner — works only if you deploy
  // FROM the admin key; otherwise call setFeeExemption(STAG, STAG_MIN) from the admin wallet.
  try {
    await (await locker.setFeeExemption(STAG, STAG_MIN)).wait();
    console.log(`fee waiver set: hold >= ${STAG_MIN} of ${STAG} → free`);
  } catch (e) {
    console.log(`\n⚠ could not set fee waiver (deployer != admin). From the ADMIN wallet, call:`);
    console.log(`  StagLocker(${addr}).setFeeExemption("${STAG}", "${STAG_MIN}")\n`);
  }
  console.log("Verify: npx hardhat verify --network robinhood", addr, POSITION_MANAGER, FLAT_FEE_WEI, FEE_RECIPIENT, ADMIN);
}
main().catch((e) => { console.error(e); process.exit(1); });
