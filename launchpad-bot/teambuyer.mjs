// Disclosed team-wallet buyer: ONE small buy per hour from a team wallet, straight into the Pons curve.
// It is labelled as a team buy in the dashboard and /stats and is kept out of the organic buy counts.
// Hard limits: one buy per hour, never more. Needs TEAM_KEY (a dedicated wallet) set on the server.
import { ethers } from "ethers";

export function startTeamBuyer(X) {
  const { provider, CFG, ST, log } = X;
  const key = process.env.TEAM_KEY;
  if (!key) return null;
  const wallet = new ethers.Wallet(key, provider);
  const usdPerHour = Math.min(5, parseFloat(process.env.TEAM_USD_PER_HOUR || "1") || 1); // capped at $5/hour
  const INTERVAL_MS = 3600 * 1000; // fixed: one buy per hour
  const curve = new ethers.Contract(CFG.pool, ["function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)"], wallet);
  const bond = parseFloat(process.env.BOND_ETH || "4.2") || 4.2;
  let lastTs = 0;

  async function buyOnce() {
    try {
      const bondEth = Number(ethers.formatEther(await provider.getBalance(CFG.pool)));
      if (bondEth >= bond) { log("team buyer: curve graduated, stopping"); return; }
      const ethUsd = X.ethUsd(); if (!ethUsd) return;
      const amount = ethers.parseEther((usdPerHour / ethUsd).toFixed(8));
      const bal = await provider.getBalance(wallet.address);
      if (bal < amount * 2n) { log(`team buyer: low balance ${ethers.formatEther(bal)} ETH, skipping`); return; }
      const last = ST.buys[ST.buys.length - 1]; const price = last ? last.eth / last.tok : 0;
      const est = price ? Number(ethers.formatEther(amount)) / price : 0;
      const minOut = est ? ethers.parseUnits((est * 0.75).toFixed(6), 18) : 0n; // 25% slippage guard
      const tx = await curve.buy(amount, minOut, wallet.address, { value: amount });
      log(`team buy sent ${ethers.formatEther(amount)} ETH (~$${usdPerHour}) ${tx.hash}`);
      await tx.wait(); lastTs = Date.now();
    } catch (e) { log("team buyer err:", e.shortMessage || e.message); }
  }
  // wait a bit after boot; skip if this wallet already bought within the last hour (survives redeploys)
  setTimeout(async () => {
    const head = await provider.getBlockNumber();
    const hourBlocks = Math.round(X.BLOCKS_PER_DAY / 24);
    const recent = ST.buys.some((b) => b.block > head - hourBlocks && X.buyerCached(b.tx) === wallet.address.toLowerCase());
    if (!recent) await buyOnce();
    setInterval(buyOnce, INTERVAL_MS);
  }, 120000);
  log(`team buyer on: ${wallet.address}, $${usdPerHour}/hour, one buy per hour`);
  return wallet.address.toLowerCase();
}
