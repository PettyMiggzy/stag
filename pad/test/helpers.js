const { ethers, network } = require("hardhat");
const PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const STAG = "0x67Ef4460A1280fBD9d31D6312FEd2Ce1EFd66305";
const CURVE = "0x8e68043f7553ff7adf30eb8b0baac8d8fc2ed958";
const STATEVIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const MIN = 4295128740n, MAXP = 1461446703485210103287273052203988822378723970341n;
const E = (n) => ethers.parseEther(String(n));
const erc20 = ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)", "function totalSupply() view returns (uint256)"];

function mineSalt(deployer, initHash) {
  for (let i = 0n; ; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    if ((BigInt(ethers.getCreate2Address(deployer, salt, initHash)) & 0x3fffn) === 0x28ccn) return salt;
  }
}
async function fundStag(signers, amount) {
  // fork-only: write balances straight into the token's storage (OpenZeppelin ERC20: _balances is slot 0)
  await network.provider.send("hardhat_mine", ["0x1"]);   // calls at the exact fork block need a hardfork entry; move past it
  const stag = new ethers.Contract(STAG, erc20, signers[0]);
  for (const s of signers) {
    const slot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [s.address, 0]));
    await network.provider.send("hardhat_setStorageAt", [STAG, slot, ethers.toBeHex(amount, 32)]);
    if ((await stag.balanceOf(s.address)) !== amount) throw new Error("funding STAG by storage slot 0 failed");
  }
}
async function deployStack(owner, doWire = true) {
  const Hd = await (await ethers.getContractFactory("HookDeployer")).deploy();
  const H = await ethers.getContractFactory("PadHook");
  const init = ethers.concat([H.bytecode, ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "address"], [PM, owner.address, STAG])]);
  const salt = mineSalt(await Hd.getAddress(), ethers.keccak256(init));
  await Hd.deploy(salt, init);
  const hook = H.attach(ethers.getCreate2Address(await Hd.getAddress(), salt, ethers.keccak256(init)));
  const factory = await (await ethers.getContractFactory("PadFactory")).deploy(PM, await hook.getAddress(), STAG);
  const battle = await (await ethers.getContractFactory("PadBattle")).deploy(await hook.getAddress());
  if (doWire) await hook.wire(await factory.getAddress(), await battle.getAddress());
  const router = await (await ethers.getContractFactory("PoolSwapTest")).deploy(PM);
  const stag = new ethers.Contract(STAG, erc20, owner);
  const stateView = new ethers.Contract(STATEVIEW, ["function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)"], owner);
  return { hook, factory, battle, router, stag, stateView };
}
const poolId = (k) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));

function mk(S, signers) {
  const { hook, factory, router, stag } = S;
  const pmc = new ethers.Contract(PM, ["function balanceOf(address,uint256) view returns (uint256)"], signers[0]);
  const api = {
    ...S,
    inf: (p) => hook.info(p.id),
    async launch(who, war, fdv = E(10_000_000), name = "Pad Test", sym = "PT") {
      await (await factory.connect(who).launch(name, sym, fdv, war)).wait();
      const k = await factory.keyAt(Number(await factory.launchCount()) - 1);
      const key = { currency0: k[0], currency1: k[1], fee: k[2], tickSpacing: k[3], hooks: k[4] };
      const tok = (await ethers.getContractFactory("PadToken")).attach(k[1] === STAG ? k[0] : k[1]);
      const p = { key, tok, id: poolId(key), quoteIs0: k[0] === STAG };
      for (const s of signers) { await stag.connect(s).approve(await router.getAddress(), ethers.MaxUint256); }
      return p;
    },
    // exact-in buy: pay `amt` quote
    buy: (p, who, amt) => router.connect(who).swap(p.key, { zeroForOne: p.quoteIs0, amountSpecified: -amt, sqrtPriceLimitX96: p.quoteIs0 ? MIN + 1n : MAXP - 1n }, { takeClaims: false, settleUsingBurn: false }, "0x"),
    // exact-out buy: receive `tokens`
    buyOut: (p, who, tokens) => router.connect(who).swap(p.key, { zeroForOne: p.quoteIs0, amountSpecified: tokens, sqrtPriceLimitX96: p.quoteIs0 ? MIN + 1n : MAXP - 1n }, { takeClaims: false, settleUsingBurn: false }, "0x"),
    // exact-in sell: sell `tokens`
    async sell(p, who, tokens) { await p.tok.connect(who).approve(await router.getAddress(), ethers.MaxUint256); return router.connect(who).swap(p.key, { zeroForOne: !p.quoteIs0, amountSpecified: -tokens, sqrtPriceLimitX96: p.quoteIs0 ? MAXP - 1n : MIN + 1n }, { takeClaims: false, settleUsingBurn: false }, "0x"); },
    // exact-out sell: receive `quote`
    async sellOut(p, who, quote) { await p.tok.connect(who).approve(await router.getAddress(), ethers.MaxUint256); return router.connect(who).swap(p.key, { zeroForOne: !p.quoteIs0, amountSpecified: quote, sqrtPriceLimitX96: p.quoteIs0 ? MAXP - 1n : MIN + 1n }, { takeClaims: false, settleUsingBurn: false }, "0x"); },
    async owed(pools) { let t = await hook.platformOwed(); for (const p of pools) { const i = await hook.info(p.id); t += i.chest + i.creatorOwed + i.holderOwed; } return t; },
    async claims() { return await pmc.balanceOf(await hook.getAddress(), BigInt(STAG)); },
    async solvent(pools) { return (await api.claims()) === (await api.owed(pools)); },
    async tick(p) { return Number((await S.stateView.getSlot0(p.id))[1]); },
  };
  return api;
}
module.exports = { PM, STAG, E, MIN, MAXP, fundStag, deployStack, mk, poolId };
