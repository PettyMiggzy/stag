// Pinned-build helpers: hash of each contract's runtime code with its immutable bytes zeroed, read from the artifacts that match the
// current compile. `node scripts/make-manifest.js` writes audited-manifest.json; deploy.js and readback.js compare against it.
const fs = require("fs"), path = require("path");
const { ethers } = require("ethers");
const NAMES = ["PadHook", "PadFactory", "PadBattle", "PadDeployer"];

function artifact(name) {
  const root = path.join(__dirname, "..", "artifacts", "contracts");
  for (const d of fs.readdirSync(root)) {
    const f = path.join(root, d, name + ".dbg.json");
    if (fs.existsSync(f)) {
      const info = path.resolve(path.dirname(f), JSON.parse(fs.readFileSync(f, "utf8")).buildInfo);
      const j = JSON.parse(fs.readFileSync(info, "utf8"));
      for (const src of Object.keys(j.output.contracts)) {
        const c = j.output.contracts[src][name];
        if (c) return { runtime: "0x" + c.evm.deployedBytecode.object, creation: "0x" + c.evm.bytecode.object, refs: c.evm.deployedBytecode.immutableReferences || {} };
      }
    }
  }
  throw new Error("no artifact for " + name);
}
function maskedHash(runtimeHex, refs) {
  const b = ethers.getBytes(runtimeHex).slice();
  for (const id of Object.keys(refs)) for (const r of refs[id]) b.fill(0, r.start, r.start + r.length);
  return ethers.keccak256(b);
}
function build() {
  const m = { note: "keccak256 of runtime code with immutable bytes zeroed, plus the PadDeployer creation code hash, for the AUDITED build. Regenerate with `node scripts/make-manifest.js` only after a reviewed source change." , runtime: {} };
  for (const n of NAMES) { const a = artifact(n); m.runtime[n] = maskedHash(a.runtime, a.refs); if (n === "PadDeployer") m.deployerCreationCode = ethers.keccak256(a.creation); }
  return m;
}
const FILE = path.join(__dirname, "..", "audited-manifest.json");
function load() { return fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : null; }
module.exports = { artifact, maskedHash, build, load, FILE, NAMES };
