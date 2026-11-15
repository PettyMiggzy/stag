// Wallet-owner mode (OWNER_IS_EOA=1): the platform owner is one plain wallet. Deploy + strict readback + negatives, on a mainnet fork.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { PM, STAG, E, fundStag } = require("./helpers");
const { hookInitCode, predictDeployer, mineSalt } = require("../scripts/lib");
const { deployAll } = require("../scripts/deploy");
const { readback } = require("../scripts/readback");
const { eoaOwnerChecks } = require("../scripts/lib");
const { spawnSync } = require("child_process");
const path = require("path");

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
    expect(fails(await readback(ethers.provider, { ...base, ownerIsEoa: false, expectOwnerEoa: undefined, dry: true })).some((n) => /constructor args/i.test(n))).to.equal(true);
  });

  it("rejects a mistyped checksum, accepts all-lowercase, relaxes only the nonce rule under dry, and prints the owner prominently", async () => {
    const good = owner.address, bad = good.slice(0, 5) + (good[5] === "a" ? "B" : "a").toUpperCase() + good.slice(6); // flips case of one hex char => bad checksum (unless digit)
    const flip = good.replace(/[a-f]/i, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
    const f = async (a, e, o = {}) => (await eoaOwnerChecks(ethers.provider, a, { expectOwner: e, ...o })).filter((r) => !r.ok).map((r) => r.name);
    expect((await f(good, flip)).some((n) => /valid addresses/.test(n))).to.equal(true);
    expect((await f(flip, good)).some((n) => /valid addresses/.test(n))).to.equal(true);
    expect(await f(good.toLowerCase(), good.toLowerCase())).to.deep.equal([]);
    expect((await f(fresh.address, fresh.address)).some((n) => /at least one transaction/.test(n))).to.equal(true);
    expect(await f(fresh.address, fresh.address, { dry: true })).to.deep.equal([]);            // dry rehearsal only: unused address allowed
    const rows = await eoaOwnerChecks(ethers.provider, good, { expectOwner: good });
    expect(rows.some((r) => /OWNER WALLET = /.test(r.name) && r.name.includes(good) && r.warn)).to.equal(true);
  });

  it("refuses an owner with short code (7702-style designator) and accepts nonce 1", async () => {
    const d = ethers.Wallet.createRandom().address;
    await ethers.provider.send("hardhat_setCode", [d, "0xef0100" + "11".repeat(20)]);
    const f = async (a) => (await eoaOwnerChecks(ethers.provider, a, { expectOwner: a })).filter((r) => !r.ok).map((r) => r.name);
    expect((await f(d)).some((n) => /plain wallet/.test(n))).to.equal(true);
    const e = ethers.Wallet.createRandom().address;
    await ethers.provider.send("hardhat_setNonce", [e, "0x1"]);
    expect(await f(e)).to.deep.equal([]);                       // nonce 1 is enough
  });

  it("CLI: wallet mode fails closed (exit 2) on a missing EXPECT_OWNER_EOA, and 'true' / '1 ' / '01' fall to Safe mode (also exit 2)", async () => {
    // a stub JSON-RPC that claims chain id 4663 on loopback, so the CLI treats both endpoints as the real chain (no network needed)
    const http = require("http"), { spawn } = require("child_process");
    const srv = http.createServer((q, r) => { let b = ""; q.on("data", (d) => (b += d)); q.on("end", () => { const j = JSON.parse(b || "{}"); const one = (m) => ({ jsonrpc: "2.0", id: m.id, result: m.method === "eth_chainId" ? "0x1237" : m.method === "net_version" ? "4663" : "0x0" }); r.setHeader("content-type", "application/json"); r.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j))); }); });
    await new Promise((res) => srv.listen(0, "127.0.0.1", res));
    const port = srv.address().port;
    const run = (extra) => new Promise((res) => {
      const env = { ...process.env, RPC: `http://127.0.0.1:${port}`, RPC2: `http://localhost:${port}`, DEPLOYER: owner.address, MULTISIG: owner.address, SALT_FILE: "x", DEPLOY_TX: "0x00", EXPECT_MANIFEST_DIGEST: "0x00", ...extra };
      delete env.DRYRUN;
      const c = spawn("node", [path.join(__dirname, "../scripts/readback.js")], { env }); let err = ""; c.stderr.on("data", (d) => (err += d)); c.on("close", (code) => res({ code, err }));
    });
    try {
      const miss = await run({ OWNER_IS_EOA: "1", EXPECT_OWNER_EOA: "" });
      expect(miss.code, miss.err).to.equal(2); expect(miss.err).to.match(/EXPECT_OWNER_EOA is required on mainnet/);
      for (const v of ["true", "1 ", "01"]) { const r = await run({ OWNER_IS_EOA: v, EXPECT_OWNER_EOA: owner.address }); expect(r.code, v + r.err).to.equal(2); expect(r.err, v).to.match(/EXPECT_OWNERS is required on mainnet/); }
    } finally { srv.close(); }
  });
});
