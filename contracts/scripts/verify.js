// Verify all four deployed contracts on Robinhood Chain Blockscout.
//   npx hardhat verify --network rhmainnet   ← per-contract, or just:
//   npx hardhat run scripts/verify.js --network rhmainnet
//
// Reads deployed.json + deploy.config.json so the constructor args are guaranteed
// identical to what was actually deployed. No private key needed for verification.
const hre = require("hardhat");
const D = require("../deployed.json");
const CFG = require("../deploy.config.json");
const E = (v) => hre.ethers.parseEther(String(v));

async function verify(name, address, args) {
  process.stdout.write(`\n▶ ${name} @ ${address}\n`);
  try {
    await hre.run("verify:verify", { address, constructorArguments: args });
    console.log(`✓ ${name} verified`);
  } catch (e) {
    const m = String(e.message || e);
    if (/already verified/i.test(m)) console.log(`✓ ${name} already verified`);
    else console.log(`✗ ${name}: ${m.split("\n")[0]}`);
  }
}

async function main() {
  const h = CFG.hoodedTwenty, rs = CFG.revenueSplitter, stag = CFG.stagToken;
  // constructor args exactly as deploy.js passed them
  await verify("HoodedTwenty", D.HoodedTwenty, [h.baseURI, hre.ethers.ZeroAddress, h.royaltyBps]);
  await verify("StagStaking", D.StagStaking, [stag, D.HoodedTwenty]);
  await verify("RevenueSplitter", D.RevenueSplitter, [D.StagStaking, hre.ethers.getAddress(rs.owner), rs.poolBps]);
  await verify("SherwoodPact", D.SherwoodPact, [stag, E(CFG.sherwoodPact.entryFeeEth), E(CFG.sherwoodPact.refundEth)]);
  console.log("\nDone. Check https://robinhoodchain.blockscout.com/address/<addr>?tab=contract");
}

main().catch((e) => { console.error(e); process.exit(1); });
