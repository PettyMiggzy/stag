// Independent security audit tests for RecordStake.sol.
// Self-contained: the hostile token + attacker used for the proofs are compiled in-memory with solc-js
// (same compiler/settings as the project) so no file other than this one is added.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture, time, mine } = require("@nomicfoundation/hardhat-network-helpers");
const solc = require("solc");

const E = (n) => ethers.parseEther(String(n));
const DAY = 86400n;
const U128 = (1n << 128n) - 1n;

// ---------------------------------------------------------------------------------------------
// In-memory helper contracts
// ---------------------------------------------------------------------------------------------
const HELPERS = `
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
interface IHook { function tokenHook(address from, address to, uint256 amount) external; }

/// Minimal ERC-20 with (a) optional transfer hooks and (b) a balance setter to simulate a rebase.
/// mode: 0 none | 1 recipient hook BEFORE balances move | 2 sender hook BEFORE (ERC-777 tokensToSend)
///       3 recipient hook AFTER (ERC-777 tokensReceived) | 4 sender hook AFTER
contract WeirdToken {
    string public name = "Weird"; string public symbol = "WRD"; uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public mode;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    function setMode(uint8 m) external { mode = m; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; totalSupply += a; emit Transfer(address(0), to, a); }
    function setBalance(address a, uint256 v) external { totalSupply = totalSupply - balanceOf[a] + v; balanceOf[a] = v; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; emit Approval(msg.sender, s, a); return true; }
    function transfer(address to, uint256 a) external returns (bool) { _move(msg.sender, to, a); return true; }
    function transferFrom(address from, address to, uint256 a) external returns (bool) {
        uint256 al = allowance[from][msg.sender];
        if (al != type(uint256).max) { require(al >= a, "allowance"); allowance[from][msg.sender] = al - a; }
        _move(from, to, a); return true;
    }
    function _move(address from, address to, uint256 a) internal {
        if (mode == 1) _hook(to, from, to, a);
        if (mode == 2) _hook(from, from, to, a);
        require(balanceOf[from] >= a, "balance");
        balanceOf[from] -= a; balanceOf[to] += a; emit Transfer(from, to, a);
        if (mode == 3) _hook(to, from, to, a);
        if (mode == 4) _hook(from, from, to, a);
    }
    function _hook(address who, address from, address to, uint256 a) internal {
        if (who.code.length == 0) return;
        try IHook(who).tokenHook(from, to, a) {} catch {}
    }
}

/// Generic attacker: forwards arbitrary calls, and on a token hook fires one pre-armed call.
contract Hooker {
    address public target; bytes public data; bool public armed; bool public lastOk; bytes public lastRet; uint256 public hits;
    function arm(address t, bytes calldata d) external { target = t; data = d; armed = true; }
    function exec(address t, bytes calldata d) external returns (bytes memory) {
        (bool ok, bytes memory r) = t.call(d);
        if (!ok) { assembly { revert(add(r, 32), mload(r)) } }
        return r;
    }
    function tokenHook(address, address, uint256) external {
        if (!armed) return;
        armed = false; hits++;
        (lastOk, lastRet) = target.call(data);
    }
}`;

let compiled;
function helpers() {
  if (compiled) return compiled;
  const input = {
    language: "Solidity",
    sources: { "H.sol": { content: HELPERS } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join("\n"));
  compiled = out.contracts["H.sol"];
  return compiled;
}
// Compile RecordStake.sol itself in memory (optionally with a text mutation) with the project's settings.
// Used for the mutation sanity check: the on-disk contract is never touched.
const fs = require("fs"), path = require("path");
const RS_SRC = fs.readFileSync(path.join(__dirname, "..", "src", "RecordStake.sol"), "utf8");
function compileRecordStake(mutate) {
  let src = RS_SRC;
  if (mutate) { const [a, b] = mutate; if (src.split(a).length !== 2) throw new Error("mutation anchor not found exactly once: " + a); src = src.replace(a, b); }
  const input = {
    language: "Solidity",
    sources: { "RecordStake.sol": { content: src } },
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const findImports = (p) => { try { return { contents: fs.readFileSync(path.join(__dirname, "..", "node_modules", p), "utf8") }; } catch (e) { return { error: String(e) }; } };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts["RecordStake.sol"].RecordStake;
  return async () => new ethers.ContractFactory(c.abi, "0x" + c.evm.bytecode.object, (await ethers.getSigners())[0]);
}
async function deployHelper(name, signer) {
  const c = helpers()[name];
  const f = new ethers.ContractFactory(c.abi, "0x" + c.evm.bytecode.object, signer);
  const d = await f.deploy(); await d.waitForDeployment(); return d;
}

// seeded PRNG so fuzz failures are reproducible
function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const tsOf = async (tx) => BigInt((await ethers.provider.getBlock((await tx.wait()).blockNumber)).timestamp);

describe("RecordStake audit", function () {
  this.timeout(600000);

  async function deploy() {
    const [owner, alice, bob, eve, dan] = await ethers.getSigners();
    const stag = await (await ethers.getContractFactory("MockERC20")).deploy();
    const rs = await (await ethers.getContractFactory("RecordStake")).deploy(await stag.getAddress(), owner.address);
    for (const u of [alice, bob, eve, dan]) { await stag.mint(u.address, E(10_000_000)); await stag.connect(u).approve(await rs.getAddress(), ethers.MaxUint256); }
    await rs.setRecord(1, true); await rs.setRecord(2, true); await rs.setRecord(3, true);
    return { owner, alice, bob, eve, dan, stag, rs, rsAddr: await rs.getAddress(), stagAddr: await stag.getAddress() };
  }
  async function deployWeird() {
    const [deployer, alice, bob] = await ethers.getSigners();
    const tok = await deployHelper("WeirdToken", deployer);
    const hooker = await deployHelper("Hooker", deployer);
    return { deployer, alice, bob, tok, hooker, tokAddr: await tok.getAddress(), hookerAddr: await hooker.getAddress() };
  }

  // =============================================================================================
  // FINDINGS (each test PROVES the behaviour described; they pass when the issue is present)
  // =============================================================================================
  describe("findings", () => {
    it("F1 fixed: a top-up one second after a small stake no longer back-dates the big amount (since rounds UP)", async () => {
      const { alice, rs } = await loadFixture(deploy);
      const t0 = await tsOf(await rs.connect(alice).stake(1, E(1)));
      await time.setNextBlockTimestamp(t0 + 1n);
      await rs.connect(alice).stake(1, E(1_000_000));
      // exact weighted average is t0 + 1 - ~1e-6; ceil gives t0 + 1 == block.timestamp (never above it)
      expect((await rs.positions(alice.address, 1)).since).to.equal(t0 + 1n);
      expect(await rs.points(alice.address, 1)).to.equal(0n);
    });

    it("F1 fixed: the old 'top up just under amount/age' loop now never claims more token-seconds than were really accrued", async () => {
      const { alice, rs } = await loadFixture(deploy);
      const A0 = E(1);
      const t0 = await tsOf(await rs.connect(alice).stake(1, A0));
      let amt = A0, trueTokenSeconds = 0n, last = t0, since = t0;
      for (let k = 1n; k <= 20n; k++) { // position doubles each second under the fix (since snaps to now), so keep it short
        const now = t0 + k;
        trueTokenSeconds += amt * (now - last); last = now;
        const delta = now - since;
        // same sizing the old exploit used: largest got with delta * got < amt + got
        const got = delta <= 1n ? amt : (amt - 1n) / (delta - 1n);
        await time.setNextBlockTimestamp(now);
        await rs.connect(alice).stake(1, got);
        amt += got;
        const s2 = (await rs.positions(alice.address, 1)).since;
        expect(s2).to.be.greaterThanOrEqual(since); expect(s2).to.be.lessThanOrEqual(now); // never back, never in the future
        since = s2;
        expect(amt * (now - since)).to.be.lessThanOrEqual(trueTokenSeconds); // claimed <= earned, at every step
      }
    });

    it("F1 fixed: brute force over small amounts/ages: ceil never exceeds now, never goes back, and never gains a token-second", async () => {
      const { alice, rs } = await loadFixture(deploy);
      const r = rng(555);
      for (let n = 0; n < 40; n++) {
        const old = E(1) + BigInt(Math.floor(r() * 50));          // around the minimum, awkward remainders
        const t0 = await tsOf(await rs.connect(alice).stake(3, old));
        const delta = BigInt(1 + Math.floor(r() * 7));
        const got = r() < 0.5 ? BigInt(1 + Math.floor(r() * 20)) : E(1) / BigInt(1 + Math.floor(r() * 9)) + BigInt(Math.floor(r() * 5));
        await time.setNextBlockTimestamp(t0 + delta);
        await rs.connect(alice).stake(3, got);
        const since = (await rs.positions(alice.address, 3)).since, now = t0 + delta, next = old + got;
        expect(since).to.equal((t0 * old + now * got + next - 1n) / next);
        expect(since).to.be.lessThanOrEqual(now); expect(since).to.be.greaterThanOrEqual(t0);
        expect(next * (now - since)).to.be.lessThanOrEqual(old * delta);       // no gain
        expect(old * delta - next * (now - since)).to.be.lessThan(next);       // loss < 1 token-second per token
        await rs.connect(alice).unstake(3, next);
      }
    });

    it("F2 fixed: rescue() is nonReentrant, so an owner-staker cannot rescue from inside unstake() even with a hook-before-debit token", async () => {
      const { alice, tok, hooker, tokAddr, hookerAddr } = await loadFixture(deployWeird);
      const rs = await (await ethers.getContractFactory("RecordStake")).deploy(tokAddr, hookerAddr); // owner = attacker contract
      const rsAddr = await rs.getAddress();
      await hooker.exec(rsAddr, rs.interface.encodeFunctionData("setRecord", [1, true]));
      await tok.mint(alice.address, E(1000)); await tok.connect(alice).approve(rsAddr, ethers.MaxUint256);
      await tok.mint(hookerAddr, E(1000)); await hooker.exec(tokAddr, tok.interface.encodeFunctionData("approve", [rsAddr, ethers.MaxUint256]));
      await rs.connect(alice).stake(1, E(1000));
      await hooker.exec(rsAddr, rs.interface.encodeFunctionData("stake", [1, E(1000)]));
      expect(await rs.totalStaked()).to.equal(E(2000));

      await tok.setMode(1); // token calls the recipient before it debits the sender
      await hooker.arm(rsAddr, rs.interface.encodeFunctionData("rescue", [tokAddr, hookerAddr, E(1000)]));
      await hooker.exec(rsAddr, rs.interface.encodeFunctionData("unstake", [1, E(1000)]));

      expect(await hooker.hits()).to.equal(1n);                      // the hook did fire and did try
      expect(await hooker.lastOk()).to.equal(false);
      expect(await hooker.lastRet()).to.equal(rs.interface.getError("ReentrancyGuardReentrantCall").selector);
      expect(await tok.balanceOf(hookerAddr)).to.equal(E(1000));     // owner only got their own stake back
      expect(await tok.balanceOf(rsAddr)).to.equal(E(1000));
      expect(await rs.totalStaked()).to.equal(E(1000));
      await rs.connect(alice).unstake(1, E(1000));                   // alice is whole
      expect(await tok.balanceOf(alice.address)).to.equal(E(1000));
    });

    it("F2 control: with a standard ERC-777 ordering (hook after balances move) the same attack gets nothing", async () => {
      const { alice, tok, hooker, tokAddr, hookerAddr } = await loadFixture(deployWeird);
      const rs = await (await ethers.getContractFactory("RecordStake")).deploy(tokAddr, hookerAddr);
      const rsAddr = await rs.getAddress();
      await hooker.exec(rsAddr, rs.interface.encodeFunctionData("setRecord", [1, true]));
      await tok.mint(alice.address, E(1000)); await tok.connect(alice).approve(rsAddr, ethers.MaxUint256);
      await tok.mint(hookerAddr, E(1000)); await hooker.exec(tokAddr, tok.interface.encodeFunctionData("approve", [rsAddr, ethers.MaxUint256]));
      await rs.connect(alice).stake(1, E(1000));
      await hooker.exec(rsAddr, rs.interface.encodeFunctionData("stake", [1, E(1000)]));
      await tok.setMode(3);
      await hooker.arm(rsAddr, rs.interface.encodeFunctionData("rescue", [tokAddr, hookerAddr, 1n]));
      await hooker.exec(rsAddr, rs.interface.encodeFunctionData("unstake", [1, E(1000)]));
      expect(await hooker.hits()).to.equal(1n);
      expect(await hooker.lastOk()).to.equal(false); // NotSpare
      expect(await tok.balanceOf(hookerAddr)).to.equal(E(1000));
      await rs.connect(alice).unstake(1, E(1000));
      expect(await tok.balanceOf(alice.address)).to.equal(E(1000));
    });

    it("F3 [info, unsupported token]: after a negative rebase rescue() now fails cleanly with NotSpare; the last unstaker still carries the loss", async () => {
      const { deployer, alice, bob, tok, tokAddr } = await loadFixture(deployWeird);
      const rs = await (await ethers.getContractFactory("RecordStake")).deploy(tokAddr, deployer.address);
      const rsAddr = await rs.getAddress(); await rs.setRecord(1, true);
      for (const u of [alice, bob]) { await tok.mint(u.address, E(1000)); await tok.connect(u).approve(rsAddr, ethers.MaxUint256); await rs.connect(u).stake(1, E(1000)); }
      await tok.setBalance(rsAddr, E(1800)); // -10% rebase
      await expect(rs.rescue(tokAddr, deployer.address, 0)).to.be.revertedWithCustomError(rs, "NotSpare"); // was Panic(0x11)
      await expect(rs.rescue(tokAddr, deployer.address, 1)).to.be.revertedWithCustomError(rs, "NotSpare");
      await rs.connect(alice).unstake(1, E(1000));                       // first out is made whole
      await expect(rs.connect(bob).unstake(1, E(1000))).to.be.revertedWith("balance"); // last out is stuck for the full amount
      await rs.connect(bob).unstake(1, E(800));                          // and eats the whole loss
      expect((await rs.positions(bob.address, 1)).amount).to.equal(E(200));
    });

    it("F3 [info, unsupported token]: a positive rebase is 'spare', so the owner can take the stakers' rebase gains", async () => {
      const { deployer, alice, tok, tokAddr } = await loadFixture(deployWeird);
      const rs = await (await ethers.getContractFactory("RecordStake")).deploy(tokAddr, deployer.address);
      const rsAddr = await rs.getAddress(); await rs.setRecord(1, true);
      await tok.mint(alice.address, E(1000)); await tok.connect(alice).approve(rsAddr, ethers.MaxUint256); await rs.connect(alice).stake(1, E(1000));
      await tok.setBalance(rsAddr, E(1100)); // +10% rebase
      await rs.rescue(tokAddr, deployer.address, E(100));
      expect(await tok.balanceOf(deployer.address)).to.equal(E(100));
      await expect(rs.rescue(tokAddr, deployer.address, 1n)).to.be.revertedWithCustomError(rs, "NotSpare");
      await rs.connect(alice).unstake(1, E(1000)); // principal still safe
    });

    it("F4 [info, unsupported token]: with a fee-on-transfer token the staker pays the fee twice and the Staked event reports the net amount, not the amount asked", async () => {
      const [owner, alice] = await ethers.getSigners();
      const fee = await (await ethers.getContractFactory("MockFeeToken")).deploy(500);
      const rs = await (await ethers.getContractFactory("RecordStake")).deploy(await fee.getAddress(), owner.address);
      await fee.mint(alice.address, E(1000)); await fee.connect(alice).approve(await rs.getAddress(), ethers.MaxUint256); await rs.setRecord(1, true);
      const tx = await rs.connect(alice).stake(1, E(1000));
      const ts = await tsOf(tx);
      await expect(tx).to.emit(rs, "Staked").withArgs(alice.address, 1, E(950), E(950), ts);
      await expect(rs.connect(alice).unstake(1, E(950))).to.emit(rs, "Unstaked").withArgs(alice.address, 1, E(950), 0);
      expect(await fee.balanceOf(alice.address)).to.equal(E(902.5)); // "always the full amount asked for" is not what arrives
      expect(await fee.balanceOf(await rs.getAddress())).to.equal(0n);
      expect(await rs.totalStaked()).to.equal(0n);
    });

    it("F5 fixed (entry): a stake that leaves the position under one whole token reverts TooLittle and moves no tokens", async () => {
      const { alice, rs, stag, rsAddr } = await loadFixture(deploy);
      expect(await rs.MIN_POSITION()).to.equal(E(1));
      await expect(rs.connect(alice).stake(2, 1n)).to.be.revertedWithCustomError(rs, "TooLittle");
      await expect(rs.connect(alice).stake(2, E(1) - 1n)).to.be.revertedWithCustomError(rs, "TooLittle");
      expect(await stag.balanceOf(rsAddr)).to.equal(0n); expect(await rs.recordStakers(2)).to.equal(0n);
      await rs.connect(alice).stake(2, E(1));       // exactly the minimum is fine
      await rs.connect(alice).stake(2, 1n);         // dust top-up of a valid position is fine
      expect(await rs.recordStakers(2)).to.equal(1n);
    });

    it("F5 residual [info]: MIN_POSITION is not enforced on unstake, so ONE token recycled through N wallets still yields N counted 1-wei stakers", async () => {
      const { alice, bob, eve, dan, rs, stag } = await loadFixture(deploy);
      const wallets = [alice, bob, eve, dan];
      for (const u of wallets) {
        await rs.connect(u).stake(2, E(1));
        await rs.connect(u).unstake(2, E(1) - 1n);  // leaves 1 wei, still counted as a staker
      }
      expect(await rs.recordStakers(2)).to.equal(4n);
      expect(await rs.recordTotal(2)).to.equal(4n); // 4 wei in total backs "4 stakers"
      // a dust position is never trapped: it can exit in full, and can be topped back up over the minimum
      await expect(rs.connect(alice).stake(2, 1n)).to.be.revertedWithCustomError(rs, "TooLittle"); // 2 wei < min
      await rs.connect(alice).stake(2, E(1) - 1n);  // 1 wei + this == exactly 1 token
      await rs.connect(bob).unstake(2, 1n);
      expect(await stag.balanceOf(bob.address)).to.equal(E(10_000_000));
      expect(await rs.recordStakers(2)).to.equal(3n);
    });

    it("MIN_POSITION can never block an exit: any amount from 1 wei to the full position can be unstaked, on a closed record, leaving any remainder", async () => {
      const { alice, rs, stag } = await loadFixture(deploy);
      await rs.connect(alice).stake(1, E(1)); await rs.setRecord(1, false);
      await rs.connect(alice).unstake(1, 1n);                 // leaves 1e18 - 1 (< min)
      await rs.connect(alice).unstake(1, E(1) - 3n);          // leaves 2 wei
      await rs.connect(alice).unstake(1, 1n); await rs.connect(alice).unstake(1, 1n);
      expect(await stag.balanceOf(alice.address)).to.equal(E(10_000_000));
      expect(await rs.recordStakers(1)).to.equal(0n); expect(await rs.totalStaked()).to.equal(0n);
    });
  });

  // =============================================================================================
  // CHECKED AND FOUND SOUND
  // =============================================================================================
  describe("reentrancy", () => {
    // staker is a contract that re-enters from every hook position, into every state-changing function
    for (const mode of [1, 2, 3, 4]) {
      for (const inner of ["stake", "unstake"]) {
        it(`hook mode ${mode}: re-entering ${inner}() from a token hook is blocked in both stake() and unstake()`, async () => {
          const { deployer, alice, tok, hooker, tokAddr, hookerAddr } = await loadFixture(deployWeird);
          const rs = await (await ethers.getContractFactory("RecordStake")).deploy(tokAddr, deployer.address);
          const rsAddr = await rs.getAddress(); await rs.setRecord(1, true);
          await tok.mint(alice.address, E(1000)); await tok.connect(alice).approve(rsAddr, ethers.MaxUint256); await rs.connect(alice).stake(1, E(1000));
          await tok.mint(hookerAddr, E(1000)); await hooker.exec(tokAddr, tok.interface.encodeFunctionData("approve", [rsAddr, ethers.MaxUint256]));
          await hooker.exec(rsAddr, rs.interface.encodeFunctionData("stake", [1, E(100)]));
          await tok.setMode(mode);
          const innerData = rs.interface.encodeFunctionData(inner, [1, E(50)]);
          const guardErr = rs.interface.getError("ReentrancyGuardReentrantCall").selector;

          // outer = stake
          await hooker.arm(rsAddr, innerData);
          await hooker.exec(rsAddr, rs.interface.encodeFunctionData("stake", [1, E(100)]));
          if ((await hooker.hits()) > 0n) { expect(await hooker.lastOk()).to.equal(false); expect(await hooker.lastRet()).to.equal(guardErr); }
          // outer = unstake
          const hitsBefore = await hooker.hits();
          await hooker.arm(rsAddr, innerData);
          await hooker.exec(rsAddr, rs.interface.encodeFunctionData("unstake", [1, E(100)]));
          if ((await hooker.hits()) > hitsBefore) { expect(await hooker.lastOk()).to.equal(false); expect(await hooker.lastRet()).to.equal(guardErr); }
          // at least one of the two outer calls must actually have exercised the hook
          expect(await hooker.hits()).to.be.greaterThan(0n);

          expect((await rs.positions(hookerAddr, 1)).amount).to.equal(E(100));
          expect(await rs.totalStaked()).to.equal(E(1100));
          expect(await tok.balanceOf(rsAddr)).to.equal(E(1100));
          expect(await tok.balanceOf(hookerAddr)).to.equal(E(900));
        });
      }
    }

    it("owner==staker calling rescue() from a hook during stake() gains nothing (all four hook positions)", async () => {
      for (const mode of [1, 2, 3, 4]) {
        const { alice, tok, hooker, tokAddr, hookerAddr } = await loadFixture(deployWeird);
        const rs = await (await ethers.getContractFactory("RecordStake")).deploy(tokAddr, hookerAddr);
        const rsAddr = await rs.getAddress();
        await hooker.exec(rsAddr, rs.interface.encodeFunctionData("setRecord", [1, true]));
        await tok.mint(alice.address, E(1000)); await tok.connect(alice).approve(rsAddr, ethers.MaxUint256); await rs.connect(alice).stake(1, E(1000));
        await tok.mint(hookerAddr, E(1000)); await hooker.exec(tokAddr, tok.interface.encodeFunctionData("approve", [rsAddr, ethers.MaxUint256]));
        await tok.setMode(mode);
        // try to pull back all but 1 wei of what is being staked, mid-stake
        await hooker.arm(rsAddr, rs.interface.encodeFunctionData("rescue", [tokAddr, hookerAddr, E(100) - 1n]));
        await hooker.exec(rsAddr, rs.interface.encodeFunctionData("stake", [1, E(100)]));
        const pos = (await rs.positions(hookerAddr, 1)).amount;
        const bal = await tok.balanceOf(hookerAddr);
        expect(pos + bal, `mode ${mode}`).to.equal(E(1000));                       // attacker wealth unchanged
        expect(await tok.balanceOf(rsAddr), `mode ${mode}`).to.equal(await rs.totalStaked()); // no shortfall
        await tok.setMode(0);
        await rs.connect(alice).unstake(1, E(1000));
      }
    });

    it("a donation made from inside the stake() transfer hook is simply credited to the donor (no free credit)", async () => {
      const { deployer, tok, hooker, tokAddr, hookerAddr } = await loadFixture(deployWeird);
      const rs = await (await ethers.getContractFactory("RecordStake")).deploy(tokAddr, deployer.address);
      const rsAddr = await rs.getAddress(); await rs.setRecord(1, true);
      await tok.mint(hookerAddr, E(1000)); await hooker.exec(tokAddr, tok.interface.encodeFunctionData("approve", [rsAddr, ethers.MaxUint256]));
      await tok.setMode(2);
      await hooker.arm(tokAddr, tok.interface.encodeFunctionData("transfer", [rsAddr, E(40)]));
      await hooker.exec(rsAddr, rs.interface.encodeFunctionData("stake", [1, E(100)]));
      expect((await rs.positions(hookerAddr, 1)).amount).to.equal(E(140));
      expect(await tok.balanceOf(hookerAddr)).to.equal(E(860));
      expect(await rs.totalStaked()).to.equal(await tok.balanceOf(rsAddr));
    });
  });

  describe("since / points maths", () => {
    it("flash stake (stake + unstake in one block) and stake-only-in-this-block earn zero points", async () => {
      const { alice, bob, rs } = await loadFixture(deploy);
      await network.provider.send("evm_setAutomine", [false]);
      const a = await rs.connect(alice).stake(1, E(5_000_000));
      const b = await rs.connect(alice).unstake(1, E(5_000_000));
      const c = await rs.connect(bob).stake(1, E(5_000_000));
      await network.provider.send("evm_mine"); await network.provider.send("evm_setAutomine", [true]);
      const ra = await a.wait(), rb = await b.wait(), rc = await c.wait();
      expect(ra.blockNumber).to.equal(rb.blockNumber); expect(rc.blockNumber).to.equal(ra.blockNumber);
      expect(await rs.points(alice.address, 1)).to.equal(0n);
      expect(await rs.points(bob.address, 1)).to.equal(0n);
      expect(await rs.recordStakers(1)).to.equal(1n);
    });

    it("a minimum stake held for a year does not back-date a later large top-up", async () => {
      const { alice, rs } = await loadFixture(deploy);
      const t0 = await tsOf(await rs.connect(alice).stake(1, E(1)));
      await time.increase(365n * DAY);
      const before = await rs.points(alice.address, 1);                     // 1 token x 365 days
      const t1 = await tsOf(await rs.connect(alice).stake(1, E(1_000_000)));
      const since = (await rs.positions(alice.address, 1)).since;
      expect(since).to.be.lessThanOrEqual(t1); expect(since).to.be.greaterThan(t0);
      expect(t1 - since).to.be.lessThanOrEqual(32n);                         // 1 token-year spread over 1M tokens ~ 31.5s
      expect(await rs.points(alice.address, 1)).to.be.lessThanOrEqual(before); // never more than was earned
    });

    it("stake/unstake cycling and partial unstake can only lose points, never gain", async () => {
      const { alice, rs } = await loadFixture(deploy);
      await rs.connect(alice).stake(1, E(1000)); await time.increase(30n * DAY);
      const before = await rs.points(alice.address, 1);
      await rs.connect(alice).unstake(1, 1n); // 1 wei out
      expect(await rs.points(alice.address, 1)).to.equal(0n);
      await rs.connect(alice).stake(1, 1n);
      expect(await rs.points(alice.address, 1)).to.equal(0n);
      expect(before).to.be.closeTo(30_000n, 1n);
      // full exit then re-entry: since is the re-entry time, not the stale one
      await rs.connect(alice).unstake(1, E(1000)); await time.increase(10n * DAY);
      const t = await tsOf(await rs.connect(alice).stake(1, E(1000)));
      expect((await rs.positions(alice.address, 1)).since).to.equal(t);
    });

    it("no overflow at the uint128 cap; one wei over reverts TooMuch; weighted maths stays in range at huge amounts and timestamps", async () => {
      const [owner, alice] = await ethers.getSigners();
      const stag = await (await ethers.getContractFactory("MockERC20")).deploy();
      const rs = await (await ethers.getContractFactory("RecordStake")).deploy(await stag.getAddress(), owner.address);
      await rs.setRecord(1, true);
      await stag.mint(alice.address, U128 + 10n); await stag.connect(alice).approve(await rs.getAddress(), ethers.MaxUint256);
      await expect(rs.connect(alice).stake(1, U128 + 1n)).to.be.revertedWithCustomError(rs, "TooMuch");
      const half = 1n << 127n;
      const t0 = await tsOf(await rs.connect(alice).stake(1, half));
      await time.setNextBlockTimestamp(4_000_000_000n); // year 2096
      const t1 = await tsOf(await rs.connect(alice).stake(1, half - 1n));
      const exp = (t0 * half + t1 * (half - 1n) + U128 - 1n) / U128; expect(exp).to.be.lessThanOrEqual(t1);
      expect((await rs.positions(alice.address, 1)).since).to.equal(exp);
      expect((await rs.positions(alice.address, 1)).amount).to.equal(U128);
      await expect(rs.connect(alice).stake(1, 1n)).to.be.revertedWithCustomError(rs, "TooMuch");
      await time.increase(1000n * DAY);
      await rs.points(alice.address, 1); // does not overflow
      await rs.connect(alice).unstake(1, U128);
      expect(await stag.balanceOf(alice.address)).to.equal(U128 + 10n);
    });
  });

  describe("owner powers", () => {
    it("rescue: any non-STAG token in full; STAG only above totalStaked; exact-spare boundary; nothing when all is staked", async () => {
      const { owner, alice, eve, rs, stag, rsAddr, stagAddr } = await loadFixture(deploy);
      const other = await (await ethers.getContractFactory("MockERC20")).deploy();
      await other.mint(rsAddr, E(5));
      await rs.rescue(await other.getAddress(), eve.address, E(5));
      expect(await other.balanceOf(eve.address)).to.equal(E(5));
      await rs.connect(alice).stake(1, E(1000));
      await expect(rs.rescue(stagAddr, owner.address, 1n)).to.be.revertedWithCustomError(rs, "NotSpare");
      await stag.connect(eve).transfer(rsAddr, 3n);
      await expect(rs.rescue(stagAddr, owner.address, 4n)).to.be.revertedWithCustomError(rs, "NotSpare");
      await rs.rescue(stagAddr, owner.address, 3n);
      await rs.rescue(stagAddr, owner.address, 0n); // no-op, allowed
      expect(await stag.balanceOf(rsAddr)).to.equal(await rs.totalStaked());
    });

    it("closing a record, renouncing ownership, or a half-finished 2-step handover never blocks unstake", async () => {
      const { owner, alice, bob, eve, rs, stag, stagAddr } = await loadFixture(deploy);
      await rs.connect(alice).stake(1, E(1000)); await rs.connect(bob).stake(2, E(500));
      await rs.setRecord(1, false);
      await rs.transferOwnership(eve.address);
      // pending owner has no power yet; old owner still has it
      await expect(rs.connect(eve).setRecord(1, true)).to.be.revertedWithCustomError(rs, "OwnableUnauthorizedAccount");
      await expect(rs.connect(eve).rescue(stagAddr, eve.address, 0)).to.be.revertedWithCustomError(rs, "OwnableUnauthorizedAccount");
      await rs.connect(alice).unstake(1, E(400));
      await rs.connect(eve).acceptOwnership();
      await expect(rs.connect(owner).setRecord(1, true)).to.be.revertedWithCustomError(rs, "OwnableUnauthorizedAccount");
      await expect(rs.connect(eve).rescue(stagAddr, eve.address, 1n)).to.be.revertedWithCustomError(rs, "NotSpare");
      await rs.connect(eve).renounceOwnership();
      expect(await rs.owner()).to.equal(ethers.ZeroAddress);
      await expect(rs.connect(eve).setRecord(2, false)).to.be.revertedWithCustomError(rs, "OwnableUnauthorizedAccount");
      await rs.connect(alice).unstake(1, E(600)); await rs.connect(bob).unstake(2, E(500));
      expect(await stag.balanceOf(alice.address)).to.equal(E(10_000_000)); expect(await stag.balanceOf(bob.address)).to.equal(E(10_000_000));
      expect(await rs.totalStaked()).to.equal(0n);
      // record 2 was open at renounce time and stays open for ever; record 1 stays closed for ever
      await rs.connect(bob).stake(2, E(1));
      await expect(rs.connect(bob).stake(1, E(1))).to.be.revertedWithCustomError(rs, "RecordClosed");
    });

    it("constructor rejects zero token and zero owner; contract cannot receive ETH", async () => {
      const [owner] = await ethers.getSigners();
      const F = await ethers.getContractFactory("RecordStake");
      const stag = await (await ethers.getContractFactory("MockERC20")).deploy();
      await expect(F.deploy(ethers.ZeroAddress, owner.address)).to.be.revertedWith("stag=0");
      await expect(F.deploy(await stag.getAddress(), ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "OwnableInvalidOwner");
      const rs = await F.deploy(await stag.getAddress(), owner.address);
      await expect(owner.sendTransaction({ to: await rs.getAddress(), value: 1n })).to.be.reverted;
    });
  });

  describe("events (indexer view)", () => {
    it("replaying Staked/Unstaked/RecordSet alone reconstructs every position, since, total and staker count", async () => {
      const { owner, alice, bob, eve, rs } = await loadFixture(deploy);
      const users = [alice, bob, eve];
      const r = rng(4242);
      for (let i = 0; i < 120; i++) {
        const u = users[Math.floor(r() * 3)], rec = 1 + Math.floor(r() * 3);
        const pos = (await rs.positions(u.address, rec)).amount;
        const x = r();
        if (x < 0.05) await rs.connect(owner).setRecord(rec, !(await rs.recordOpen(rec)));
        else if (x < 0.6 || pos === 0n) { if (await rs.recordOpen(rec)) await rs.connect(u).stake(rec, E(1) + BigInt(Math.floor(r() * 1e6)) * 10n ** 15n + 1n); }
        else await rs.connect(u).unstake(rec, r() < 0.4 ? pos : (pos * BigInt(1 + Math.floor(r() * 99))) / 100n || 1n);
        if (r() < 0.5) await time.increase(Math.floor(r() * 100000));
      }
      // rebuild from logs only
      const logs = await rs.queryFilter("*", 0);
      const P = {}, total = {}, stakers = {}, open = {}; let grand = 0n;
      for (const l of logs) {
        if (!l.fragment) continue;
        const a = l.args;
        if (l.fragment.name === "RecordSet") open[a.recordId] = a.open;
        if (l.fragment.name === "Staked") {
          const k = a.user + ":" + a.recordId, prev = P[k]?.amount ?? 0n;
          expect(a.newAmount).to.equal(prev + a.amount);
          if (prev === 0n) stakers[a.recordId] = (stakers[a.recordId] ?? 0n) + 1n;
          P[k] = { amount: a.newAmount, since: a.since };
          total[a.recordId] = (total[a.recordId] ?? 0n) + a.amount; grand += a.amount;
        }
        if (l.fragment.name === "Unstaked") {
          const k = a.user + ":" + a.recordId;
          expect(a.newAmount).to.equal(P[k].amount - a.amount);
          const ts = BigInt((await l.getBlock()).timestamp); // Unstaked carries no `since`: indexer must use block time
          P[k] = { amount: a.newAmount, since: ts };
          if (a.newAmount === 0n) stakers[a.recordId] -= 1n;
          total[a.recordId] -= a.amount; grand -= a.amount;
        }
      }
      for (const u of users) for (const rec of [1n, 2n, 3n]) {
        const on = await rs.positions(u.address, rec), off = P[u.address + ":" + rec] ?? { amount: 0n, since: 0n };
        expect(on.amount).to.equal(off.amount); expect(on.since).to.equal(off.since);
      }
      for (const rec of [1n, 2n, 3n]) {
        expect(await rs.recordTotal(rec)).to.equal(total[rec] ?? 0n);
        expect(await rs.recordStakers(rec)).to.equal(stakers[rec] ?? 0n);
        expect(await rs.recordOpen(rec)).to.equal(open[rec] ?? false);
      }
      expect(await rs.totalStaked()).to.equal(grand);
    });
  });

  // =============================================================================================
  // INVARIANT / FUZZ
  // =============================================================================================
  describe("invariant fuzz", () => {
    async function run(seed, steps, feeBps, rsFactory) {
      const [owner, ...rest] = await ethers.getSigners();
      const users = rest.slice(0, 5);
      const stag = feeBps === null
        ? await (await ethers.getContractFactory("MockERC20")).deploy()
        : await (await ethers.getContractFactory("MockFeeToken")).deploy(feeBps);
      const rs = await (rsFactory ? await rsFactory() : await ethers.getContractFactory("RecordStake")).deploy(await stag.getAddress(), owner.address);
      await rs.waitForDeployment();
      const rsAddr = await rs.getAddress(), stagAddr = await stag.getAddress();
      const MIN = E(1);
      const recs = [1n, 2n, 3n, 4n];
      const START = E(1_000_000);
      for (const u of users) { await stag.mint(u.address, START); await stag.connect(u).approve(rsAddr, ethers.MaxUint256); }
      await stag.mint(owner.address, START);
      const r = rng(seed);
      const model = {}; const open = {}; const total = {}; const stakers = {}; let grand = 0n, spare = 0n;
      const key = (u, rec) => u.address + ":" + rec;
      const net = (v) => feeBps === null ? v : v - (v * BigInt(feeBps)) / 10000n;
      const pick = (arr) => arr[Math.floor(r() * arr.length)];
      const randAmt = () => {
        const x = r();
        if (x < 0.15) return BigInt(1 + Math.floor(r() * 1000));                 // dust
        if (x < 0.3) return E(1) * BigInt(1 + Math.floor(r() * 100000));         // large
        return BigInt(Math.floor(r() * 1e9)) * 10n ** 12n + BigInt(Math.floor(r() * 1e6)); // odd wei
      };

      for (let i = 0; i < steps; i++) {
        const u = pick(users), rec = pick(recs), k = key(u, rec);
        const m = model[k] ?? { amount: 0n, since: 0n };
        const x = r();
        if (x < 0.08) {
          const o = r() < 0.7; await rs.setRecord(rec, o); open[rec] = o;
        } else if (x < 0.14) {
          const d = randAmt(); await stag.connect(owner).transfer(rsAddr, d); spare += net(d);           // stray transfer
        } else if (x < 0.20) {
          // owner tries to take one wei more than the spare (and far more), then takes a random part of the spare
          await expect(rs.rescue(stagAddr, owner.address, spare + grand + 1n)).to.be.revertedWithCustomError(rs, "NotSpare");
          await expect(rs.rescue(stagAddr, owner.address, spare + 1n)).to.be.revertedWithCustomError(rs, "NotSpare");
          const take = spare === 0n ? 0n : (spare * BigInt(Math.floor(r() * 101))) / 100n;
          await rs.rescue(stagAddr, owner.address, take); spare -= take;
        } else if (x < 0.62) {
          const amt = randAmt();
          if (!open[rec]) { await expect(rs.connect(u).stake(rec, amt)).to.be.revertedWithCustomError(rs, "RecordClosed"); continue; }
          const got = net(amt);
          if (got === 0n) { await expect(rs.connect(u).stake(rec, amt)).to.be.revertedWithCustomError(rs, "ZeroAmount"); continue; }
          const next = m.amount + got;
          if (next < MIN) {
            const b0 = await stag.balanceOf(u.address);
            await expect(rs.connect(u).stake(rec, amt)).to.be.revertedWithCustomError(rs, "TooLittle");
            expect(await stag.balanceOf(u.address)).to.equal(b0); continue;
          }
          const tx = await rs.connect(u).stake(rec, amt); const ts = await tsOf(tx);
          const since = m.amount === 0n ? ts : (m.since * m.amount + ts * got + next - 1n) / next;
          if (m.amount === 0n) stakers[rec] = (stakers[rec] ?? 0n) + 1n;
          // since never moves backwards on a top-up, never ahead of now; rounding never GAINS points and costs < 1s
          if (m.amount !== 0n) { expect(since).to.be.greaterThanOrEqual(m.since); expect(since).to.be.lessThanOrEqual(ts);
            const before = m.amount * (ts - m.since), after = next * (ts - since);
            expect(after).to.be.lessThanOrEqual(before); expect(before - after).to.be.lessThan(next); }
          model[k] = { amount: next, since }; total[rec] = (total[rec] ?? 0n) + got; grand += got;
          await expect(tx).to.emit(rs, "Staked").withArgs(u.address, rec, got, next, since);
        } else {
          if (m.amount === 0n) { await expect(rs.connect(u).unstake(rec, 1n)).to.be.revertedWithCustomError(rs, "TooMuch"); continue; }
          await expect(rs.connect(u).unstake(rec, m.amount + 1n)).to.be.revertedWithCustomError(rs, "TooMuch");
          const y = r();
          let amt = y < 0.4 ? m.amount : y < 0.5 ? 1n : (m.amount * BigInt(1 + Math.floor(r() * 99))) / 100n;
          if (amt === 0n) amt = 1n;
          const balBefore = await stag.balanceOf(u.address);
          const tx = await rs.connect(u).unstake(rec, amt); const ts = await tsOf(tx);
          expect((await stag.balanceOf(u.address)) - balBefore).to.equal(net(amt));
          const next = m.amount - amt;
          if (next === 0n) stakers[rec] -= 1n;
          model[k] = { amount: next, since: ts }; total[rec] -= amt; grand -= amt;
          await expect(tx).to.emit(rs, "Unstaked").withArgs(u.address, rec, amt, next);
        }
        if (r() < 0.6) await time.increase(r() < 0.3 ? 1 + Math.floor(r() * 5) : Math.floor(r() * 3 * 86400));

        // --- invariants -------------------------------------------------------------------------
        const on = await rs.positions(u.address, rec), mm = model[k] ?? { amount: 0n, since: 0n };
        expect(on.amount).to.equal(mm.amount); expect(on.since).to.equal(mm.since);
        expect(await rs.totalStaked()).to.equal(grand);
        expect(await stag.balanceOf(rsAddr)).to.equal(grand + spare);          // balance == staked + stray, always >= staked
        if (i % 20 === 0 || i === steps - 1) {
          await mine();
          const now = BigInt(await time.latest());
          let sumAll = 0n;
          for (const rc of recs) {
            let sum = 0n, cnt = 0n;
            for (const uu of users) {
              const p = await rs.positions(uu.address, rc), md = model[key(uu, rc)] ?? { amount: 0n, since: 0n };
              expect(p.amount).to.equal(md.amount); expect(p.since).to.equal(md.since);
              sum += p.amount; if (p.amount > 0n) cnt++;
              expect(p.since).to.be.lessThanOrEqual(now);
              expect(await rs.points(uu.address, rc)).to.equal(p.amount === 0n ? 0n : (p.amount * (now - p.since)) / DAY / 10n ** 18n);
            }
            expect(await rs.recordTotal(rc)).to.equal(sum); expect(sum).to.equal(total[rc] ?? 0n);
            expect(await rs.recordStakers(rc)).to.equal(cnt); expect(cnt).to.equal(stakers[rc] ?? 0n);
            sumAll += sum;
          }
          expect(sumAll).to.equal(grand);
        }
      }

      // --- everyone can always leave, in full, even with every record closed and the owner gone ---
      for (const rc of recs) await rs.setRecord(rc, false);
      await rs.rescue(stagAddr, owner.address, spare);
      await rs.renounceOwnership();
      for (const uu of users) for (const rc of recs) {
        const p = (await rs.positions(uu.address, rc)).amount;
        if (p > 0n) await rs.connect(uu).unstake(rc, p);
      }
      expect(await rs.totalStaked()).to.equal(0n);
      expect(await stag.balanceOf(rsAddr)).to.equal(0n);
      for (const rc of recs) { expect(await rs.recordTotal(rc)).to.equal(0n); expect(await rs.recordStakers(rc)).to.equal(0n); }
      if (feeBps === null) for (const uu of users) expect(await stag.balanceOf(uu.address)).to.equal(START); // no fee, no loss, to the wei
    }

    for (const seed of [1, 7, 1337, 20261112]) {
      it(`plain ERC-20, 5 users x 4 records, 400 random ops, seed ${seed}`, async () => { await run(seed, 400, null); });
    }
    for (const [seed, bps] of [[99, 500], [100, 1], [101, 9999]]) {
      it(`fee-on-transfer token (${bps} bps), 300 random ops, seed ${seed}`, async () => { await run(seed, 300, bps); });
    }

    // ---- mutation sanity check: the harness above must FAIL on deliberately broken copies of the contract ----
    describe("mutation sanity (broken copies compiled in memory; RecordStake.sol on disk is untouched)", () => {
      it("control: the unmodified source compiled in memory passes the same fuzz", async () => {
        await run(7, 250, null, compileRecordStake(null));
      });
      const MUTANTS = [
        ["since rounds down again (old F1)", ["block.timestamp * got + next - 1) / next", "block.timestamp * got) / next"]],
        ["rescue lets the owner take staked STAG", ["amount > bal - totalStaked", "amount > bal"]],
        ["unstake forgets to reduce totalStaked", ["        totalStaked -= amount;\n", ""]],
        ["unstake forgets to reduce recordTotal", ["        recordTotal[recordId] -= amount;\n", ""]],
        ["staker count not decremented on full exit", ["if (next == 0) recordStakers[recordId] -= 1;", "if (next == 1) recordStakers[recordId] -= 1;"]],
        ["staker count incremented on every stake", ["            recordStakers[recordId] += 1;\n        } else {", "        } else {\n            recordStakers[recordId] += 1;"]],
        ["MIN_POSITION check removed", ["        if (next < MIN_POSITION) revert TooLittle();\n", ""]],
        ["unstake does not reset since", ["        p.since = uint64(block.timestamp);\n        if (next == 0)", "        if (next == 0)"]],
        ["top-up credits the requested amount twice in totals", ["        totalStaked += got;", "        totalStaked += got + 1;"]],
        ["unstake pays out 1 wei less", ["stag.safeTransfer(msg.sender, amount);", "stag.safeTransfer(msg.sender, amount - 1);"]],
        ["closed record still accepts stakes", ["        if (!recordOpen[recordId]) revert RecordClosed();\n", ""]],
      ];
      for (const [name, mut] of MUTANTS) {
        it(`mutant caught: ${name}`, async function () {
          const factory = compileRecordStake(mut);
          let err = null;
          try { await run(7, 250, null, factory); } catch (e) { err = e; }
          expect(err, "fuzz harness did NOT detect this mutant").to.not.equal(null);
          this.test.title += `  -> ${String(err.message).split("\n")[0].slice(0, 110)}`;
        });
      }
    });
  });
});
