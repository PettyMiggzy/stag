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
  const splitter = await Splitter.deploy(stakingAddr, rs.owner, rs.poolBps);
  await splitter.waitForDeployment();
  const splitterAddr = await splitter.getAddress();
  console.log("RevenueSplitter  ", splitterAddr);

  // 4. wire the NFT
  await (await hood.setSplitter(splitterAddr)).wait();
  await (await hood.setRoyalty(splitterAddr, h.royaltyBps)).wait();
  await (await hood.setLocker(stakingAddr)).wait();
  if (h.maxPerWallet) await (await hood.setMaxPerWallet(h.maxPerWallet)).wait();
  console.log("wired NFT -> splitter / royalty / locker");

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

  const out = {
    chainId: CFG.chain.id, deployedAt: new Date().toISOString(), deployer: deployer.address,
    HoodedTwenty: hoodAddr, StagStaking: stakingAddr, RevenueSplitter: splitterAddr, SherwoodPact: pactAddr,
    stag, splitterOwner: rs.owner,
  };
  fs.writeFileSync(path.join(__dirname, "..", "deployed.json"), JSON.stringify(out, null, 2) + "\n");
  console.log("\nwrote deployed.json\n");
  console.log("NEXT: fund the staking pool + call notifyRewardAmount, then setMintActive(true) in the admin panel.");
  console.log("Paste these into /admin -> Deployed Addresses:");
  console.log(`  mint=${hoodAddr}  staking=${stakingAddr}  splitter=${splitterAddr}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
