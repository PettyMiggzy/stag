/* Deploy SherwoodOrders (limit / stop-loss / take-profit) to Robinhood Chain (4663).
 *   DEPLOYER_KEY=0x... npx hardhat run scripts/deploy-orders.js --network rhmainnet
 * Fills route via the on-chain Uniswap V3 router; 1% fee -> marketing wallet.
 * Ownership hands off to the dev wallet after deploy.
 */
const { ethers } = require("hardhat");
const ROUTER  = "0xCaf681a66D020601342297493863E78C959E5cb2"; // Uniswap SwapRouter02
const WETH    = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"; // WETH9
const FEE_WALLET = process.env.ORDERS_FEE_WALLET || "0x1bd6aef559546a7ce8fdb269926dddb4284a8b6d"; // $STAG marketing
const NEW_OWNER  = process.env.ORDERS_NEW_OWNER  || "0x5db7ca9d2ce3f414b3fd94ec0fcaf9f3ab1a575f"; // dev wallet

async function main() {
  [ROUTER, WETH, FEE_WALLET, NEW_OWNER].forEach((a) => ethers.getAddress(a));
  const [d] = await ethers.getSigners();
  console.log("deployer:", d.address);
  const orders = await (await ethers.getContractFactory("SherwoodOrders")).deploy(ROUTER, WETH, FEE_WALLET);
  await orders.waitForDeployment();
  const addr = await orders.getAddress();
  console.log("SherwoodOrders:", addr, "| feeWallet:", FEE_WALLET, "| fee: 1% (cap 3%)");
  await (await orders.transferOwnership(NEW_OWNER)).wait();
  console.log("ownership transferred to:", NEW_OWNER, "| owner now:", await orders.owner());
  console.log("\nPaste into js/hooded-config.js:  orders: '" + addr + "',");
  console.log("Verify:  npx hardhat verify --network rhmainnet " + addr + " " + ROUTER + " " + WETH + " " + FEE_WALLET);
}
main().catch((e) => { console.error(e); process.exit(1); });
