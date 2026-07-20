/* Arm the WANTED launch — run AFTER deploy-wanted.js, from the OWNER wallet.
 *   npx hardhat run scripts/finish-wanted.js --network rhmainnet
 *
 * Does the 4 owner-only go-live steps, in the safe order, each idempotent (skips if already done):
 *   1. Fund   — transfer the full 87,000 $STAG bounty total into WantedBounty
 *   2. Lock   — WantedBounty.lock()  (reverts unless fully funded — safety net)
 *   3. Vault  — SherwoodVault.addCollection(WANTED, weight, lockInPlace=TRUE)  (staking; only if this wallet owns the vault)
 *   4. Live   — SherwoodWanted.setMintActive(true)   ← mint opens LAST, after the bounty is real
 *
 * Refuses to run if this wallet isn't the owner of the contracts it configures.
 */
const { ethers } = require("hardhat");

const WANTED = process.env.WANTED_ADDR        || "0x35c57109217319Df9feF0499F56b3f6a68d50931";
const BOUNTY = process.env.WANTED_BOUNTY_ADDR || "0x5b0038579c066447Bc23AD7819D77FbC9cF146da";
const VAULT  = process.env.WANTED_VAULT       || "0x9eeE6eFe6540C3e3AC515D052c99ad4b389a344c";
const STAG   = "0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49";
const WEIGHT = process.env.WANTED_VAULT_WEIGHT || (10_000n * 10n ** 18n).toString();

const stagAbi   = ["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];
const bountyAbi = ["function lock()", "function locked() view returns (bool)", "function totalBounty() view returns (uint256)", "function owner() view returns (address)"];
const vaultAbi  = ["function addCollection(address,uint256,bool)", "function collections(address) view returns (bool known,bool enabled,bool lockInPlace,uint256 weight)", "function owner() view returns (address)"];
const wantedAbi = ["function setMintActive(bool)", "function mintActive() view returns (bool)", "function owner() view returns (address)"];

const eq = (a, b) => a.toLowerCase() === b.toLowerCase();

async function main() {
  const [d] = await ethers.getSigners();
  console.log("owner wallet :", d.address, "\n");

  const stag   = new ethers.Contract(STAG,   stagAbi,   d);
  const bounty = new ethers.Contract(BOUNTY, bountyAbi, d);
  const vault  = new ethers.Contract(VAULT,  vaultAbi,  d);
  const wanted = new ethers.Contract(WANTED, wantedAbi, d);

  // ownership sanity — never run against contracts you don't control
  const [bOwner, vOwner, wOwner] = await Promise.all([bounty.owner(), vault.owner(), wanted.owner()]);
  if (!eq(bOwner, d.address)) throw new Error(`you are not the WantedBounty owner (owner is ${bOwner})`);
  if (!eq(wOwner, d.address)) throw new Error(`you are not the SherwoodWanted owner (owner is ${wOwner})`);
  const ownsVault = eq(vOwner, d.address);

  const total = await bounty.totalBounty();
  console.log("bounty total :", ethers.formatEther(total), "$STAG\n");

  // 1) FUND
  const held = await stag.balanceOf(BOUNTY);
  if (held >= total) {
    console.log(`1) fund   : already holds ${ethers.formatEther(held)} $STAG — skip`);
  } else {
    const need = total - held;
    const bal = await stag.balanceOf(d.address);
    if (bal < need) throw new Error(`not enough $STAG in your wallet: need ${ethers.formatEther(need)} more, you have ${ethers.formatEther(bal)}`);
    console.log(`1) fund   : sending ${ethers.formatEther(need)} $STAG to the bounty…`);
    await (await stag.transfer(BOUNTY, need)).wait();
    console.log("            funded ✓");
  }

  // 2) LOCK
  if (await bounty.locked()) console.log("2) lock   : already locked — skip");
  else { console.log("2) lock   : locking the bounty…"); await (await bounty.lock()).wait(); console.log("            locked ✓"); }

  // 3) VAULT (staking) — lock-in-place
  if (ownsVault) {
    const c = await vault.collections(WANTED);
    if (c.known && c.enabled && c.lockInPlace) {
      console.log("3) vault  : WANTED already added (lock-in-place) — skip");
    } else {
      console.log("3) vault  : addCollection(WANTED, weight, lockInPlace=TRUE)…");
      await (await vault.addCollection(WANTED, WEIGHT, true)).wait();
      console.log("            added ✓");
    }
  } else {
    console.log(`3) vault  : SKIPPED — vault owner is ${vOwner}. Run addCollection(${WANTED}, "${WEIGHT}", true) from that wallet.`);
  }

  // 4) GO LIVE — last
  if (await wanted.mintActive()) console.log("4) live   : mint already active — skip");
  else { console.log("4) live   : opening the mint…"); await (await wanted.setMintActive(true)).wait(); console.log("            MINT IS LIVE ✓"); }

  console.log("\n✅ WANTED is armed: 87,000 $STAG funded + locked, staking wired, mint open." + (ownsVault ? "" : "  (finish step 3 from the vault owner wallet)"));
}
main().catch((e) => { console.error("\n❌", e.message || e); process.exit(1); });
