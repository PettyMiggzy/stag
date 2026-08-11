/* Deploy the Kid & Walt x STAG (50-piece) stack to Robinhood Chain (mainnet 4663).
 *
 *   RH_RPC_URL=... DEPLOYER_KEY=0x... npx hardhat run scripts/deploy-kwstag50.js --network rhmainnet
 *
 * Deploys KidWaltStag50 + its OWN StagStaking instance (StagStaking.hood is IMMUTABLE) + its own
 * RevenueSplitter (90% -> KW50 staking pool / 10% -> owner), wires the splitter<->staking<->NFT cycle,
 * then sets per-token nftBoostBps from the contract's rarity map (Common+10% .. Mythic+50%).
 * baseURI comes from deploy.config.json kidWaltStag50.baseURI (the IPFS metadata folder CID).
 * Writes contracts/deployed-kwstag50.json.
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deploy.config.json"), "utf8"));
const E = (n) => ethers.parseEther(String(n));
const TN = ["Common", "Rare", "Epic", "Legendary", "Mythic"];

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`network: ${network.name}  deployer: ${deployer.address}`);
  console.log(`balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH\n`);

  const k = CFG.kidWaltStag50, stag = CFG.stagToken;
  if (!k) throw new Error("deploy.config.json missing kidWaltStag50 block");
  if (!k.baseURI || !k.baseURI.endsWith("/")) throw new Error("kidWaltStag50.baseURI must end with '/'");

  const splitterOwner = ethers.getAddress(CFG.revenueSplitter.owner);
  ethers.getAddress(stag);
  const admin = CFG._admin ? ethers.getAddress(CFG._admin) : null;
  if (k.poolBps !== 9000) throw new Error(`kidWaltStag50.poolBps must be 9000 (got ${k.poolBps})`);
  const supply = 50;
  console.log(`validated: baseURI ${k.baseURI}\n           KW50 splitter 90/10 -> pool / ${splitterOwner}; admin ${admin || "(deployer)"}\n`);

  // 1. NFT
  const KW = await ethers.getContractFactory("KidWaltStag50");
  const nft = await KW.deploy(k.baseURI, ethers.ZeroAddress, k.royaltyBps);
  await nft.waitForDeployment();
  const nftAddr = await nft.getAddress();
  console.log("KidWaltStag50     ", nftAddr);

  // 2. dedicated staking (hood = NFT)
  const staking = await (await ethers.getContractFactory("StagStaking")).deploy(stag, nftAddr);
  await staking.waitForDeployment();
  const stakingAddr = await staking.getAddress();
  console.log("StagStaking (KW50)", stakingAddr);

  // 3. dedicated splitter: 90% -> staking pool, 10% -> owner
  const splitter = await (await ethers.getContractFactory("RevenueSplitter")).deploy(stakingAddr, splitterOwner, k.poolBps);
  await splitter.waitForDeployment();
  const splitterAddr = await splitter.getAddress();
  console.log("RevenueSplitter   ", splitterAddr);

  // 4. wire NFT
  await (await nft.setSplitter(splitterAddr)).wait();
  await (await nft.setRoyalty(splitterAddr, k.royaltyBps)).wait();
  await (await nft.setLocker(stakingAddr)).wait();
  if (k.maxPerWallet) await (await nft.setMaxPerWallet(k.maxPerWallet)).wait();
  if (k.tierPriceEth && k.tierWeight) {
    for (let t = 0; t < 5; t++) {
      await (await nft.setTierPrice(t, E(k.tierPriceEth[TN[t]]))).wait();
      await (await nft.setTierWeight(t, BigInt(k.tierWeight[TN[t]]))).wait();
    }
    await (await nft.setRandomPrice(E(k.randomPriceEth))).wait();
  }
  console.log("wired NFT -> splitter / royalty / locker / prices");

  // 5. per-token staking boosts from boostBpsOf(id)
  for (let id = 1; id <= supply; id++) {
    const bps = await nft.boostBpsOf(id);
    await (await staking.setNftBoostBps(id, bps)).wait();
  }
  console.log("wired per-token staking boosts (1..50)");

  // 6. free-mint allowlist
  for (const w of (k.freeMintAllowlist || [])) {
    ethers.getAddress(w.wallet);
    await (await nft.grantFreeMints(w.wallet, w.count)).wait();
    console.log(`granted ${w.count} free mints -> ${w.wallet}`);
  }

  // 7. hand to admin (LAST)
  let ownerAddr = deployer.address;
  if (admin && admin.toLowerCase() !== deployer.address.toLowerCase()) {
    await (await staking.setPenaltyRecipient(admin)).wait();
    await (await nft.transferOwnership(admin)).wait();
    await (await staking.transferOwnership(admin)).wait();
    ownerAddr = admin;
    console.log(`ownership + penaltyRecipient -> admin ${admin}`);
  }

  const out = {
    chainId: CFG.chain.id, network: "Robinhood Chain mainnet", collection: "Kid & Walt x STAG (50)",
    deployer: deployer.address, owner: ownerAddr, poolBps: k.poolBps, splitterOwner, baseURI: k.baseURI,
    KidWaltStag50: nftAddr, StagStaking_KW50: stakingAddr, RevenueSplitter_KW50: splitterAddr, stag,
  };
  fs.writeFileSync(path.join(__dirname, "..", "deployed-kwstag50.json"), JSON.stringify(out, null, 2) + "\n");
  console.log("\nwrote deployed-kwstag50.json");
  console.log("NEXT (from the owner wallet): 1) fund the KW50 staking pool + notifyRewardAmount  2) nft.setMintActive(true)");
  console.log(`  mint=${nftAddr}  staking=${stakingAddr}  splitter=${splitterAddr}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
