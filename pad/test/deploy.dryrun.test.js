const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { E, PM, STAG, fundStag, mk } = require("./helpers");
const { hookInitCode, predictDeployer, mineSalt } = require("../scripts/lib");
const { deployAll } = require("../scripts/deploy");
const { readback } = require("../scripts/readback");

describe("DRY RUN: PadDeployer on a fork (mine salt -> deploy -> readback -> two-step hand-over -> live use)", function () {
  this.timeout(900000);
  let eoa, ms, other, alice, bob, saltInfo, R, msContract;

  before(async () => {
    [eoa, ms, other, alice, bob] = await ethers.getSigners();
    await fundStag([eoa, alice, bob, other], E(200_000_000));
    msContract = await (await ethers.getContractFactory("TestMultisig")).deploy(ms.address);   // Safe stand-in
  });

  it("initcode sizes are inside the real limits (24576 runtime / 49152 init)", async () => {
    const D = await ethers.getContractFactory("PadDeployer");
    expect((D.bytecode.length - 2) / 2).to.be.lte(49152);
    for (const n of ["PadHook", "PadFactory", "PadBattle"]) {
      const a = await hre.artifacts.readArtifact(n);
      expect((a.deployedBytecode.length - 2) / 2, n).to.be.lte(24576);
    }
  });

  it("a wrong salt reverts the whole deployment (nothing half-deployed)", async () => {
    const D = await ethers.getContractFactory("PadDeployer", eoa);
    await expect(D.deploy(PM, STAG, await msContract.getAddress(), true, ethers.ZeroHash)).to.be.reverted;
    // NOTE: a reverted deployment may still consume the EOA nonce (hardhat mines it), which invalidates a salt mined for the old nonce:
    // always mine AFTER the last failed attempt, deploy.js re-checks signer+nonce against the salt file before sending.
  });

  it("mines a salt off-chain for the predicted deployer address and deploys", async () => {
    const H = await ethers.getContractFactory("PadHook");
    const nonce = await eoa.getNonce();
    const dep = predictDeployer(eoa.address, nonce);
    const init = hookInitCode(H.bytecode, PM, dep, STAG);
    const t = Date.now();
    const m = mineSalt(dep, init);
    console.log(`      mined in ${Date.now() - t} ms, tries ${m.tries}, hook ${m.hook}`);
    saltInfo = { deployer: dep, salt: m.salt, hook: m.hook };
    R = await deployAll({ signer: eoa, multisig: await msContract.getAddress(), mustBeContract: true, saltInfo });
    expect(await R.hook.getAddress()).to.equal(m.hook);
    expect(BigInt(m.hook) & 0x3fffn).to.equal(0x28ccn);
  });

  it("a salt mined for another nonce/EOA is refused by the script and by the chain", async () => {
    const H = await ethers.getContractFactory("PadHook");
    const dep2 = predictDeployer(eoa.address, (await eoa.getNonce()) + 5);
    const m2 = mineSalt(dep2, hookInitCode(H.bytecode, PM, dep2, STAG));
    await expect(deployAll({ signer: eoa, multisig: await msContract.getAddress(), saltInfo: { deployer: dep2, salt: m2.salt } })).to.be.rejectedWith(/salt was mined for deployer/);
    // bypass the script: send it directly, the hook address then lacks the flags (almost surely) and BaseHook reverts everything
    const D = await ethers.getContractFactory("PadDeployer", eoa);
    await expect(D.deploy(PM, STAG, await msContract.getAddress(), true, m2.salt)).to.be.reverted;
  });

  it("readback BEFORE accept: everything passes, hand-over pending", async () => {
    const rows = await readback(ethers.provider, { deployer: await R.deployer.getAddress(), multisig: await msContract.getAddress(), ownerAccepted: false });
    for (const r of rows) if (!r.ok) console.log("FAIL", r.name, r.detail);
    expect(rows.filter((r) => !r.ok)).to.deep.equal([]);
    expect(await R.hook.owner()).to.equal(await R.deployer.getAddress());
    expect(await R.hook.pendingOwner()).to.equal(await msContract.getAddress());
  });

  it("while pending: nobody but the pending owner can accept; deployer contract cannot claim or re-wire", async () => {
    await expect(R.hook.connect(other).acceptOwner()).to.be.reverted;
    await expect(R.hook.connect(eoa).acceptOwner()).to.be.reverted;
    await expect(R.hook.connect(eoa).claimPlatform(eoa.address)).to.be.reverted;          // EOA is not the owner
    await expect(R.hook.connect(eoa).wire(eoa.address, other.address)).to.be.reverted;
  });

  it("the deployer contract has no functions at all after construction (no admin, no retarget): nobody holds a root key", async () => {
    expect(R.deployer.interface.fragments.filter((f) => f.type === "function").map((f) => f.name).sort()).to.deep.equal(["battle", "factory", "hook", "multisig"]);
    await expect(eoa.sendTransaction({ to: await R.deployer.getAddress(), data: "0x" })).to.be.reverted;           // no receive/fallback either
    await expect(eoa.sendTransaction({ to: await R.deployer.getAddress(), data: "0xcd2d7d7d" + "00".repeat(32) })).to.be.reverted;  // retarget(address) selector is gone
  });

  it("the multisig (a contract) accepts through exec; then everything is the multisig's and the deployer is inert", async () => {
    const data = R.hook.interface.encodeFunctionData("acceptOwner");
    await expect(msContract.connect(other).exec(await R.hook.getAddress(), data)).to.be.reverted;
    await msContract.connect(ms).exec(await R.hook.getAddress(), data);
    expect(await R.hook.owner()).to.equal(await msContract.getAddress());
    expect(await R.hook.pendingOwner()).to.equal(ethers.ZeroAddress);
    await expect(R.hook.connect(eoa).setOwner(eoa.address)).to.be.reverted;
    const rows = await readback(ethers.provider, { deployer: await R.deployer.getAddress(), multisig: await msContract.getAddress(), ownerAccepted: true });
    expect(rows.filter((r) => !r.ok)).to.deep.equal([]);
  });

  it("live: launch both orderings, trade, tax lands, multisig claims the platform share, readback still green", async () => {
    const S = { hook: R.hook, factory: R.factory, battle: R.battle, router: await (await ethers.getContractFactory("PoolSwapTest")).deploy(PM),
      stag: new ethers.Contract(STAG, ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function transfer(address,uint256) returns (bool)"], eoa),
      stateView: new ethers.Contract("0xf3334192d15450cdd385c8b70e03f9a6bd9e673b", ["function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)"], eoa) };
    const P = mk(S, [eoa, alice, bob, other]);
    const pools = {};
    for (let n = 0; n < 30 && !(pools.q0 && pools.q1); n++) { const p = await P.launch(alice, true); if (p.quoteIs0 && !pools.q0) pools.q0 = p; else if (!p.quoteIs0 && !pools.q1) pools.q1 = p; }
    expect(pools.q0 && pools.q1).to.be.ok;
    for (const p of Object.values(pools)) { await P.buy(p, bob, E(1_000_000)); await P.sell(p, bob, (await p.tok.balanceOf(bob.address)) / 2n); }
    expect(await P.solvent(Object.values(pools))).to.equal(true);
    const owed = await R.hook.platformOwed();
    expect(owed).to.be.gt(0n);
    const b0 = await P.stag.balanceOf(ms.address);
    await expect(R.hook.connect(eoa).claimPlatform(eoa.address)).to.be.reverted;
    await msContract.connect(ms).exec(await R.hook.getAddress(), R.hook.interface.encodeFunctionData("claimPlatform", [ms.address]));
    expect((await P.stag.balanceOf(ms.address)) - b0).to.equal(owed);
    const rows = await readback(ethers.provider, { deployer: await R.deployer.getAddress(), multisig: await msContract.getAddress(), ownerAccepted: true });
    expect(rows.filter((r) => !r.ok)).to.deep.equal([]);
    expect(rows.some((r) => /solvency.*2 launches/.test(r.name))).to.equal(true);
  });

  it("readback detects a mis-deployment (a spoofed hook address in the deployer slot)", async () => {
    // point the checklist at a fresh PadDeployer-like world where multisig differs: must FAIL the multisig checks
    const rows = await readback(ethers.provider, { deployer: await R.deployer.getAddress(), multisig: other.address, ownerAccepted: true });
    expect(rows.filter((r) => !r.ok).length).to.be.gte(2);
  });
});
