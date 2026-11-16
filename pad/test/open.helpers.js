// Helpers for the open pad (bring-your-token) tests. Uses the existing helpers untouched.
const { ethers } = require("hardhat");
const { PM, STAG, E, mk, poolId } = require("./helpers");
const STATEVIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const ANYONE = "0x" + "f".repeat(40);
const erc20 = ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)", "function totalSupply() view returns (uint256)"];

function mineSalt(deployer, initHash) {
  for (let i = 0n; ; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    if ((BigInt(ethers.getCreate2Address(deployer, salt, initHash)) & 0x3fffn) === 0x28ccn) return salt;
  }
}

/// OpenHook + OpenPad + a second, unchanged PadBattle pointed at the open hook, wired together
async function deployOpen(owner, { curated = false, doWire = true } = {}) {
  const Hd = await (await ethers.getContractFactory("HookDeployer")).deploy();
  const H = await ethers.getContractFactory("OpenHook");
  const init = ethers.concat([H.bytecode, ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "address"], [PM, owner.address, STAG])]);
  const salt = mineSalt(await Hd.getAddress(), ethers.keccak256(init));
  await Hd.deploy(salt, init);
  const hook = H.attach(ethers.getCreate2Address(await Hd.getAddress(), salt, ethers.keccak256(init)));
  const pad = await (await ethers.getContractFactory("OpenPad")).deploy(PM, await hook.getAddress(), STAG, curated);
  const battle = await (await ethers.getContractFactory("PadBattle")).deploy(await hook.getAddress());
  if (doWire) await hook.wire(await pad.getAddress(), await battle.getAddress());
  const router = await (await ethers.getContractFactory("PoolSwapTest")).deploy(PM);
  const stag = new ethers.Contract(STAG, erc20, owner);
  const stateView = new ethers.Contract(STATEVIEW, ["function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)", "function getLiquidity(bytes32) view returns (uint128)", "function getPositionInfo(bytes32,address,int24,int24,bytes32) view returns (uint128,uint256,uint256)"], owner);
  return { hook, pad, factory: pad, battle, router, stag, stateView };
}

const keyObj = (k) => ({ currency0: k[0], currency1: k[1], fee: k[2], tickSpacing: k[3], hooks: k[4] });

/// the key OpenPad will use for a token (it is fully determined by the token)
async function predictKey(S, tokenAddr) {
  const q0 = BigInt(STAG) < BigInt(tokenAddr);
  return { currency0: q0 ? STAG : tokenAddr, currency1: q0 ? tokenAddr : STAG, fee: 3000, tickSpacing: 60, hooks: await S.hook.getAddress() };
}

async function newToken(boss, { name = "Outside Token", symbol = "OUT", decimals = 18, supply = E(1_000_000_000) } = {}) {
  return (await ethers.getContractFactory("WeirdToken", boss)).deploy(name, symbol, decimals, supply);
}

/// same swap/accounting helpers as the launched-pad tests, plus `bring`
function mkOpen(S, signers) {
  const api = mk(S, signers);
  api.bring = async (who, tok, { amount = E(900_000_000), price = E("0.01"), war = true } = {}) => {
    const padAddr = await S.pad.getAddress();
    await tok.connect(who).approve(padAddr, amount + 2_000_000n);
    await (await S.pad.connect(who).bring(await tok.getAddress(), amount, price, war)).wait();
    const key = keyObj(await S.pad.keyOf(await tok.getAddress()));
    for (const s of signers) await S.stag.connect(s).approve(await S.router.getAddress(), ethers.MaxUint256);
    return { key, tok, id: poolId(key), quoteIs0: key.currency0 === STAG };
  };
  // the locked position: owned by the pad, salt 0
  api.posLiq = async (p) => { const pl = await S.pad.pools(p.id); return (await S.stateView.getPositionInfo(p.id, await S.pad.getAddress(), pl.tickLower, pl.tickUpper, ethers.ZeroHash))[0]; };
  // every pool the pad ever opened
  api.all = async () => { const out = []; for (let i = 0, n = Number(await S.pad.count()); i < n; i++) { const key = keyObj(await S.pad.keyAt(i)); out.push({ key, id: poolId(key) }); } return out; };
  // the hook's whole book: its ERC-6909 $STAG claims equal platform share + every chest + every creator share, exactly
  api.balanced = async () => api.solvent(await api.all());
  return api;
}

module.exports = { PM, STAG, DEAD, ANYONE, E, erc20, deployOpen, mkOpen, newToken, predictKey, keyObj, poolId, mineSalt };
