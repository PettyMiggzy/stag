// Shared helpers for the deployment scripts. Pure functions: no network access except what the caller passes in.
const { ethers } = require("ethers");
const PM_DEFAULT = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const STAG_DEFAULT = "0x67Ef4460A1280fBD9d31D6312FEd2Ce1EFd66305";
const FLAG_MASK = 0x3fffn, FLAGS = 0x28ccn;

/// initcode of PadHook exactly as PadDeployer builds it: creation code ++ abi.encode(pm, owner=deployer, quote)
function hookInitCode(hookBytecode, pm, deployerAddr, quote) {
  return ethers.concat([hookBytecode, ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "address"], [pm, deployerAddr, quote])]);
}
/// PadDeployer is created with CREATE from `eoa` at `nonce`; predict where it will live.
function predictDeployer(eoa, nonce) { return ethers.getCreateAddress({ from: eoa, nonce }); }
/// find salt s.t. CREATE2(deployerAddr, salt, keccak(initcode)) has the low 14 bits == 0x28CC. Deterministic: lowest counter wins.
function mineSalt(deployerAddr, initcode, { start = 0n, max = 50_000_000n, onProgress } = {}) {
  const h = ethers.keccak256(initcode);
  for (let i = start; i < start + max; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const addr = ethers.getCreate2Address(deployerAddr, salt, h);
    if ((BigInt(addr) & FLAG_MASK) === FLAGS) return { salt, hook: addr, tries: i - start + 1n };
    if (onProgress && i % 1_000_000n === 0n) onProgress(i);
  }
  throw new Error("no salt found");
}
/// does this address answer like a Safe? (version, threshold, owners). Cannot prove the signers can sign: rehearse a no-op transaction first.
async function probeSafe(provider, addr) {
  const S = new ethers.Contract(addr, ["function VERSION() view returns (string)", "function getThreshold() view returns (uint256)", "function getOwners() view returns (address[])"], provider);
  try { const [version, threshold, owners] = await Promise.all([S.VERSION(), S.getThreshold(), S.getOwners()]); return { ok: threshold >= 1n && owners.length >= 1, version, threshold, owners }; }
  catch (e) { return { ok: false }; }
}
module.exports = { PM_DEFAULT, STAG_DEFAULT, FLAG_MASK, FLAGS, hookInitCode, predictDeployer, mineSalt, probeSafe };
