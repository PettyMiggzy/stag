import type { Address } from 'viem';

// Next.js only inlines NEXT_PUBLIC_* vars into the client bundle when they're
// referenced as a literal `process.env.NEXT_PUBLIC_X` (static dot access) —
// its compiler pattern-matches that exact syntax at build time. A helper
// that does `process.env[name]` with a dynamic `name` can NEVER be inlined:
// the browser has no real process.env, so that lookup silently returns
// undefined for every visitor, no matter what's set in Vercel. This is why
// each addr() call below passes the already-resolved `process.env.NEXT_PUBLIC_X`
// value in, rather than the var's name — the CONFIG object is what needs the
// static references, not this function.
function addr(value: string | undefined, label: string, fallback?: string): Address {
  const v = value ?? fallback;
  if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${label} is unset or isn't a 0x address`);
  return v as Address;
}

/** Like addr(), but empty means "not deployed" and gives ''. */
function optAddr(value: string | undefined, label: string, fallback = ''): Address | '' {
  const v = value ?? fallback;
  return v === '' ? '' : addr(v, label);
}

export const CONFIG = {
  // Robinhood Chain's own RPC: CORS-open and write-capable (wallets are handed
  // it when they add the network, so it must accept eth_sendRawTransaction).
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com',
  // An env var rather than a constant; the default, 4663, is Robinhood Chain
  // mainnet, where STAG Pad is deployed.
  chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 4663),
  chainName: process.env.NEXT_PUBLIC_CHAIN_NAME ?? 'Robinhood Chain',
  explorerUrl: process.env.NEXT_PUBLIC_EXPLORER_URL ?? 'https://robinhoodchain.blockscout.com',
  brand: process.env.NEXT_PUBLIC_BRAND ?? 'STAG Pad by Jarvis',
  tagline: process.env.NEXT_PUBLIC_TAGLINE ?? 'Pick your price. Launch in one transaction.',
  // The site's public URL, for absolute social-preview links.
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? 'https://stag-pad.vercel.app',
  // WalletConnect (Reown) project id. Public by design. Injected wallets (MetaMask,
  // Rabby, Coinbase Wallet extension) work without one; phone wallets need it.
  walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '',
  // Optional: a separate main site, linked as "Home" in the nav.
  homeUrl: process.env.NEXT_PUBLIC_HOME_URL ?? 'https://stag-preview-oversize-escort-hub.vercel.app',
  // The pad admin wallet (owns the treasury, the factory and the house pad), shown on the /admin page.
  padAdmin: process.env.NEXT_PUBLIC_PAD_ADMIN ?? '0x7696Cd99d1EbC0F3A5a4A8525377ec35C6Ca196D',
  milestoneUsd: Number(process.env.NEXT_PUBLIC_MILESTONE_USD ?? 30000),
  // STAG Pad on Robinhood Chain (pad-contracts/DEPLOYED.md): the main portal
  // (opening market cap $100 and up) and its shared hook. 20% of the tax, every
  // LP fee, and the fee desk, as in the V4 relaunch stack it was deployed from.
  portal: addr(process.env.NEXT_PUBLIC_PORTAL, 'NEXT_PUBLIC_PORTAL', '0xAA34Fc6CD722344B61592E07369634BD72e8226d'),
  hook: addr(process.env.NEXT_PUBLIC_HOOK, 'NEXT_PUBLIC_HOOK', '0x319Fdb13053C5CFf7F610bd05AAE891D870dA8Cc'),
  treasury: addr(process.env.NEXT_PUBLIC_TREASURY, 'NEXT_PUBLIC_TREASURY', '0x32E53bc783F1FB0432A06225350EB65c85E949e8'),
  // RobinFeeDesk: the platform takes every LP fee (the USDG side to the treasury,
  // the token side to this desk, which sells it at 10% off) and 20% of the tax.
  feeDesk: optAddr(process.env.NEXT_PUBLIC_FEE_DESK, 'NEXT_PUBLIC_FEE_DESK', '0xF24FB67f3e43dE6b23284C504E1831EC74F11215'),
  // White-label pad factory: its pads (the house pad included) also pay the treasury.
  factory: addr(process.env.NEXT_PUBLIC_FACTORY, 'NEXT_PUBLIC_FACTORY', '0xA856E63Ae02856A668a00A7fE7bAf7Ce337Fd3Cf'),
  // Uniswap v4's PoolManager and UniversalRouter (v2.1.1) on Robinhood Chain.
  poolManager: addr(process.env.NEXT_PUBLIC_POOL_MANAGER, 'NEXT_PUBLIC_POOL_MANAGER', '0x8366a39CC670B4001A1121B8F6A443A643e40951'),
  router: addr(process.env.NEXT_PUBLIC_ROUTER, 'NEXT_PUBLIC_ROUTER', '0x8876789976decbfcbbbe364623c63652db8c0904'),
  permit2: addr(process.env.NEXT_PUBLIC_PERMIT2, 'NEXT_PUBLIC_PERMIT2', '0x000000000022D473030F116dDEE9F6B43aC78BA3'),
  // USDG (Global Dollar, Paxos), 6 decimals: every pool's quote asset. Gas is ETH.
  usdg: addr(process.env.NEXT_PUBLIC_USDG, 'NEXT_PUBLIC_USDG', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'),
  // ETH route: people pay and get paid in ETH. The router wraps it and trades
  // WETH <-> USDG on Uniswap v3's deep 0.01% pool, then the launch's v4 pool.
  // No contract of ours is involved in that leg.
  weth: addr(undefined, 'WETH', '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'),
  v3Quoter: addr(undefined, 'V3_QUOTER', '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7'),
  ethPoolFee: 100,
  // FALSE, not true (see the comment in .env.example):
  // RobinHook/RobinPortal explicitly revert on quoteAsset == address(0)
  // (NativeQuoteUnsupported / ZeroAddress). There is no native-currency
  // code path in these contracts at all — confirmed directly against
  // RobinLocker's unconditional IERC20.safeTransfer usage on both pool
  // currencies. The quote leg is always a real ERC-20 transfer, never
  // msg.value.
  quoteIsNative: (process.env.NEXT_PUBLIC_QUOTE_IS_NATIVE ?? 'false') === 'true',
  quoteDecimals: Number(process.env.NEXT_PUBLIC_QUOTE_DECIMALS ?? 6),
  // Optional. When set, lib/data.ts reads stats/trades/holders/candles from
  // pad-indexer's HTTP API instead of returning honest empty/unknown values for
  // the fields that need real trade history — no other code changes needed.
  indexerUrl: process.env.NEXT_PUBLIC_INDEXER_URL ?? '',
  // The block CONFIG.portal was deployed at. No LaunchCreated log can exist
  // before this, so it's a safe, permanent floor for the launch scan in
  // lib/launches.ts — it avoids an unbounded fromBlock:0 eth_getLogs call,
  // which public RPC providers (Alchemy included) reject past a ~10k block
  // range on any chain with real age.
  portalGenesisBlock: BigInt(process.env.NEXT_PUBLIC_PORTAL_GENESIS_BLOCK || 87453000),
  poolFee: 10_000,
  tickSpacing: 200,
  totalSupply: 1_000_000_000n * 10n ** 18n,
  maxTaxBps: 1000,
} as const;

export const explorerTx = (h: string) => (CONFIG.explorerUrl ? `${CONFIG.explorerUrl}/tx/${h}` : '');
export const explorerAddr = (a: string) => (CONFIG.explorerUrl ? `${CONFIG.explorerUrl}/address/${a}` : '');

/**
 * One deployment of the pad: a portal, the hook its pools use, and its
 * white-label factory. Launches live forever, so after a redeploy the older
 * portals stay listed and tradeable next to the current one.
 */
export type PadGeneration = {
  portal: Address; hook: Address; factory: Address; genesisBlock: bigint;
  /** The fee desk its launches send token-side LP fees to; '' if none. */
  feeDesk: Address | '';
};

const ALL_GENERATIONS: PadGeneration[] = [
  { portal: CONFIG.portal, hook: CONFIG.hook, factory: CONFIG.factory, genesisBlock: CONFIG.portalGenesisBlock, feeDesk: CONFIG.feeDesk },
  // A future redeploy (V2) adds its entry here, with the old one kept so its coins stay listed.
];

/** The current deployment first, then older ones (each once). */
export const GENERATIONS: PadGeneration[] = ALL_GENERATIONS.filter(
  (g, i) => ALL_GENERATIONS.findIndex((x) => x.portal.toLowerCase() === g.portal.toLowerCase()) === i,
);

export function generationOf(portal?: string): PadGeneration {
  return GENERATIONS.find((g) => g.portal.toLowerCase() === portal?.toLowerCase()) ?? GENERATIONS[0];
}
