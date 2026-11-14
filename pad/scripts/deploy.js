// Deploy script (hardhat):   MULTISIG=0x.. [MUST_BE_CONTRACT=0] [SALT_FILE=salt.json] npx hardhat run scripts/deploy.js --network <net>
// 1. node scripts/mine-salt.js --eoa <deployer EOA> --nonce <its CURRENT nonce> --out salt.json   (off-chain, offline)
// 2. run this: it refuses to send unless the signer, nonce and compiled bytecode match what the salt was mined for.
// 3. multisig calls hook.acceptOwner();  4. node scripts/readback.js (and again with EXPECT_OWNER_ACCEPTED=1)
const fs = require("fs");
const { ethers } = require("hardhat");
const { PM_DEFAULT, STAG_DEFAULT, hookInitCode, predictDeployer, FLAG_MASK, FLAGS } = require("./lib");

async function deployAll({ signer, multisig, mustBeContract = true, saltInfo, pm = PM_DEFAULT, quote = STAG_DEFAULT }) {
  const nonce = await signer.getNonce();
  const dep = predictDeployer(signer.address, nonce);
  if (saltInfo.deployer.toLowerCase() !== dep.toLowerCase()) throw new Error(`salt was mined for deployer ${saltInfo.deployer}, but ${signer.address} nonce ${nonce} gives ${dep}`);
  const H = await ethers.getContractFactory("PadHook");
  const init = hookInitCode(H.bytecode, pm, dep, quote);
  const hookAddr = ethers.getCreate2Address(dep, saltInfo.salt, ethers.keccak256(init));
  if ((BigInt(hookAddr) & FLAG_MASK) !== FLAGS) throw new Error("salt does not give a 0x28CC address for this bytecode (recompiled?)");
  const D = await ethers.getContractFactory("PadDeployer", signer);
  const d = await D.deploy(pm, quote, multisig, mustBeContract, saltInfo.salt);
  await d.waitForDeployment();
  if ((await d.getAddress()).toLowerCase() !== dep.toLowerCase()) throw new Error("deployer landed on an unexpected address");
  if ((await d.hook()).toLowerCase() !== hookAddr.toLowerCase()) throw new Error("hook address differs from prediction");
  return { deployer: d, hook: H.attach(hookAddr), factory: (await ethers.getContractFactory("PadFactory")).attach(await d.factory()), battle: (await ethers.getContractFactory("PadBattle")).attach(await d.battle()) };
}
module.exports = { deployAll };

if (require.main === module) {
  (async () => {
    const [signer] = await ethers.getSigners();
    const saltInfo = JSON.parse(fs.readFileSync(process.env.SALT_FILE || "salt.json", "utf8"));
    const r = await deployAll({ signer, multisig: ethers.getAddress(process.env.MULTISIG), mustBeContract: process.env.MUST_BE_CONTRACT !== "0", saltInfo });
    console.log({ deployer: await r.deployer.getAddress(), hook: await r.hook.getAddress(), factory: await r.factory.getAddress(), battle: await r.battle.getAddress() });
    console.log("NEXT: the multisig must call hook.acceptOwner(); then run scripts/readback.js");
  })().catch((e) => { console.error(e); process.exit(1); });
}
