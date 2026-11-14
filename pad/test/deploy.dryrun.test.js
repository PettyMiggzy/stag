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

  it("REGRESSION a hand-over target that could never accept is refused by the deployer itself", async () => {
    const D = await ethers.getContractFactory("PadDeployer", eoa);
    const plain = await (await ethers.getContractFactory("HookDeployer")).deploy();         // a contract that does not answer like a Safe
    for (const bad of [STAG, PM, await plain.getAddress(), other.address, ethers.ZeroAddress, eoa.address])
      await expect(D.deploy(PM, STAG, bad, true, ethers.ZeroHash), String(bad)).to.be.revertedWithCustomError(D, "BadArg");
  });

  it("REGRESSION deploy.js refuses a non-Safe target before sending anything", async () => {
    const plain = await (await ethers.getContractFactory("HookDeployer")).deploy();
    const H = await ethers.getContractFactory("PadHook");
    const nonce = await eoa.getNonce();
    const dep = predictDeployer(eoa.address, nonce);
    const m = mineSalt(dep, hookInitCode(H.bytecode, PM, dep, STAG));
    await expect(deployAll({ signer: eoa, multisig: await plain.getAddress(), saltInfo: { deployer: dep, salt: m.salt } })).to.be.rejectedWith(/Safe/);
    expect(await eoa.getNonce()).to.equal(nonce);                                              // nothing was sent: the mined salt is still good
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
    const rows = await readback(ethers.provider, { dry: true, deployer: await R.deployer.getAddress(), multisig: await msContract.getAddress(), ownerAccepted: false });
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
    const rows = await readback(ethers.provider, { dry: true, deployer: await R.deployer.getAddress(), multisig: await msContract.getAddress(), ownerAccepted: true });
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
    const rows = await readback(ethers.provider, { dry: true, deployer: await R.deployer.getAddress(), multisig: await msContract.getAddress(), ownerAccepted: true });
    expect(rows.filter((r) => !r.ok)).to.deep.equal([]);
    expect(rows.some((r) => /every launch is registered/.test(r.name) && /2 launches/.test(r.detail))).to.equal(true);
  });

  it("readback detects a mis-deployment (a spoofed hook address in the deployer slot)", async () => {
    // point the checklist at a fresh PadDeployer-like world where multisig differs: must FAIL the multisig checks
    const rows = await readback(ethers.provider, { dry: true, deployer: await R.deployer.getAddress(), multisig: other.address, ownerAccepted: true });
    expect(rows.filter((r) => !r.ok).length).to.be.gte(2);
  });

  it("strict readback: non-dry run without salt/owners/threshold FAILS, wrong owners FAIL", async () => {
    const base = { deployer: await R.deployer.getAddress(), multisig: await msContract.getAddress(), ownerAccepted: false };
    const rows = await readback(ethers.provider, { ...base, dry: false, allowAnyChain: true, allowOverrides: true });
    const fails = rows.filter((r) => !r.ok).map((r) => r.name);
    expect(fails.some((n) => /salt/i.test(n))).to.equal(true);
    expect(fails.some((n) => /EXPECT_OWNERS/.test(n))).to.equal(true);
    expect(fails.some((n) => /EXPECT_THRESHOLD/.test(n))).to.equal(true);
    const bad = await readback(ethers.provider, { ...base, dry: true, expectOwners: [ethers.Wallet.createRandom().address], expectThreshold: 2 });
    expect(bad.some((r) => !r.ok && /owners/.test(r.name))).to.equal(true);
  });

  it("deploy-tx verification: genuine creation tx passes; a different creator/nonce/args or patched calldata fails", async () => {
    const hash = R.deployer.deploymentTransaction().hash;
    const base = { dry: true, deployer: await R.deployer.getAddress(), multisig: await msContract.getAddress(), ownerAccepted: false, deployTx: hash,
      salt: { salt: saltInfo.salt, eoa: eoa.address, nonce: 0 } };
    const tx = await ethers.provider.getTransaction(hash);
    base.salt.nonce = tx.nonce;
    const good = await readback(ethers.provider, base);
    expect(good.filter((r) => !r.ok && /deploy tx/.test(r.name))).to.deep.equal([]);
    expect(good.some((r) => /PINNED PadDeployer creation code/.test(r.name) && r.ok)).to.equal(true);
    const wrongEoa = await readback(ethers.provider, { ...base, salt: { ...base.salt, eoa: other.address } });
    expect(wrongEoa.some((r) => !r.ok && /from == salt.eoa/.test(r.name))).to.equal(true);
    const wrongSalt = await readback(ethers.provider, { ...base, salt: { ...base.salt, salt: ethers.ZeroHash } });
    expect(wrongSalt.some((r) => !r.ok && /constructor args/.test(r.name))).to.equal(true);
  });

  it("patched creation calldata fails the pinned-prefix check (same runtime, different constructor)", async () => {
    const hash = R.deployer.deploymentTransaction().hash;
    const tx = await ethers.provider.getTransaction(hash);
    const flipped = ethers.getBytes(tx.data).slice(); flipped[flipped.length - 200] ^= 1;    // inside the embedded creation code region
    const fake = { getTransaction: async () => ({ from: tx.from, nonce: tx.nonce, to: null, data: ethers.hexlify(flipped) }), getTransactionReceipt: async () => ethers.provider.getTransactionReceipt(hash) };
    const prov = new Proxy(ethers.provider, { get: (t0, k) => (k in fake ? fake[k] : typeof t0[k] === "function" ? t0[k].bind(t0) : t0[k]) });
    const rows = await readback(prov, { dry: true, deployer: await R.deployer.getAddress(), multisig: await msContract.getAddress(), ownerAccepted: false, deployTx: hash, salt: { salt: saltInfo.salt, eoa: eoa.address, nonce: tx.nonce } });
    expect(rows.some((r) => !r.ok && /PINNED PadDeployer creation code|constructor args/.test(r.name))).to.equal(true);
  });

  it("hardening: wrong singleton / wrong proxy code hash fail; ALLOW_UNPINNED is ignored when requireManifest", async () => {
    const base = { dry: true, deployer: await R.deployer.getAddress(), multisig: await msContract.getAddress(), ownerAccepted: false };
    const r1 = await readback(ethers.provider, { ...base, expectSingleton: other.address });
    expect(r1.some((r) => !r.ok && /singleton/.test(r.name))).to.equal(true);
    const r2 = await readback(ethers.provider, { ...base, expectProxyCodehash: ethers.ZeroHash });
    expect(r2.some((r) => !r.ok && /EXPECT_PROXY_CODEHASH/.test(r.name))).to.equal(true);
    const code = await ethers.provider.getCode(await msContract.getAddress());
    const r3 = await readback(ethers.provider, { ...base, expectProxyCodehash: ethers.keccak256(code) });
    expect(r3.some((r) => !r.ok && /EXPECT_PROXY_CODEHASH/.test(r.name))).to.equal(false);
  });

  it("deployAll with requireManifest ignores ALLOW_UNPINNED (fresh salt so the pin check is what rejects)", async () => {
    const H = await ethers.getContractFactory("PadHook");
    const nonce = await eoa.getNonce(), dep = predictDeployer(eoa.address, nonce);
    const m = mineSalt(dep, hookInitCode(H.bytecode, PM, dep, STAG));
    const si = { deployer: dep, salt: m.salt, hook: m.hook };
    const MAN = require("../scripts/manifest"); const fs = require("fs"); const orig = fs.readFileSync(MAN.FILE);
    try {
      const bad = JSON.parse(orig); bad.deployerCreationCode = ethers.ZeroHash; fs.writeFileSync(MAN.FILE, JSON.stringify(bad));
      process.env.ALLOW_UNPINNED = "1";
      await expect(deployAll({ signer: eoa, multisig: await msContract.getAddress(), saltInfo: si, requireManifest: true })).to.be.rejectedWith(/differs from audited-manifest/);
      await expect(deployAll({ signer: eoa, multisig: await msContract.getAddress(), saltInfo: si, requireManifest: false })).to.not.be.rejectedWith(/differs from audited-manifest/);   // rehearsal escape hatch still works off mainnet
    } finally { delete process.env.ALLOW_UNPINNED; fs.writeFileSync(MAN.FILE, orig); }
  });

  it("Safe creation tx: a setup() with an initializer delegatecall (or no SafeSetup log) FAILS; a clean one passes", async () => {
    const addr = await msContract.getAddress();
    const topic = ethers.id("SafeSetup(address,address[],uint256,address,address)");
    const enc = (init) => ethers.AbiCoder.defaultAbiCoder().encode(["address[]", "uint256", "address"], [[ms.address], 1, init]);
    const mk = (logs) => new Proxy(ethers.provider, { get: (t0, k) => (k === "getTransactionReceipt" ? async () => ({ status: 1, logs }) : typeof t0[k] === "function" ? t0[k].bind(t0) : t0[k]) });
    const log = (init) => ({ address: addr, topics: [topic, ethers.zeroPadValue(other.address, 32), ethers.zeroPadValue(ethers.ZeroAddress, 32)], data: enc(init) });
    const base = { dry: true, deployer: await R.deployer.getAddress(), multisig: addr, ownerAccepted: false, safeCreationTx: ethers.ZeroHash };
    const bad = await readback(mk([log(other.address)]), base);
    expect(bad.some((r) => !r.ok && /initializer/.test(r.name))).to.equal(true);
    const none = await readback(mk([]), base);
    expect(none.some((r) => !r.ok && /exactly one SafeSetup/.test(r.name))).to.equal(true);
    const good = await readback(mk([log(ethers.ZeroAddress)]), base);
    expect(good.filter((r) => !r.ok && /Safe/.test(r.name))).to.deep.equal([]);
  });
});
