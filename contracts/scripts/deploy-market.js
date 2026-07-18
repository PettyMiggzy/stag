/* Deploy SherwoodMarket (P2P token exchange) to Robinhood Chain (4663).
 *   DEPLOYER_KEY=0x... npx hardhat run scripts/deploy-market.js --network rhmainnet
 * Fees (1% buy / 1% sell) route to the $STAG marketing wallet. Owner can retune fees (cap 3%) + wallet.
 */
const { ethers } = require("hardhat");
const FEE_WALLET = process.env.MARKET_FEE_WALLET || "0x1bd6aef559546a7ce8fdb269926dddb4284a8b6d"; // $STAG marketing wallet

async function main() {
  ethers.getAddress(FEE_WALLET); // checksum guard
  const [d] = await ethers.getSigners();
  console.log("deployer:", d.address);
  const market = await (await ethers.getContractFactory("SherwoodMarket")).deploy(FEE_WALLET);
  await market.waitForDeployment();
  const addr = await market.getAddress();
  console.log("SherwoodMarket:", addr, "| feeWallet:", FEE_WALLET, "| fees: 1% buy / 1% sell");
  console.log("\nPaste into js/hooded-config.js:  market: '" + addr + "',");
  console.log("Verify:  npx hardhat verify --network rhmainnet " + addr + " " + FEE_WALLET);
}
main().catch((e) => { console.error(e); process.exit(1); });
