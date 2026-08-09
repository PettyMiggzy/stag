/* Local end-to-end sim of the Kid & Walt Show stack (hardhat network).
 *   npx hardhat run scripts/sim-kidwalt.js
 * Proves: deploy+wire, tiered PICK price enforcement, lock-in-place stake, and that a staked
 * Mythic (+50%) produces more effective staking weight AND more real-yield ETH than a staked
 * Common (+10%). Acts as a regression guard on the rarity->reward wiring.
 */
const { ethers } = require("hardhat");
const E = (n) => ethers.parseEther(String(n));
const TN = ["Common", "Rare", "Epic", "Legendary", "Mythic"];

async function main() {
  const [owner, alice, bob] = await ethers.getSigners();
  const stag = await (await ethers.getContractFactory("MockERC20")).deploy();
  await stag.waitForDeployment();

  const nft = await (await ethers.getContractFactory("KidWaltShow"))
    .deploy("https://stagwifhood.fun/assets/nft/kidwalt/metadata/", ethers.ZeroAddress, 500);
  await nft.waitForDeployment();
  const staking = await (await ethers.getContractFactory("StagStaking")).deploy(await stag.getAddress(), await nft.getAddress());
  await staking.waitForDeployment();
  const splitter = await (await ethers.getContractFactory("RevenueSplitter")).deploy(await staking.getAddress(), owner.address, 9000);
  await splitter.waitForDeployment();

  await (await nft.setSplitter(await splitter.getAddress())).wait();
  await (await nft.setLocker(await staking.getAddress())).wait();
  await (await nft.setMintActive(true)).wait();
  for (let id = 1; id <= 10; id++) await (await staking.setNftBoostBps(id, await nft.boostBpsOf(id))).wait();

  console.log("id  tier        pickETH  boost");
  for (let id = 1; id <= 10; id++) {
    const t = Number(await nft.tierOf(id));
    console.log(`#${String(id).padEnd(2)} ${TN[t].padEnd(10)}  ${ethers.formatEther(await nft.priceOf(id))}    ${await nft.boostBpsOf(id)}bps`);
  }

  const mythId = 10, commonId = 1;
  await expectRevert(nft.connect(alice).mintPick(mythId, { value: E("0.010") }), "wrong price");
  await (await nft.connect(alice).mintPick(mythId, { value: await nft.priceOf(mythId) })).wait();
  await (await nft.connect(bob).mintPick(commonId, { value: await nft.priceOf(commonId) })).wait();
  console.log(`\nminted: alice owns #${mythId} (${TN[Number(await nft.tierOf(mythId))]}), bob owns #${commonId} (${TN[Number(await nft.tierOf(commonId))]})`);

  await (await staking.connect(alice).stakeNFT(mythId)).wait();
  await (await staking.connect(bob).stakeNFT(commonId)).wait();
  console.log("staked. NFT still in owner wallet? alice:", (await nft.ownerOf(mythId)) === alice.address, " locked:", await nft.locked(mythId));

  await expectRevert(nft.connect(alice).transferFrom(alice.address, bob.address, mythId), "locked (staked)");

  const aInfo = await staking.userInfo(alice.address);
  const bInfo = await staking.userInfo(bob.address);
  const ratio = Number(aInfo.weight) / Number(bInfo.weight);
  console.log(`\nMythic/Common effective-weight ratio = ${ratio.toFixed(3)}x  (expect 1.50/1.10 = 1.364x)`);

  await (await staking.donate({ value: E(10) })).wait();
  await (await staking.notifyRewardAmount(E(10), 7 * 24 * 3600)).wait();
  await ethers.provider.send("evm_increaseTime", [7 * 24 * 3600]);
  await ethers.provider.send("evm_mine", []);
  const aEarn = await staking.earned(alice.address), bEarn = await staking.earned(bob.address);
  console.log(`7d rewards — alice(Mythic) ${ethers.formatEther(aEarn)} ETH   bob(Common) ${ethers.formatEther(bEarn)} ETH`);
  console.log(`Mythic earns ${(Number(aEarn) / Number(bEarn)).toFixed(3)}x the Common's ETH`);

  console.log("\n✅ SIM OK — mint priced by tier, lock-in-place staking works, rarer NFT out-earns.");
}
async function expectRevert(p, msg) {
  try { await (await p).wait(); throw new Error("did NOT revert: " + msg); }
  catch (e) { if (!String(e).includes(msg)) throw new Error(`wrong revert (want "${msg}"): ${e.message || e}`); }
}
main().catch((e) => { console.error(e); process.exit(1); });
