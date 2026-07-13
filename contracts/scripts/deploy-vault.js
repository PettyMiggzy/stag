/* Deploy SherwoodVault (future-proof NFT staking) to Robinhood Chain (4663).
 *   DEPLOYER_KEY=0x... npx hardhat run scripts/deploy-vault.js --network rhmainnet
 *
 * Deploys the vault and registers the Sherwood Saints as a CUSTODY-staking collection (Saints have
 * no lock hooks, so staking = deposit-to-earn). Future collections: addCollection(nft, weight, mode)
 * — lock-in-place for any drop that ships with lock()/unlock(). Runs ALONGSIDE StagStaking.
 *
 * After deploy: fund the pool (donate / send ETH) then stream it with notifyRewardAmount(amount, secs).
 * Keep DEPLOYER_KEY in your shell env ONLY — never commit a key.
 */
const { ethers } = require("hardhat");

const ADMIN  = process.env.VAULT_ADMIN  || "0xb6A5059356332A0B222e9D21b1f72f3617d12516"; // owner
const SAINTS = process.env.VAULT_SAINTS || "0x5c309bC7D137cA4c5AC450B68D1A1d896eF28327"; // SherwoodSaints
const SAINT_WEIGHT = process.env.VAULT_SAINT_WEIGHT || (10_000n * 10n ** 18n).toString(); // reward weight / Saint
const REGISTER_SAINTS = (process.env.VAULT_REGISTER_SAINTS || "true") === "true";

async function main() {
  ethers.getAddress(ADMIN); if (REGISTER_SAINTS) ethers.getAddress(SAINTS);
  const [deployer] = await ethers.getSigners();
  console.log("deployer:", deployer.address, "\n");

  const vault = await (await ethers.getContractFactory("SherwoodVault")).deploy(ADMIN);
  await vault.waitForDeployment();
  const addr = await vault.getAddress();
  console.log("SherwoodVault :", addr, "(owner:", ADMIN + ")");

  if (REGISTER_SAINTS) {
    // Saints = custody staking (lockInPlace=false), since SherwoodSaints has no lock()/unlock().
    // Only works if the deployer is the admin/owner (addCollection is onlyOwner).
    try {
      await (await vault.addCollection(SAINTS, SAINT_WEIGHT, false)).wait();
      console.log("registered Sherwood Saints (custody), weight", SAINT_WEIGHT);
    } catch (e) {
      console.log("\n⚠ could not register (deployer != admin). From the ADMIN wallet call:");
      console.log(`  addCollection("${SAINTS}", "${SAINT_WEIGHT}", false)\n`);
    }
  }

  console.log("\nNext:");
  console.log(" 1. Fund the pool: send ETH to the vault (or call donate{value}).");
  console.log(" 2. Stream it: notifyRewardAmount(amount, durationSecs).");
  console.log(" 3. Set window.HOODED.vault on the site to", addr);
  console.log(" 4. Verify:  npx hardhat verify --network rhmainnet", addr, ADMIN);
}
main().catch((e) => { console.error(e); process.exit(1); });
