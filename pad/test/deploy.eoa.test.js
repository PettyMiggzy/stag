// Wallet-owner mode (OWNER_IS_EOA=1): the platform owner is one plain wallet. Deploy + strict readback + negatives, on a mainnet fork.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { PM, STAG, E, fundStag } = require("./helpers");
const { hookInitCode, predictDeployer, mineSalt } = require("../scripts/lib");
const { deployAll } = require("../scripts/deploy");
const { readback } = require("../scripts/readback");

describe("WALLET-OWNER MODE: deploy + readback with a single wallet as owner", function () {
  this.timeout(900000);
  let eoa, owner, fresh, other, saltInfo, msContract, DEP, CFG;
  const fails = (rows) => rows.filter((r) => !r.ok).map((r) => r.name);
  const mine = async () => {
    const H = await ethers.getContractFactory("PadHook");
    const nonce = await eoa.getNonce(), dep = predictDeployer(eoa.address, nonce);
    const init = hookInitCode(H.bytecode, PM, dep, STAG), m = mineSalt(dep, init);
    return { deployer: dep, salt: m.salt, hook: m.hook, initcodeHash: ethers.keccak256(init), eoa: eoa.address, nonce };
  };
  before(async () => {
    [eoa, owner, , other] = await ethers.getSigners();
    fresh = ethers.Wallet.createRandom();                       // a brand-new address that has never sent a transaction
    await fundStag([eoa, owner], E(1000));
    await (await owner.sendTransaction({ to: owner.address, value: 1n })).wait();         // the owner wallet has been used (nonce > 0)
    msContract = await (await ethers.getContractFactory("TestMultisig")).deploy(other.address);
    saltInfo = await mine();
  });

  it("refuses, before sending anything, every unsafe wallet-owner setup", async () => {
    const eo = { expectOwner: owner.address };
    const base = { signer: eoa, saltInfo, mustBeContract: false, eoaOwner: eo };
    await expect(deployAll({ ...base, multisig: eoa.address, eoaOwner: { expectOwner: eoa.address } })).to.be.rejectedWith(/not the throwaway deployer/);   // owner == the deploy key
    await expect(deployAll({ ...base, multisig: await msContract.getAddress(), eoaOwner: { expectOwner: await msContract.getAddress() } })).to.be.rejectedWith(/plain wallet/);   // a contract
    await expect(deployAll({ ...base, multisig: fresh.address, eoaOwner: { expectOwner: fresh.address } })).to.be.rejectedWith(/at least one transaction/);               // never-used address (typo guard)
    await expect(deployAll({ ...base, multisig: owner.address, eoaOwner: { expectOwner: fresh.address } })).to.be.rejectedWith(/EXPECT_OWNER_EOA/);                       // typed twice and they differ
    await expect(deployAll({ ...base, multisig: owner.address, eoaOwner: { expectOwner: undefined } })).to.be.rejectedWith(/EXPECT_OWNER_EOA supplied/);                   // not supplied (non-dry)
    await expect(deployAll({ ...base, multisig: owner.address, mustBeContract: true })).to.be.rejectedWith(/mustBeContract=false/);
    await expect(deployAll({ ...base, multisig: owner.address, safeOpts: { dry: true } })).to.be.rejectedWith(/mutually exclusive/);
    // mainnet-style call (requireManifest) with a non-contract owner but WITHOUT the wallet-owner checks is refused
    await expect(deployAll({ signer: eoa, saltInfo, multisig: owner.address, mustBeContract: false, requireManifest: true })).to.be.rejectedWith(/only allowed in wallet-owner mode/);
  });

  it("deploys with a wallet owner; strict readback passes before and after the wallet accepts", async () => {
    const R = await deployAll({ signer: eoa, saltInfo, multisig: owner.address, mustBeContract: false, eoaOwner: { expectOwner: owner.address } });
    const cfg = { dry: false, ownerIsEoa: true, expectOwnerEoa: owner.address, deployer: await R.deployer.getAddress(), multisig: owner.address, salt: saltInfo, deployTx: R.deployer.deploymentTransaction().hash, ownerAccepted: false };
    const pre = await readback(ethers.provider, cfg);
    expect(fails(pre), "pre-accept").to.deep.equal([]);
    expect(pre.some((r) => /plain wallet/.test(r.name) && r.ok)).to.equal(true);
    expect(pre.some((r) => /mustBeContract=false/.test(r.name) && r.ok)).to.equal(true);
    expect(await R.hook.pendingOwner()).to.equal(owner.address);
    await expect(R.hook.connect(other).acceptOwner()).to.be.reverted;                       // nobody else can accept
    await (await R.hook.connect(owner).acceptOwner()).wait();
    expect(await R.hook.owner()).to.equal(owner.address);
    const post = await readback(ethers.provider, { ...cfg, ownerAccepted: true });
    expect(fails(post), "post-accept").to.deep.equal([]);
    // the owner can do exactly what the platform owner should: claim (nothing owed yet) and nothing on pools
    await expect(R.hook.connect(owner).claimPlatform(owner.address)).to.not.be.reverted;
    DEP = R; CFG = cfg;
  });

  it("readback FAILS on a wrong or unsafe owner (contract, wrong EXPECT_OWNER_EOA, deploy key, unused address)", async () => {
    const base = { ...CFG, ownerAccepted: true };
    expect(fails(await readback(ethers.provider, { ...base, expectOwnerEoa: fresh.address })).some((n) => /EXPECT_OWNER_EOA/.test(n))).to.equal(true);
    expect(fails(await readback(ethers.provider, { ...base, expectOwnerEoa: undefined })).some((n) => /EXPECT_OWNER_EOA supplied/.test(n))).to.equal(true);
    expect(fails(await readback(ethers.provider, { ...base, multisig: await msContract.getAddress(), expectOwnerEoa: await msContract.getAddress() })).some((n) => /plain wallet/.test(n))).to.equal(true);
    expect(fails(await readback(ethers.provider, { ...base, multisig: eoa.address, expectOwnerEoa: eoa.address })).some((n) => /not the throwaway deployer/.test(n))).to.equal(true);
    expect(fails(await readback(ethers.provider, { ...base, multisig: fresh.address, expectOwnerEoa: fresh.address })).some((n) => /at least one transaction/.test(n))).to.equal(true);
    // a Safe-style deployment is NOT valid in wallet-owner mode: the constructor args say mustBeContract=true there, so the args row fails
    expect(fails(await readback(ethers.provider, { ...base, ownerIsEoa: false, expectOwnerEoa: undefined, dry: true })).length).to.be.gt(0);
  });
});
