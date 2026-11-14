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
/// Safe hardening rows. A lookalike or a Safe with a hostile singleton/module/guard/handler can answer the three getters and still be backdoored.
/// Needs the operator's out-of-band knowledge: EXPECT_SINGLETON (the Safe singleton address they verified in the Safe app / docs).
const SLOT_GUARD = ethers.id("guard_manager.guard.address"), SLOT_FALLBACK = ethers.id("fallback_manager.handler.address");
async function safeChecks(provider, addr, o = {}) {
  const rows = [], ck = (name, ok, detail = "") => rows.push({ name, ok: !!ok, detail });
  const word = async (slot) => ethers.getAddress(ethers.dataSlice(await provider.getStorage(addr, slot), 12));
  const lc = (x) => String(x).toLowerCase();
  const sp = await probeSafe(provider, addr);
  ck("multisig answers like a Safe (VERSION, getThreshold >= 1, getOwners)", sp.ok || !!o.allowNonSafe, sp.ok ? `Safe ${sp.version}, threshold ${sp.threshold}, owners ${sp.owners.length}` : "no Safe answers");
  if (!sp.ok) return { rows, sp };
  if (o.expectOwners) { const a = sp.owners.map(lc).sort(), b = o.expectOwners.map(lc).sort(); ck("multisig owners == EXPECT_OWNERS (exact list)", a.length === b.length && a.every((x, i) => x === b[i]), sp.owners.join(",")); }
  else ck("EXPECT_OWNERS supplied (the full owner list is checked, not just the count)", !!o.dry);
  if (o.expectThreshold !== undefined && o.expectThreshold !== null) ck(`multisig threshold == EXPECT_THRESHOLD (${o.expectThreshold})`, sp.threshold === BigInt(o.expectThreshold), String(sp.threshold)); else ck("EXPECT_THRESHOLD supplied", !!o.dry);
  ck("multisig threshold >= 2", sp.threshold >= 2n || !!o.dry, String(sp.threshold));
  if (o.expectProxyCodehash) ck("multisig runtime code hash == EXPECT_PROXY_CODEHASH (canonical Safe proxy: not a lookalike contract)", lc(ethers.keccak256(await provider.getCode(addr))) === lc(o.expectProxyCodehash), ethers.keccak256(await provider.getCode(addr)));
  else ck("EXPECT_PROXY_CODEHASH supplied (the canonical SafeProxy runtime hash)", !!o.dry);
  // The Safe's creation tx: exactly one SafeSetup log from this proxy with initializer == 0 (so setup() made NO delegatecall that could plant
  // unlisted owners/modules or pre-approved hashes), owners/threshold equal to the current ones, and the tx must be a plain creation of THIS address's setup.
  if (o.safeCreationTx) {
    const rc = await provider.getTransactionReceipt(o.safeCreationTx);
    const topic = ethers.id("SafeSetup(address,address[],uint256,address,address)");
    const logs = rc && rc.status === 1 ? rc.logs.filter((l) => lc(l.address) === lc(addr) && l.topics[0] === topic) : [];
    ck("Safe creation tx has exactly one SafeSetup log from the multisig", logs.length === 1, rc ? `${logs.length} logs` : "tx not found");
    if (logs.length === 1) {
      const d = ethers.AbiCoder.defaultAbiCoder().decode(["address[]", "uint256", "address"], logs[0].data);
      ck("Safe setup() used NO initializer delegatecall (initializer == 0)", d[2] === ethers.ZeroAddress, d[2]);
      ck("Safe setup owners/threshold == current owners/threshold (no later change)", d[0].map(lc).join() === sp.owners.map(lc).join() && d[1] === sp.threshold);
    }
  } else ck("EXPECT_SAFE_CREATION_TX supplied (the Safe's setup() must be provably clean)", !!o.dry);
  if (o.dry && !o.expectSingleton) return { rows, sp };
  if (o.expectSingleton) ck("Safe singleton (storage slot 0) == EXPECT_SINGLETON", lc(await word(ethers.ZeroHash)) === lc(o.expectSingleton), await word(ethers.ZeroHash));
  else ck("EXPECT_SINGLETON supplied (the verified Safe implementation address)", false);
  if (o.expectSingleton) ck("singleton has code", (await provider.getCode(o.expectSingleton)).length > 2);
  let mods = null; try { mods = await new ethers.Contract(addr, ["function getModulesPaginated(address,uint256) view returns (address[],address)"], provider).getModulesPaginated("0x0000000000000000000000000000000000000001", 10); } catch (e) {}
  ck("Safe has NO enabled modules (modules move funds/ownership without signatures)", mods !== null && mods[0].length === 0, mods ? String(mods[0].length) : "getModulesPaginated failed");
  ck("Safe guard slot is empty", (await word(SLOT_GUARD)) === ethers.ZeroAddress);
  const fb = await word(SLOT_FALLBACK);
  ck("Safe fallback handler is empty or EXPECT_FALLBACK", fb === ethers.ZeroAddress || (o.expectFallback && lc(fb) === lc(o.expectFallback)), fb);
  return { rows, sp };
}
module.exports = { safeChecks, PM_DEFAULT, STAG_DEFAULT, FLAG_MASK, FLAGS, hookInitCode, predictDeployer, mineSalt, probeSafe };
