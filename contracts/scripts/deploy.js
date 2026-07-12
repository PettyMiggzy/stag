/* Deploy The Hooded 20 stack to Robinhood Chain (mainnet 4663).
 *
 *   RH_RPC_URL=... DEPLOYER_KEY=0x... npx hardhat run scripts/deploy.js --network rhmainnet
 *
 * Order resolves the splitter <-> staking <-> NFT cycle:
 *   1. HoodedTwenty (splitter set later)   2. StagStaking (needs NFT addr)
 *   3. RevenueSplitter (pool = staking)     4. wire NFT: splitter, royalty, locker
 *   5. SherwoodPact                         6. grant free mints to the whitelist
 * Writes contracts/deployed.json with every address.
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deploy.config.json"), "utf8"));
const E = (n) => ethers.parseEther(String(n));

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`network: ${network.name}  deployer: ${deployer.address}`);
  console.log(`balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH\n`);

  const h = CFG.hoodedTwenty, rs = CFG.revenueSplitter, stag = CFG.stagToken;
  const TN = ["Common", "Rare", "Epic", "Legendary", "Mythic"];

  // ---- pre-flight validation: immutable/misroute footguns are unrecoverable ----
  const splitterOwner = ethers.getAddress(rs.owner);        // throws on bad checksum
  ethers.getAddress(stag);
  const admin = CFG._admin ? ethers.getAddress(CFG._admin) : null;
  if (rs.poolBps !== 9000) throw new Error(`revenueSplitter.poolBps must be 9000 (got ${rs.poolBps}) — split is IMMUTABLE`);
  for (const w of (h.freeMintAllowlist || [])) {
    ethers.getAddress(w.wallet);
    if (w.count > 5) throw new Error(`freeMintAllowlist ${w.wallet} count ${w.count} too high — free mints bypass the cap and can pick rares`);
  }
  console.log(`validated: splitter 90/10 -> pool / ${splitterOwner}; admin ${admin || "(deployer)"}\n`);

  // 1. NFT (splitter wired in step 4)
  const Hooded = await ethers.getContractFactory("HoodedTwenty");
  const hood = await Hooded.deploy(h.baseURI, ethers.ZeroAddress, h.royaltyBps);
  await hood.waitForDeployment();
  const hoodAddr = await hood.getAddress();
  console.log("HoodedTwenty     ", hoodAddr);

  // 2. Staking (reward pool)
  const Staking = await ethers.getContractFactory("StagStaking");
  const staking = await Staking.deploy(stag, hoodAddr);
  await staking.waitForDeployment();
  const stakingAddr = await staking.getAddress();
  console.log("StagStaking      ", stakingAddr);

  // 3. Splitter: 90% -> staking pool, 10% -> owner/backend
  const Splitter = await ethers.getContractFactory("RevenueSplitter");
  const splitter = await Splitter.deploy(stakingAddr, splitterOwner, rs.poolBps);
  await splitter.waitForDeployment();
  const splitterAddr = await splitter.getAddress();
  console.log("RevenueSplitter  ", splitterAddr);

  // 4. wire the NFT
  await (await hood.setSplitter(splitterAddr)).wait();
  await (await hood.setRoyalty(splitterAddr, h.royaltyBps)).wait();
  await (await hood.setLocker(stakingAddr)).wait();
  if (h.maxPerWallet) await (await hood.setMaxPerWallet(h.maxPerWallet)).wait();
  // apply configured prices/weights so the config is the source of truth (not silent defaults)
  if (h.tierPriceEth && h.tierWeight) {
    for (let t = 0; t < 5; t++) {
      await (await hood.setTierPrice(t, E(h.tierPriceEth[TN[t]]))).wait();
      await (await hood.setTierWeight(t, BigInt(h.tierWeight[TN[t]]))).wait();
    }
    await (await hood.setRandomPrice(E(h.randomPriceEth))).wait();
  }
  console.log("wired NFT -> splitter / royalty / locker / prices");

  // 5. Sherwood Pact
  const Pact = await ethers.getContractFactory("SherwoodPact");
  const pact = await Pact.deploy(stag, E(CFG.sherwoodPact?.entryFeeEth || "0.01"), E(CFG.sherwoodPact?.refundEth || "0.005"));
  await pact.waitForDeployment();
  const pactAddr = await pact.getAddress();
  console.log("SherwoodPact     ", pactAddr);

  // 6. whitelist free mints
  for (const w of (h.freeMintAllowlist || [])) {
    await (await hood.grantFreeMints(w.wallet, w.count)).wait();
    console.log(`granted ${w.count} free mints -> ${w.wallet}`);
  }

  // 7. hand control to the admin/backend wallet (must be LAST — deployer loses owner rights).
  let ownerAddr = deployer.address, oracleAddr = deployer.address;
  if (admin && admin.toLowerCase() !== deployer.address.toLowerCase()) {
    await (await staking.setPenaltyRecipient(admin)).wait();
    await (await pact.setOracle(admin)).wait();           // admin re-points to the indexer signer post-deploy
    await (await hood.transferOwnership(admin)).wait();
    await (await staking.transferOwnership(admin)).wait();
    await (await pact.transferOwnership(admin)).wait();
    ownerAddr = admin; oracleAddr = admin;
    console.log(`ownership + penaltyRecipient + oracle -> admin ${admin}`);
  }

  const out = {
    chainId: CFG.chain.id, deployer: deployer.address,
    owner: ownerAddr, oracle: oracleAddr, poolBps: rs.poolBps, splitterOwner,
    HoodedTwenty: hoodAddr, StagStaking: stakingAddr, RevenueSplitter: splitterAddr, SherwoodPact: pactAddr, stag,
  };
  fs.writeFileSync(path.join(__dirname, "..", "deployed.json"), JSON.stringify(out, null, 2) + "\n");
  console.log("\nwrote deployed.json\n");
  console.log("NEXT (from /admin, connect the OWNER wallet):");
  console.log("  1. fund the staking pool + notifyRewardAmount   2. setMintActive(true)");
  console.log("  3. Sherwood Pact: setOracle(<indexer signer>) once the bubble-map indexer is live");
  console.log(`Paste into /admin -> Deployed Addresses:  mint=${hoodAddr}  staking=${stakingAddr}  splitter=${splitterAddr}  pact=${pactAddr}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
