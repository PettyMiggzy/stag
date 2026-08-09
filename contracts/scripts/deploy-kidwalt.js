/* Deploy the Kid & Walt Show stack to Robinhood Chain (mainnet 4663).
 *
 *   RH_RPC_URL=... DEPLOYER_KEY=0x... npx hardhat run scripts/deploy-kidwalt.js --network rhmainnet
 *
 * Kid & Walt Show is a 10-piece $STAG partner drop. It gets its OWN staking
 * instance + splitter because StagStaking.hood is IMMUTABLE (the deployed Hooded 20 staker can't take
 * a second NFT). Wiring order resolves the splitter <-> staking <-> NFT cycle, then per-token reward
 * boosts are set from the contract's rarity map so a staked Mythic out-earns a staked Common.
 *
 *   1. KidWaltShow (splitter set later)      2. StagStaking (hood = KidWaltShow)
 *   3. RevenueSplitter (pool = KW staking)   4. wire NFT: splitter, royalty, locker, prices/weights
 *   5. set per-token nftBoostBps = boostBpsOf(id)   6. free-mint allowlist   7. hand to admin (LAST)
 * Writes contracts/deployed-kidwalt.json.
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

  const k = CFG.kidWaltShow, stag = CFG.stagToken;
  if (!k) throw new Error("deploy.config.json missing kidWaltShow block");

  // ---- pre-flight: immutable/misroute footguns are unrecoverable ----
  const splitterOwner = ethers.getAddress(CFG.revenueSplitter.owner); // reuse the same 90/10 owner as Hooded
  ethers.getAddress(stag);
  const admin = CFG._admin ? ethers.getAddress(CFG._admin) : null;
  if (k.poolBps !== 9000) throw new Error(`kidWaltShow.poolBps must be 9000 (got ${k.poolBps}) — split is IMMUTABLE`);
  const supply = 10;
  for (const w of (k.freeMintAllowlist || [])) {
    ethers.getAddress(w.wallet);
    if (w.count > 2) throw new Error(`freeMintAllowlist ${w.wallet} count ${w.count} too high for a 10-piece drop`);
  }
  console.log(`validated: KW splitter 90/10 -> pool / ${splitterOwner}; admin ${admin || "(deployer)"}\n`);

  // 1. NFT (splitter wired in step 4)
  const KW = await ethers.getContractFactory("KidWaltShow");
  const nft = await KW.deploy(k.baseURI, ethers.ZeroAddress, k.royaltyBps);
  await nft.waitForDeployment();
  const nftAddr = await nft.getAddress();
  console.log("KidWaltShow      ", nftAddr);

  // 2. dedicated staking (hood = KidWaltShow)
  const Staking = await ethers.getContractFactory("StagStaking");
  const staking = await Staking.deploy(stag, nftAddr);
  await staking.waitForDeployment();
  const stakingAddr = await staking.getAddress();
  console.log("StagStaking (KW) ", stakingAddr);

  // 3. dedicated splitter: 90% -> KW staking pool, 10% -> owner
  const Splitter = await ethers.getContractFactory("RevenueSplitter");
  const splitter = await Splitter.deploy(stakingAddr, splitterOwner, k.poolBps);
  await splitter.waitForDeployment();
  const splitterAddr = await splitter.getAddress();
  console.log("RevenueSplitter  ", splitterAddr);

  // 4. wire the NFT
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

  // 5. rarity -> staking reward boost: set nftBoostBps for every token from the contract's map.
  //    A staked Mythic (+50%) out-earns a staked Common (+10%). This is the utility floor.
  for (let id = 1; id <= supply; id++) {
    const bps = await nft.boostBpsOf(id);
    await (await staking.setNftBoostBps(id, bps)).wait();
    console.log(`  boost #${id} (${TN[await nft.tierOf(id)]}) -> ${bps} bps`);
  }
  console.log("wired per-token staking boosts");

  // 6. free-mint allowlist
  for (const w of (k.freeMintAllowlist || [])) {
    await (await nft.grantFreeMints(w.wallet, w.count)).wait();
    console.log(`granted ${w.count} free mints -> ${w.wallet}`);
  }

  // 7. hand control to admin/backend (LAST — deployer loses owner rights)
  let ownerAddr = deployer.address;
  if (admin && admin.toLowerCase() !== deployer.address.toLowerCase()) {
    await (await staking.setPenaltyRecipient(admin)).wait();
    await (await nft.transferOwnership(admin)).wait();
    await (await staking.transferOwnership(admin)).wait();
    ownerAddr = admin;
    console.log(`ownership + penaltyRecipient -> admin ${admin}`);
  }

  const out = {
    chainId: CFG.chain.id, network: "Robinhood Chain mainnet", collection: "Kid & Walt Show",
    deployer: deployer.address, owner: ownerAddr, poolBps: k.poolBps, splitterOwner,
    KidWaltShow: nftAddr, StagStaking_KW: stakingAddr, RevenueSplitter_KW: splitterAddr, stag,
    _note: "Dedicated staking + splitter (StagStaking.hood is immutable, cannot reuse the Hooded 20 staker). Per-token nftBoostBps set from boostBpsOf(id): Common+10% Rare+20% Epic+30% Legendary+40% Mythic+50%.",
  };
  fs.writeFileSync(path.join(__dirname, "..", "deployed-kidwalt.json"), JSON.stringify(out, null, 2) + "\n");
  console.log("\nwrote deployed-kidwalt.json\n");
  console.log("NEXT (from /admin, connect the OWNER wallet):");
  console.log("  1. fund the KW staking pool + notifyRewardAmount   2. nft.setMintActive(true)");
  console.log(`  mint=${nftAddr}  staking=${stakingAddr}  splitter=${splitterAddr}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
