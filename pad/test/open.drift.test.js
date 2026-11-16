// Drift guard. OpenHook.sol is PadHook.sol copied line for line with a short list of changes (PadHook cannot be
// inherited: its functions are not virtual and its build is pinned by hash). This test compares the two files as code
// (comments and blank lines ignored) and fails unless the difference is EXACTLY the reviewed list in
// test/fixtures/openhook.delta.json. Any other edit to either file shows up here and has to be reviewed.
// To accept a reviewed change: UPDATE_DRIFT=1 npx hardhat test test/open.drift.test.js, then read the fixture diff.
const { expect } = require("chai");
const fs = require("fs"), path = require("path");

const code = (f) => fs.readFileSync(path.join(__dirname, "..", "contracts", f), "utf8").split("\n")
  .map((l) => l.replace(/\/\/.*$/, "").trim().replace(/\s+/g, " ")).filter((l) => l.length > 0);

// longest common subsequence; what is left over on each side is the difference
function delta(a, b) {
  const n = a.length, m = b.length, t = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const removed = [], added = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; } else if (t[i + 1][j] >= t[i][j + 1]) removed.push(a[i++]); else added.push(b[j++]);
  }
  while (i < n) removed.push(a[i++]);
  while (j < m) added.push(b[j++]);
  return { removedFromPadHook: removed, addedInOpenHook: added };
}

describe("open hook drift guard (no fork needed)", () => {
  const FIX = path.join(__dirname, "fixtures", "openhook.delta.json");
  it("OpenHook.sol differs from the audited PadHook.sol by exactly the reviewed lines, and by nothing else", () => {
    const d = delta(code("PadHook.sol"), code("OpenHook.sol"));
    if (process.env.UPDATE_DRIFT) fs.writeFileSync(FIX, JSON.stringify(d, null, 2) + "\n");
    expect(d).to.deep.equal(JSON.parse(fs.readFileSync(FIX, "utf8")));
    expect(d.removedFromPadHook.length).to.be.lte(40); expect(d.addedInOpenHook.length).to.be.lte(25);   // it stays a small, readable list
  });
  it("the open hook never calls into the token contract and has no path that pays $STAG to it", () => {
    const src = code("OpenHook.sol").join("\n");
    for (const banned of ["IPadToken", ".burn(got)", ".sync()", "pushHolders", "_flush", "i.token, a", "tstore", "tload", "delegatecall", "selfdestruct"]) expect(src.includes(banned), banned).to.equal(false);
    expect(src.includes("poolManager.take(Currency.wrap(token), DEAD, got);")).to.equal(true);
  });
});
