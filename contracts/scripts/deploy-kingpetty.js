/* Deploy KingPetty (200-supply edition) to Robinhood Chain (4663) and FREE-mint a batch to you.
 *
 *   DEPLOYER_KEY=0x... npx hardhat run scripts/deploy-kingpetty.js --network rhmainnet
 *
 * Env (all optional):
 *   KP_IMAGE  art URL          (default: hidden path on stagwifhood.fun)
 *   KP_MINT   how many to mint  (default: 20)  — free, straight to your wallet
 *   KP_TO     recipient         (default: the deployer = you)
 *
 * You end up owning the batch and can send them to any wallet. Mint more anytime via ownerMint().
 */
const { ethers } = require("hardhat");

const IMG = process.env.KP_IMAGE || "https://stagwifhood.fun/assets/nft/hidden/kp.png";
const QTY = parseInt(process.env.KP_MINT || "20", 10);
const DEFAULT_TO = "0x51260cc90bf184a7d1c67151d178405333e4bc17"; // your wallet — free mints go here

async function main() {
  const [d] = await ethers.getSigners();
  console.log("deployer / owner:", d.address);

  const kp = await (await ethers.getContractFactory("KingPetty")).deploy(IMG);
  await kp.waitForDeployment();
  const addr = await kp.getAddress();
  console.log("KingPetty deployed:", addr);
  console.log("art:", IMG);

  const to = process.env.KP_TO || DEFAULT_TO || d.address;
  if (QTY > 0) {
    await (await kp.ownerMint(to, QTY)).wait();
    console.log(`✅ free-minted ${QTY} → ${to}   (total ${await kp.totalMinted()}/200)`);
  }

  console.log("\nNext:");
  console.log("  • Send one: transfer from your wallet in any explorer/wallet app.");
  console.log("  • Mint more free later: ownerMint(yourAddress, qty)");
  console.log("  • Hidden mint page: put this address in kp.html →  const CONTRACT = \"" + addr + "\";");
  console.log("  • Verify: npx hardhat verify --network rhmainnet " + addr + " \"" + IMG + "\"");
}
main().catch((e) => { console.error(e); process.exit(1); });
