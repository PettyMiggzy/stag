/* Send a King Petty to a list of wallets (free-mint one to each). Owner-only.
 *
 *   KP=0xE9cE3119dAa292b4fC3503E1196aBC8adBdfffc9 DEPLOYER_KEY=0x... \
 *     npx hardhat run scripts/send-kingpetty.js --network rhmainnet
 *
 * Default list = the two $STAG sellers over $500 (the paper hands). Override with
 * ADDRS="0xabc,0xdef" to send to a different set. Runs ownerMint(addr,1) per wallet.
 */
const { ethers } = require("hardhat");

const KP = process.env.KP || "0xE9cE3119dAa292b4fC3503E1196aBC8adBdfffc9";
const DEFAULT = [
  "0xde21f89deb8046c28b5b07a58f612a9d0960670f", // sold ~$1,646
  "0xfb8e41ec3ad11497bf169900a7a0534dd3e8733f", // sold ~$1,239
];
const ADDRS = (process.env.ADDRS ? process.env.ADDRS.split(",") : DEFAULT)
  .map((a) => a.trim()).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));

async function main() {
  const abi = ["function ownerMint(address to, uint256 qty)", "function totalMinted() view returns (uint256)", "function owner() view returns (address)"];
  const [signer] = await ethers.getSigners();
  const c = new ethers.Contract(KP, abi, signer);
  const owner = await c.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) throw new Error(`signer ${signer.address} is not the owner (${owner})`);
  console.log("sending King Petty (1 each) to", ADDRS.length, "wallet(s)…");
  for (const to of ADDRS) {
    const tx = await c.ownerMint(to, 1);
    await tx.wait();
    console.log("  ✅", to, "  tx", tx.hash);
  }
  console.log("done. totalMinted:", (await c.totalMinted()).toString(), "/ 200");
}
main().catch((e) => { console.error(e); process.exit(1); });
