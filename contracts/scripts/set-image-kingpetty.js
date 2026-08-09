/* Point King Petty's art at IPFS (owner-only setImageURI). Metadata stays on-chain; only the
 * image moves to IPFS — fully off your site.
 *
 *   KP=0xE9cE3119dAa292b4fC3503E1196aBC8adBdfffc9 DEPLOYER_KEY=0x... \
 *     npx hardhat run scripts/set-image-kingpetty.js --network rhmainnet
 *
 * Override the CID with KP_CID=bafy...   (default = the pinned King Petty art)
 */
const { ethers } = require("hardhat");

const KP  = process.env.KP  || "0xE9cE3119dAa292b4fC3503E1196aBC8adBdfffc9";
const CID = process.env.KP_CID || "bafybeieqdf5tbgpihqar7ni6ehdsuquehv4cx5ewyrijyk7xb5yryzvixa";
const URI = "ipfs://" + CID;

async function main() {
  const abi = ["function setImageURI(string)", "function imageURI() view returns (string)", "function owner() view returns (address)"];
  const [signer] = await ethers.getSigners();
  const c = new ethers.Contract(KP, abi, signer);
  const owner = await c.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) throw new Error(`signer ${signer.address} is not the owner (${owner})`);
  console.log("current image:", await c.imageURI());
  const tx = await c.setImageURI(URI);
  await tx.wait();
  console.log("✅ image set to:", await c.imageURI(), "\n   tx:", tx.hash);
}
main().catch((e) => { console.error(e); process.exit(1); });
