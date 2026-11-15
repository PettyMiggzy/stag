// Strict (non-dry) path against REAL Safe contracts from the official factories already on chain 4663 (fork), plus one negative case per Safe hardening row.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { PM, STAG } = require("./helpers");
const { hookInitCode, predictDeployer, mineSalt } = require("../scripts/lib");
const { deployAll } = require("../scripts/deploy");
const { readback } = require("../scripts/readback");

const VARIANTS = {
  "1.3.0 Safe": { factory: "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2", single: "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552", fb: "0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4" },
  "1.3.0 L2": { factory: "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2", single: "0x3E5c63644E683549055b9Be8653de26E0B4CD36E", fb: ethers.ZeroAddress },
  "1.4.1 Safe": { factory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67", single: "0x41675C099F32341bf84BFc5382aF534df5C7461a", fb: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99" },
  "1.4.1 L2": { factory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67", single: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762", fb: ethers.ZeroAddress },
};
const FAC = ["function createProxyWithNonce(address,bytes,uint256) returns (address)"];
const SAFE = ["function setup(address[],uint256,address,bytes,address,address,uint256,address)", "function nonce() view returns (uint256)", "function approveHash(bytes32)",
  "function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns (bytes32)",
  "function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) returns (bool)"];
const word = (a) => ethers.zeroPadValue(a, 32);

describe("REAL SAFE strict path (official factories on the fork)", function () {
  this.timeout(900000);
  let nonceSalt = 7000;
  async function build(v) {
    const [eoa, o1, o2, o3] = await ethers.getSigners();
    await network.provider.send("hardhat_mine", ["0x1"]);
    const owners = [o1.address, o2.address, o3.address], prov = ethers.provider;
    const setupData = new ethers.Interface(SAFE).encodeFunctionData("setup", [owners, 2, ethers.ZeroAddress, "0x", v.fb, ethers.ZeroAddress, 0, ethers.ZeroAddress]);
    const fac = new ethers.Contract(v.factory, FAC, o1), sn = nonceSalt++;
    const addr = await fac.createProxyWithNonce.staticCall(v.single, setupData, sn);
    const ctx = await fac.createProxyWithNonce(v.single, setupData, sn);
    const pins = { expectOwners: owners, expectThreshold: "2", expectSingleton: v.single, expectProxyCodehash: ethers.keccak256(await prov.getCode(addr)), safeCreationTx: ctx.hash,
      expectFactory: v.factory, expectSingletonCodehash: ethers.keccak256(await prov.getCode(v.single)), expectFactoryCodehash: ethers.keccak256(await prov.getCode(v.factory)) };
    if (v.fb !== ethers.ZeroAddress) { pins.expectFallback = v.fb; pins.expectFallbackCodehash = ethers.keccak256(await prov.getCode(v.fb)); }
    const nonce = await eoa.getNonce(), dep = predictDeployer(eoa.address, nonce);
    const H = await ethers.getContractFactory("PadHook"), init = hookInitCode(H.bytecode, PM, dep, STAG), m = mineSalt(dep, init);
    const saltInfo = { deployer: dep, salt: m.salt, hook: m.hook, initcodeHash: ethers.keccak256(init), eoa: eoa.address, nonce };
    const R = await deployAll({ signer: eoa, multisig: addr, mustBeContract: true, saltInfo, requireManifest: true, safeOpts: { ...pins } });
    const cfg = { deployer: await R.deployer.getAddress(), multisig: addr, ...pins, salt: saltInfo, deployTx: R.deployer.deploymentTransaction().hash, ownerAccepted: false, dry: false };
    return { eoa, o1, o2, o3, owners, addr, pins, R, cfg, prov };
  }
  const fails = (rows) => rows.filter((r) => !r.ok).map((r) => r.name);

  for (const [name, v] of Object.entries(VARIANTS)) {
    it(`${name}: strict deploy + readback pass before and after a real Safe execTransaction accepts ownership`, async () => {
      const { o1, o2, o3, addr, R, cfg, prov } = await build(v);
      expect(fails(await readback(prov, cfg))).to.deep.equal([]);
      const S = new ethers.Contract(addr, SAFE, o3), data = R.hook.interface.encodeFunctionData("acceptOwner");
      expect(data.slice(0, 10)).to.equal("0xebbc4965");
      const hash = await S.getTransactionHash(await R.hook.getAddress(), 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, await S.nonce());
      await S.connect(o1).approveHash(hash); await S.connect(o2).approveHash(hash);
      const sig = (a) => ethers.concat([word(a), ethers.ZeroHash, "0x01"]);
      const sorted = [o1.address, o2.address].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      await (await S.execTransaction(await R.hook.getAddress(), 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, ethers.concat(sorted.map(sig)))).wait();
      expect(await R.hook.owner()).to.equal(addr);
      expect(fails(await readback(prov, { ...cfg, ownerAccepted: true }))).to.deep.equal([]);
    });
  }

  it("each Safe hardening row FAILS when its condition is broken (negative case per row)", async () => {
    const { addr, R, cfg, prov, owners } = await build(VARIANTS["1.4.1 Safe"]);
    const hookA = await R.hook.getAddress();
    const set = (slot, val) => network.provider.send("hardhat_setStorageAt", [addr, slot, val]);
    const check = async (label, re, mut, undo) => { await mut(); const f = fails(await readback(prov, cfg)); await undo(); expect(f.some((n) => re.test(n)), label + " -> " + f.join(" | ")).to.equal(true); };
    const orig = (slot) => prov.getStorage(addr, slot);
    for (const [label, re, slot, val] of [
      ["guard set", /guard slot/, ethers.id("guard_manager.guard.address"), word(hookA)],
      ["module guard set", /module-guard slot/, ethers.id("module_manager.module_guard.address"), word(hookA)],
      ["fallback handler = hook", /none of this system's contracts/, ethers.id("fallback_manager.handler.address"), word(hookA)],
      ["threshold changed after setup", /threshold/, "0x4", ethers.zeroPadValue("0x03", 32)],
      ["singleton swapped", /singleton|answers like a Safe/, "0x0", word(hookA)],
    ]) {
      const slotHex = slot.startsWith("0x") ? ethers.toBeHex(BigInt(slot), 32) : slot, was = await orig(slotHex);
      await check(label, re, () => set(ethers.toQuantity(BigInt(slotHex)), val), () => set(ethers.toQuantity(BigInt(slotHex)), was));
    }
    // enabled module: modules[SENTINEL=1] -> X, modules[X] -> 1  (mapping at slot 1)
    const key = (k) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [k, 1])), s1 = "0x0000000000000000000000000000000000000001";
    const sA = key(s1), sB = key(hookA), wasA = await orig(sA), wasB = await orig(sB);
    await check("module enabled", /NO enabled modules/, async () => { await set(sA, word(hookA)); await set(sB, word(s1)); }, async () => { await set(sA, wasA); await set(sB, wasB); });
    // threshold changed after setup AND the operator pin follows it: only the "setup owners/threshold == current" row can catch this
    { const sl = "0x4", was = await orig(sl); await set(sl, ethers.zeroPadValue("0x03", 32));
      const f = fails(await readback(prov, { ...cfg, expectThreshold: "3" })); await set(sl, was);
      expect(f.some((n) => /no later change/.test(n)), f.join(" | ")).to.equal(true); }
    // wrong pins
    for (const [label, re, mut] of [
      ["wrong singleton code hash", /EXPECT_SINGLETON_CODEHASH/, { expectSingletonCodehash: ethers.ZeroHash }],
      ["wrong factory code hash", /EXPECT_FACTORY_CODEHASH/, { expectFactoryCodehash: ethers.ZeroHash }],
      ["wrong proxy code hash", /EXPECT_PROXY_CODEHASH/, { expectProxyCodehash: ethers.ZeroHash }],
      ["wrong owners", /EXPECT_OWNERS/, { expectOwners: [owners[0], owners[1], hookA] }],
      ["threshold pin 3", /EXPECT_THRESHOLD/, { expectThreshold: "3" }],
      ["owner is the hook (forbidden address) in the pin list", /owners == EXPECT_OWNERS|no owner/, { expectOwners: [owners[0], owners[1], hookA] }],
    ]) {
      const f = fails(await readback(prov, { ...cfg, ...mut }));
      expect(f.some((n) => re.test(n)), label + " -> " + f.join(" | ")).to.equal(true);
    }
  });
});
