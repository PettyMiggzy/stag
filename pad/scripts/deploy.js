// Deploy script (hardhat):   MULTISIG=0x.. DEPLOYER_KEY=0x.. SALT_FILE=salt.json + (mainnet) EXPECT_OWNERS EXPECT_THRESHOLD EXPECT_SINGLETON EXPECT_PROXY_CODEHASH EXPECT_SAFE_CREATION_TX EXPECT_MANIFEST_DIGEST   npx hardhat run scripts/deploy.js --network robinhood   (DRYRUN=1 to rehearse on the in-process fork). See README.
// 1. node scripts/mine-salt.js --eoa <deployer EOA> --nonce <its CURRENT nonce> --out salt.json   (off-chain, offline)
// 2. run this: it refuses to send unless the signer, nonce and compiled bytecode match what the salt was mined for.
// 3. multisig calls hook.acceptOwner();  4. node scripts/readback.js (and again with EXPECT_OWNER_ACCEPTED=1)
const fs = require("fs");
const { ethers } = require("hardhat");
const { PM_DEFAULT, STAG_DEFAULT, hookInitCode, predictDeployer, FLAG_MASK, FLAGS, probeSafe, safeChecks } = require("./lib");
const MAN = require("./manifest");

async function deployAll({ signer, multisig, mustBeContract = true, saltInfo, pm = PM_DEFAULT, quote = STAG_DEFAULT, requireManifest = false, safeOpts = null }) {
  const nonce = await signer.getNonce("latest");
  if (nonce !== (await signer.getNonce("pending"))) throw new Error("this account has a pending transaction: the mined salt would be for the wrong nonce. Wait for it or re-mine.");
  const dep = predictDeployer(signer.address, nonce);
  if (saltInfo.deployer.toLowerCase() !== dep.toLowerCase()) throw new Error(`salt was mined for deployer ${saltInfo.deployer}, but ${signer.address} nonce ${nonce} gives ${dep}`);
  const H = await ethers.getContractFactory("PadHook");
  const init = hookInitCode(H.bytecode, pm, dep, quote);
  const hookAddr = ethers.getCreate2Address(dep, saltInfo.salt, ethers.keccak256(init));
  if (saltInfo.initcodeHash && saltInfo.initcodeHash.toLowerCase() !== ethers.keccak256(init).toLowerCase()) throw new Error("the compiled bytecode is not the one the salt was mined for (recompiled?)");
  if ((BigInt(hookAddr) & FLAG_MASK) !== FLAGS) throw new Error("salt does not give a 0x28CC address for this bytecode (recompiled?)");
  const D = await ethers.getContractFactory("PadDeployer", signer);
  if (safeOpts) { const { rows } = await safeChecks(signer.provider, multisig, safeOpts); const bad = rows.filter((r) => !r.ok); if (bad.length) throw new Error("hand-over target failed hardening checks, refusing to send: " + bad.map((r) => r.name + (r.detail ? " [" + r.detail + "]" : "")).join("; ")); }
  if (mustBeContract) { const sp = await probeSafe(signer.provider, multisig); if (!sp.ok) throw new Error("the hand-over target does not answer like a Safe (VERSION/getThreshold/getOwners): it could never accept ownership. Refusing."); }
  const man = MAN.load();
  if (!man && requireManifest) throw new Error("audited-manifest.json is missing: refusing to deploy an unpinned build on mainnet");
  if (man && ethers.keccak256(D.bytecode) !== man.deployerCreationCode && !(process.env.ALLOW_UNPINNED && !requireManifest)) throw new Error("PadDeployer build differs from audited-manifest.json (modified sources or a different compile). Refusing; ALLOW_UNPINNED=1 only for rehearsals.");
  const tx = await D.getDeployTransaction(pm, quote, multisig, mustBeContract, saltInfo.salt);
  const gasLimit = ((await signer.estimateGas(tx)) * 13n) / 10n;      // 30% margin: an L1-fee swing must not run the 38 KB constructor out of gas (that would burn the nonce and the mined salt)
  const d = await D.deploy(pm, quote, multisig, mustBeContract, saltInfo.salt, { nonce, gasLimit });
  await d.waitForDeployment();
  if ((await d.getAddress()).toLowerCase() !== dep.toLowerCase()) throw new Error("deployer landed on an unexpected address");
  if ((await d.hook()).toLowerCase() !== hookAddr.toLowerCase()) throw new Error("hook address differs from prediction");
  return { deployer: d, hook: H.attach(hookAddr), factory: (await ethers.getContractFactory("PadFactory")).attach(await d.factory()), battle: (await ethers.getContractFactory("PadBattle")).attach(await d.battle()) };
}
module.exports = { deployAll };

if (require.main === module) {
  (async () => {
    const { network } = require("hardhat");
    const net = await ethers.provider.getNetwork();
    const realMainnet = net.chainId === 4663n && network.name !== "hardhat";     // the in-process hardhat network is a fork: never the real thing
    if (!realMainnet && !process.env.DRYRUN) throw new Error("refusing to run: use --network robinhood (chain 4663) with DEPLOYER_KEY set, or DRYRUN=1 on the in-process fork for a rehearsal");   // DRYRUN is ignored on the real chain
    if (process.env.MUST_BE_CONTRACT === "0") console.warn("WARNING: MUST_BE_CONTRACT=0 allows an EOA as owner. Use a multisig contract on mainnet.");
    for (const k of Object.keys(process.env)) if (/^(EXPECT_|SALT_FILE|MULTISIG$)/.test(k)) process.env[k] = process.env[k].trim();
    const [signer] = await ethers.getSigners();
    const saltInfo = JSON.parse(fs.readFileSync(process.env.SALT_FILE || "salt.json", "utf8"));
    if (!realMainnet) console.warn("*** DRY RUN on the in-process fork: nothing real is being deployed ***");
    const digest = MAN.load() ? ethers.keccak256(fs.readFileSync(MAN.FILE)) : null;
    if (digest) console.log("manifest digest:", digest);
    let safeOpts = null;
    if (realMainnet) {
      for (const k of ["EXPECT_OWNERS", "EXPECT_THRESHOLD", "EXPECT_SINGLETON", "EXPECT_PROXY_CODEHASH", "EXPECT_SAFE_CREATION_TX", "EXPECT_MANIFEST_DIGEST"]) if (!process.env[k]) throw new Error(`${k} is required on mainnet`);
      if (!digest || digest.toLowerCase() !== process.env.EXPECT_MANIFEST_DIGEST.toLowerCase()) throw new Error("manifest digest != EXPECT_MANIFEST_DIGEST (the digest published with the audit report)");
      if (process.env.ALLOW_UNPINNED) console.warn("ALLOW_UNPINNED is ignored on mainnet");
      safeOpts = { expectOwners: process.env.EXPECT_OWNERS.split(",").map((x) => ethers.getAddress(x.trim())), expectThreshold: process.env.EXPECT_THRESHOLD, expectSingleton: process.env.EXPECT_SINGLETON, expectProxyCodehash: process.env.EXPECT_PROXY_CODEHASH, safeCreationTx: process.env.EXPECT_SAFE_CREATION_TX, expectFallback: process.env.EXPECT_FALLBACK };
    }
    const r = await deployAll({ signer, multisig: ethers.getAddress(process.env.MULTISIG), mustBeContract: process.env.MUST_BE_CONTRACT !== "0" || realMainnet, saltInfo, requireManifest: realMainnet, safeOpts });
    console.log("deployment tx:", r.deployer.deploymentTransaction() && r.deployer.deploymentTransaction().hash);
    console.log({ deployer: await r.deployer.getAddress(), hook: await r.hook.getAddress(), factory: await r.factory.getAddress(), battle: await r.battle.getAddress() });
    console.log("NEXT: the multisig must call hook.acceptOwner(); then run scripts/readback.js");
  })().catch((e) => { console.error(e); process.exit(1); });
}
