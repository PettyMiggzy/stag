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
const SLOT_GUARD = ethers.id("guard_manager.guard.address"), SLOT_FALLBACK = ethers.id("fallback_manager.handler.address"), SLOT_MODGUARD = ethers.id("module_manager.module_guard.address");
async function safeChecks(provider, addr, o = {}) {
  const rows = [], ck = (name, ok, detail = "") => rows.push({ name, ok: !!ok, detail });
  const word = async (slot) => ethers.getAddress(ethers.dataSlice(await provider.getStorage(addr, slot), 12));
  const lc = (x) => String(x).toLowerCase();
  const sp = await probeSafe(provider, addr);
  ck("multisig answers like a Safe (VERSION, getThreshold >= 1, getOwners)", sp.ok || !!o.allowNonSafe, sp.ok ? `Safe ${String(sp.version).replace(/[^\x20-\x7e]/g, "?").slice(0, 20)}, threshold ${sp.threshold}, owners ${sp.owners.length}` : "no Safe answers");
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
    const rc = await provider.getTransactionReceipt(o.safeCreationTx), stx = rc ? await provider.getTransaction(o.safeCreationTx) : null;
    const topic = ethers.id("SafeSetup(address,address[],uint256,address,address)");
    const logs = rc && rc.status === 1 ? rc.logs.filter((l) => lc(l.address) === lc(addr) && l.topics[0] === topic) : [];
    ck("Safe creation tx has exactly one SafeSetup log from the multisig", logs.length === 1, rc ? `${logs.length} logs` : "tx not found");
    if (logs.length === 1) {
      const d = ethers.AbiCoder.defaultAbiCoder().decode(["address[]", "uint256", "address"], logs[0].data);
      ck("Safe setup() used NO initializer delegatecall (initializer == 0)", d[2] === ethers.ZeroAddress, d[2]);
      // the proxy must have been made by the OFFICIAL SafeProxyFactory (whose CREATE2 deploys the canonical proxy code, so no hostile constructor ran
      // and nobody could forge the setup log), in that same tx, with setup() logged before the factory's ProxyCreation, and the factory pinned out of band
      const pcTopic = ethers.id("ProxyCreation(address,address)");
      const pc = o.expectFactory ? rc.logs.filter((l) => lc(l.address) === lc(o.expectFactory) && l.topics[0] === pcTopic) : [];
      ck("Safe creation tx was sent to EXPECT_SAFE_FACTORY (the official SafeProxyFactory)", !!o.expectFactory && !!stx && stx.to && lc(stx.to) === lc(o.expectFactory), String(stx && stx.to));
      ck("factory logged exactly one ProxyCreation for the multisig with singleton == EXPECT_SINGLETON", (() => {
        if (pc.length !== 1 || !o.expectSingleton) return false;
        const l = pc[0]; let proxy, single;
        if (l.topics.length === 2) { proxy = ethers.getAddress(ethers.dataSlice(l.topics[1], 12)); single = ethers.getAddress(ethers.dataSlice(l.data, 12, 32)); }      // 1.4.x: proxy indexed
        else { const x = ethers.AbiCoder.defaultAbiCoder().decode(["address", "address"], l.data); proxy = x[0]; single = x[1]; }                                           // 1.3.0: both in data
        return lc(proxy) === lc(addr) && lc(single) === lc(o.expectSingleton);
      })());
      const li = (l) => (l.index !== undefined ? l.index : l.logIndex);
      ck("setup() ran before the factory's ProxyCreation, in the same tx", pc.length === 1 && li(logs[0]) < li(pc[0]));
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
  // the fallback handler is called by the Safe with msg.sender == Safe for ANY unknown selector: it must never be one of OUR contracts (hook/factory/battle/
  // deployer/PM/STAG/the Safe itself/the throwaway EOA), or anyone could make the Safe act as its own owner/payer. Pinning an address is not enough: pin its CODE too.
  const forbid = (o.forbid || []).concat([addr]).map(lc);
  ck("Safe fallback handler is empty, or exactly EXPECT_FALLBACK", fb === ethers.ZeroAddress || (!!o.expectFallback && lc(fb) === lc(o.expectFallback)), fb);
  ck("Safe fallback handler is none of this system's contracts, PM, STAG, the Safe itself or the deployer EOA", !forbid.includes(lc(fb)), fb);
  if (fb !== ethers.ZeroAddress) { const h = ethers.keccak256(await provider.getCode(fb)); ck("fallback handler runtime hash == EXPECT_FALLBACK_CODEHASH (the official CompatibilityFallbackHandler)", !!o.expectFallbackCodehash && lc(h) === lc(o.expectFallbackCodehash), h); }
  if (o.expectSingleton) { const h = ethers.keccak256(await provider.getCode(o.expectSingleton)); ck("singleton runtime hash == EXPECT_SINGLETON_CODEHASH (the official Safe/SafeL2 code)", !!o.expectSingletonCodehash && lc(h) === lc(o.expectSingletonCodehash), h); }
  if (o.expectFactory) { const h = ethers.keccak256(await provider.getCode(o.expectFactory)); ck("factory runtime hash == EXPECT_FACTORY_CODEHASH (the official SafeProxyFactory)", !!o.expectFactoryCodehash && lc(h) === lc(o.expectFactoryCodehash), h); }
  ck("Safe module-guard slot is empty (Safe 1.5)", (await word(SLOT_MODGUARD)) === ethers.ZeroAddress);
  for (const w of sp.owners) { if (o.forbid && o.forbid.map(lc).includes(lc(w))) ck("no owner is one of this system's addresses or the throwaway deployer EOA", false, w); }
  rows.push({ name: "info: owners that are contracts (EIP-1271/upgradeable/another Safe sign without a key: confirm each is intended)", ok: true, warn: (await Promise.all(sp.owners.map(async (w) => (await provider.getCode(w)).length > 2))).some(Boolean), detail: "" });
  return { rows, sp };
}
module.exports = { safeChecks, PM_DEFAULT, STAG_DEFAULT, FLAG_MASK, FLAGS, hookInitCode, predictDeployer, mineSalt, probeSafe };
