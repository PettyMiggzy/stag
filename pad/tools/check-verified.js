#!/usr/bin/env node
// Validates the hand-kept verified-projects list before it is published.
//   node tools/check-verified.js [path/to/verified.json]
// Exit 0 only if every entry is well formed. Does not touch the network.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const file = process.argv[2] || path.join(__dirname, "../../stagsite/pad/verified.json");
let j;
try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.error("cannot read/parse " + file + ": " + e.message); process.exit(1); }
const bad = [];
const err = (m) => bad.push(m);
if (j.version !== 1) err("version must be 1");
if (!Array.isArray(j.projects)) err("projects must be an array");
const seen = new Set();
const https = (u) => { try { return new URL(u).protocol === "https:"; } catch { return false; } };
const norm = (x) => { let t = String(x || "").toLowerCase().replace(/[^a-z0-9]/g, ""); if (t.length > 2 && t[0] === "w") t = t.slice(1); return t; };
(j.projects || []).forEach((e, i) => {
  const at = `projects[${i}] (${e && e.name})`;
  if (!e || typeof e !== "object") return err(at + ": not an object");
  if (!e.name || String(e.name).length > 60) err(at + ": name required, 60 chars max");
  if (!e.symbol || String(e.symbol).length > 16) err(at + ": symbol required, 16 chars max");
  if (!ethers.isAddress(e.padToken || "")) err(at + ": padToken is not an address");
  else {
    if (ethers.getAddress(e.padToken) !== e.padToken) err(at + ": padToken must be written in checksum case (" + ethers.getAddress(e.padToken) + ")");
    const k = e.padToken.toLowerCase();
    if (seen.has(k)) err(at + ": duplicate padToken");
    seen.add(k);
  }
  if (e.original != null) {
    if (!ethers.isAddress(e.original.address || "")) err(at + ": original.address is not an address");
    else if (ethers.getAddress(e.original.address) !== e.original.address) err(at + ": original.address must be in checksum case");
    if (!e.original.chain) err(at + ": original.chain required when original is given");
  }
  for (const k of ["x", "telegram", "website"]) if (e.links && e.links[k] && !https(e.links[k])) err(at + ": links." + k + " must be an https URL");
  if (!e.verifiedOn || !/^\d{4}-\d{2}-\d{2}$/.test(e.verifiedOn)) err(at + ": verifiedOn must be YYYY-MM-DD");
  if (!e.by) err(at + ": by (how it was verified) is required");
});
// two different entries sharing a normalised name or symbol would make the lookalike warning ambiguous
const names = new Map();
(j.projects || []).forEach((e, i) => { for (const k of [norm(e.name), norm(e.symbol)]) { if (!k) continue; if (names.has(k) && names.get(k) !== i) err(`projects[${i}] (${e.name}): name or symbol collides with projects[${names.get(k)}] after normalising`); else names.set(k, i); } });
if (bad.length) { console.error(bad.map((m) => "FAIL  " + m).join("\n")); console.error(`\n${bad.length} problem(s): do not publish`); process.exit(1); }
console.log(`OK  ${(j.projects || []).length} verified project(s) in ${file}`);
