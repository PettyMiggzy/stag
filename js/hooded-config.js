/* Shared config for the Hooded 20 mint + staking UI.
   After deploy, paste the addresses below ONCE (or set them in /admin, which stores
   overrides in localStorage). Every page (mint, stake, admin) reads from here. */
window.HOODED = {
  // ===== DEPLOYED — Robinhood Chain mainnet 4663 (2026-07-12) =====
  mint: '0x4384cB362D908d36266bDF3C31F18DB95EB127dc',     // HoodedTwenty
  staking: '0x2faA6672546912e7cDec4E1AaCF1eeF52bA524fF',  // StagStaking
  splitter: '0x1F6D791108635ac4522b1cfaD86FD7B435aDFe2a', // RevenueSplitter (90/10)
  pact: '0xc36662D2db9432702f018963ABdab19432AA488B',     // SherwoodPact
  saints: '0x5c309bC7D137cA4c5AC450B68D1A1d896eF28327',        // SherwoodSaints (5x 1/1)
  saintsSplitter: '0x101a344172f15ABe969027ea06624305F4a63082',// SaintsSplitter (60/30/10)
  // ================================================================
  stag: '0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49',
  // WalletConnect (Reown) project id — enables mobile "connect any wallet" (Trust, Rainbow,
  // Coinbase, MetaMask…) when there's no injected wallet. Get one free at cloud.reown.com.
  walletConnectProjectId: 'a00014837c68f5d7133c3cc329dcfe6d',
  // Stakeable tokens (each must be whitelisted on-chain via admin setTokenWeight). $STAG is
  // whitelisted by default in the contract. Add more here (or from /admin) and the stake tab
  // shows a token picker; the withdraw-split applies to whichever token you unstake.
  stakeTokens: [
    { address: '0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49', symbol: 'STAG', decimals: 18 },
  ],
  chain: {
    chainId: '0x1237', // 4663 mainnet (testnet 46630 => '0xB626')
    chainName: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
    blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
  },
  tiers: ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic'],
  metaBase: 'assets/nft/stagwifhood',
};

// localStorage overrides (set by /admin) win over the hard-coded values above.
(function () {
  const g = (k) => localStorage.getItem('h20_' + k);
  ['mint', 'staking', 'splitter', 'pact'].forEach((k) => { const v = g(k); if (v) window.HOODED[k] = v; });
  // admin can extend the stakeable-token list from the browser (JSON array of {address,symbol,decimals})
  try { const st = g('stakeTokens'); if (st) { const arr = JSON.parse(st); if (Array.isArray(arr) && arr.length) window.HOODED.stakeTokens = arr; } } catch (e) {}
})();

// Read provider: FREE public RPC first, then the /api/rpc proxy (which uses the PAID Alchemy RPC
// server-side — key never in the browser) as a backup on failure/stall. Reads only; writes go
// through the user's wallet. Falls back to a plain public provider if anything is unavailable.
window.HOODED.readProvider = function () {
  const H = window.HOODED, net = { name: H.chain.chainName, chainId: parseInt(H.chain.chainId, 16) };
  const pub = new ethers.JsonRpcProvider(H.chain.rpcUrls[0], net, { staticNetwork: true });
  try {
    if (typeof location !== 'undefined' && /^https?:/.test(location.protocol)) {
      const proxy = new ethers.JsonRpcProvider(location.origin + '/api/rpc', net, { staticNetwork: true });
      return new ethers.FallbackProvider(
        [{ provider: pub, priority: 1, stallTimeout: 1500, weight: 1 },
         { provider: proxy, priority: 2, stallTimeout: 3000, weight: 1 }], net, { quorum: 1 });
    }
  } catch (e) { /* fall through */ }
  return pub;
};
