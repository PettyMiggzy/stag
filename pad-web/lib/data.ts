import { createPublicClient, decodeEventLog, parseAbiItem, type Address } from 'viem';
import { robinhood } from './chain';
import { CONFIG } from './config';
import { chainTransport } from './rpc';
import { poolManagerAbi, erc20Abi } from './abi';
import { poolKeyFor, poolId, slot0Slot, decodeSlot0, priceFromSqrt, priceFromTick } from './pool';

export const publicClient = createPublicClient({ chain: robinhood, transport: chainTransport({ batch: true }) });

export type Launch = {
  /** The portal that launched it and its pool's hook (older deployments have their own). */
  portal: Address; hook: Address;
  token: Address; creator: Address; locker: Address; splitter: Address; poolId: `0x${string}`;
  name: string; symbol: string; blockNumber: bigint; txHash: `0x${string}`; createdAt: number;
  // From LaunchCreated; optional because pad-indexer's /launches payload doesn't carry them.
  tokenIsToken0?: boolean; buyTaxBps?: number; sellTaxBps?: number; tickLower?: number; tickUpper?: number;
};

const rangeOf = (l?: Launch | null) => (l && l.tickLower !== undefined && l.tickUpper !== undefined ? { tickLower: l.tickLower, tickUpper: l.tickUpper } : undefined);

// priceUsd/marketCapUsd are always real (read straight from pool state — see
// fetchSpot). The rest need trade history no cheap on-chain read can give
// us, so they're `undefined` — not a guess, not a fabricated placeholder —
// until NEXT_PUBLIC_INDEXER_URL points at a running pad-indexer. Every
// consumer already renders `undefined` as "—" (fmtUsd/fmtPct), so this is
// the honest value, not a display bug.
export type TokenStats = {
  priceUsd: number; marketCapUsd: number; volume24hUsd?: number; change24hPct?: number;
  holders?: number; txns24h?: number; liquidityUsd?: number;
};

export type Trade = { hash: `0x${string}`; ts: number; isBuy: boolean; usd: number; tokens: number; trader: Address };
export type Holder = { address: Address; balance: number; pct: number; tag?: string };
export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

// ---------------------------------------------------------------------------
// Optional real data source: pad-indexer's HTTP API. Every function below tries
// this first (when NEXT_PUBLIC_INDEXER_URL is set) and falls back to a
// real on-chain read where one exists cheaply (the /api/launches index,
// getHolders' locker balance) or an honest empty/unknown result where it
// doesn't — never to invented numbers — so the app keeps working, truthfully,
// with zero indexer configured.
// ---------------------------------------------------------------------------
async function indexerGet<T>(path: string): Promise<T | null> {
  if (!CONFIG.indexerUrl) return null;
  try {
    const res = await fetch(`${CONFIG.indexerUrl}${path}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Launches come from this deployment's own /api/launches index (a server-side
// incremental scan of LaunchCreated logs, cached in Postgres — see
// lib/launches.ts), so browsers never scan chain history themselves.
// ---------------------------------------------------------------------------
type LaunchJson = Omit<Launch, 'blockNumber'> & { blockNumber: string | number };
const fromJson = (l: LaunchJson): Launch => ({ ...l, blockNumber: BigInt(l.blockNumber) });

async function launchApi(query = ''): Promise<Launch[]> {
  const res = await fetch(`/api/launches${query}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`The launch list request failed (${res.status})`);
  const body = (await res.json()) as { launches: LaunchJson[] };
  return body.launches.map(fromJson);
}

export async function fetchLaunches(): Promise<Launch[]> {
  const indexed = await indexerGet<LaunchJson[]>('/launches');
  if (indexed) return indexed.map(fromJson);
  return launchApi();
}

/** null only when the index confirms the address isn't a launch; throws when the lookup itself fails. */
export async function fetchLaunch(token: Address): Promise<Launch | null> {
  const res = await fetch(`/api/launches?token=${token}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`The launch lookup failed (${res.status})`);
  const body = (await res.json()) as { launches: LaunchJson[]; stale?: boolean };
  if (body.launches[0]) return fromJson(body.launches[0]);
  // A miss while the site's chain scan is behind proves nothing: throw so the
  // lookup retries, instead of showing a real token as "not found".
  if (body.stale) throw new Error('The launch list is catching up');
  return null;
}

// ---------------------------------------------------------------------------
// REAL: spot price + market cap straight from PoolManager storage.
// ---------------------------------------------------------------------------
/**
 * When the launch's position range is known, the displayed price is clamped
 * to it. Outside the range there is no liquidity, so slot0 there is not a
 * tradable price — and anyone can move it there for free (a swap across empty
 * ticks costs nothing), which would otherwise let a griefer make any fresh
 * launch show a ~$0 or absurd market cap.
 */
export async function fetchSpot(token: Address, range?: { tickLower: number; tickUpper: number }, hook?: Address) {
  const { key, tokenIsToken0 } = poolKeyFor(token, hook);
  const id = poolId(key);
  const word = await publicClient.readContract({ address: CONFIG.poolManager, abi: poolManagerAbi, functionName: 'extsload', args: [slot0Slot(id)] });
  const s0 = decodeSlot0(word);
  let priceUsd = s0.sqrtPriceX96 === 0n ? 0 : priceFromSqrt(s0.sqrtPriceX96, tokenIsToken0, CONFIG.quoteDecimals);
  if (range && s0.sqrtPriceX96 !== 0n && (s0.tick < range.tickLower || s0.tick >= range.tickUpper)) {
    const edge = s0.tick < range.tickLower ? range.tickLower : range.tickUpper;
    priceUsd = priceFromTick(edge, tokenIsToken0, CONFIG.quoteDecimals);
  }
  return { priceUsd, marketCapUsd: priceUsd * 1e9, tick: s0.tick, poolId: id, tokenIsToken0 };
}

// ---------------------------------------------------------------------------
// getStats / getTrades / getHolders / getCandles all prefer pad-indexer's
// HTTP API (see indexerGet above). Without one configured, each falls back to
// whatever is CHEAPLY and HONESTLY readable straight from chain — never to
// invented numbers. Trade history, holder counts and OHLC candles need a
// real event-log index to answer honestly, so those come back empty/unknown
// until NEXT_PUBLIC_INDEXER_URL points at a running pad-indexer — every
// consumer (StatCards, TradesTable, HoldersTable, CandleChart) already
// renders that as "—" or an empty-state line, not a zero.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Without an indexer, trades, candles and 24h volume are rebuilt straight from
// the PoolManager's Swap events for the launch's pool. Looks back at most
// ~2.3 days (20 x 100k blocks) so a browser never scans a long history; the
// scan is incremental and cached per token for the life of the page.
// ---------------------------------------------------------------------------
const SWAP_EVENT = parseAbiItem('event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)');
type SwapRow = { hash: `0x${string}`; block: bigint; sender: Address; isBuy: boolean; usd: number; tokens: number; price: number };
type SwapCache = { lastBlock: bigint; rows: SwapRow[]; stamps: Map<bigint, number>; at: number; pending?: Promise<SwapRow[]> };
const swapCache = new Map<string, SwapCache>();
const SWAP_CHUNK = 99_999n;
const SWAP_MAX_CHUNKS = 20;

async function swapsOf(l: Launch): Promise<SwapRow[]> {
  if (l.tokenIsToken0 === undefined) return [];
  const k = l.token.toLowerCase();
  let c = swapCache.get(k);
  if (!c) { c = { lastBlock: -1n, rows: [], stamps: new Map(), at: 0 }; swapCache.set(k, c); }
  if (c.pending) return c.pending;
  if (Date.now() - c.at < 15_000) return c.rows;
  const cache = c;
  cache.pending = (async () => {
    try {
      const tip = await publicClient.getBlockNumber({ cacheTime: 0 });
      const floor = tip - SWAP_CHUNK * BigInt(SWAP_MAX_CHUNKS);
      let from = cache.lastBlock >= 0n ? cache.lastBlock + 1n : (l.blockNumber > floor ? l.blockNumber : floor);
      const id = poolId(poolKeyFor(l.token, l.hook).key);
      while (from <= tip) {
        const to = from + SWAP_CHUNK > tip ? tip : from + SWAP_CHUNK;
        const logs = await publicClient.getLogs({ address: CONFIG.poolManager, event: SWAP_EVENT, args: { id }, fromBlock: from, toBlock: to, strict: true });
        for (const lg of logs) {
          const a = lg.args;
          const t0 = l.tokenIsToken0 === true;
          const [tokenAmt, quoteAmt] = t0 ? [a.amount0, a.amount1] : [a.amount1, a.amount0];
          cache.rows.push({
            hash: lg.transactionHash, block: lg.blockNumber, sender: a.sender,
            isBuy: tokenAmt < 0n,
            usd: Math.abs(Number(quoteAmt)) / 10 ** CONFIG.quoteDecimals,
            tokens: Math.abs(Number(tokenAmt)) / 1e18,
            price: priceFromSqrt(a.sqrtPriceX96, t0, CONFIG.quoteDecimals),
          });
        }
        cache.lastBlock = to;
        from = to + 1n;
      }
      const need = [...new Set(cache.rows.map((r) => r.block))].filter((b) => !cache.stamps.has(b));
      await Promise.all(need.map(async (b) => { cache.stamps.set(b, Number((await publicClient.getBlock({ blockNumber: b })).timestamp)); }));
      cache.at = Date.now();
    } catch { /* serve what we have */ }
    cache.pending = undefined;
    return cache.rows;
  })();
  return cache.pending;
}

const tsOf = (l: Launch, r: SwapRow) => swapCache.get(l.token.toLowerCase())?.stamps.get(r.block) ?? 0;

/** 24h volume and price change from the pool's own swaps. */
async function chainActivity(l: Launch): Promise<{ volume24hUsd: number; change24hPct?: number; txns24h: number }> {
  const rows = await swapsOf(l);
  const since = Date.now() / 1000 - 86_400;
  const day = rows.filter((r) => tsOf(l, r) >= since);
  const before = [...rows].reverse().find((r) => tsOf(l, r) < since);
  const first = before?.price ?? day[0]?.price;
  const last = rows[rows.length - 1]?.price;
  return {
    volume24hUsd: day.reduce((a, r) => a + r.usd, 0),
    change24hPct: first && last ? ((last - first) / first) * 100 : undefined,
    txns24h: day.length,
  };
}

/** `liquidity: true` also values the pool from chain (the token page); lists skip that read. */
export async function getStats(token: Address, launch?: Launch | null, opts: { liquidity?: boolean } = {}): Promise<TokenStats> {
  const indexed = await indexerGet<TokenStats>(`/stats/${token}`);
  if (indexed) return indexed;

  const { priceUsd, marketCapUsd } = await fetchSpot(token, rangeOf(launch), launch?.hook).catch(() => ({ priceUsd: 0, marketCapUsd: 0 }));
  const liquidityUsd = opts.liquidity && launch && priceUsd > 0 ? await poolLiquidityUsd(launch, priceUsd).catch(() => undefined) : undefined;
  const act = launch ? await chainActivity(launch).catch(() => undefined) : undefined;
  return { priceUsd, marketCapUsd, liquidityUsd, ...act };
}

// The launch position's liquidity (L) never changes after the launch: the
// locker can't add or remove any. So it's read once, from the Seeded event in
// the launch transaction.
const SEEDED = parseAbiItem('event Seeded(uint128 liquidity, uint256 amount0, uint256 amount1)');
const seededLiquidity = new Map<string, Promise<bigint | undefined>>();

function positionLiquidity(l: Launch): Promise<bigint | undefined> {
  const k = l.token.toLowerCase();
  let p = seededLiquidity.get(k);
  if (!p) {
    p = publicClient.getTransactionReceipt({ hash: l.txHash }).then((rc) => {
      for (const log of rc.logs) {
        if (log.address.toLowerCase() !== l.locker.toLowerCase()) continue;
        try { return decodeEventLog({ abi: [SEEDED], data: log.data, topics: log.topics }).args.liquidity; } catch { /* a different event */ }
      }
      return undefined;
    });
    p.catch(() => seededLiquidity.delete(k));
    seededLiquidity.set(k, p);
  }
  return p;
}

/**
 * What the launch's pool holds, valued at the current price: the tokens
 * still in the position plus the USDG buyers have paid in. It's the figure
 * DexScreener shows as liquidity. At launch it equals the starting market
 * cap, because the whole supply starts in the pool.
 */
async function poolLiquidityUsd(l: Launch, priceUsd: number): Promise<number | undefined> {
  if (l.tickLower === undefined || l.tickUpper === undefined || l.tokenIsToken0 === undefined) return undefined;
  const L = await positionLiquidity(l);
  if (L === undefined) return undefined;
  const word = await publicClient.readContract({ address: CONFIG.poolManager, abi: poolManagerAbi, functionName: 'extsload', args: [slot0Slot(poolId(poolKeyFor(l.token, l.hook).key))] });
  const { sqrtPriceX96 } = decodeSlot0(word);
  // Standard concentrated-liquidity amounts, in floating point (display only).
  const sa = Math.pow(1.0001, l.tickLower / 2);
  const sb = Math.pow(1.0001, l.tickUpper / 2);
  const sp = Math.min(Math.max(Number(sqrtPriceX96) / 2 ** 96, sa), sb);
  const liq = Number(L);
  const amount0 = (liq * (sb - sp)) / (sp * sb);
  const amount1 = liq * (sp - sa);
  const [tokenRaw, usdgRaw] = l.tokenIsToken0 ? [amount0, amount1] : [amount1, amount0];
  return (tokenRaw / 1e18) * priceUsd + usdgRaw / 10 ** CONFIG.quoteDecimals;
}

export async function getTrades(token: Address, n = 30, launch?: Launch | null): Promise<Trade[]> {
  const indexed = await indexerGet<Trade[]>(`/trades/${token}?n=${n}`);
  if (indexed) return indexed;
  if (!launch) return [];
  const rows = (await swapsOf(launch)).slice(-n).reverse();
  return Promise.all(rows.map(async (r) => ({
    hash: r.hash, ts: tsOf(launch, r), isBuy: r.isBuy, usd: r.usd, tokens: r.tokens,
    trader: await publicClient.getTransaction({ hash: r.hash }).then((t) => t.from).catch(() => r.sender),
  })));
}

/**
 * The launch's locked liquidity lives in the Uniswap v4 PoolManager, not the
 * locker: seeding moves the whole supply into the position, and the locker
 * keeps only rounding dust. So the PoolManager's balance is the locked-LP
 * row (it can also include any other pool for this token), the locker's
 * dust is dropped, and without an indexer that row is the one real holder
 * we can show from a single on-chain read.
 */
const LOCKED_LP_TAG = 'Pool liquidity, locked';

export async function getHolders(token: Address, launch?: Launch | null): Promise<Holder[]> {
  const pm = CONFIG.poolManager.toLowerCase();
  const locker = launch?.locker.toLowerCase();
  const indexed = await indexerGet<Holder[]>(`/holders/${token}?n=20`);
  if (indexed) {
    return indexed
      .filter((h) => h.address.toLowerCase() !== locker)
      .map((h) => (h.address.toLowerCase() === pm ? { ...h, tag: LOCKED_LP_TAG } : h));
  }
  if (!launch) return [];

  const balance = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [CONFIG.poolManager] }).catch(() => 0n);
  if (balance === 0n) return [];
  const pct = Number((balance * 10_000n) / CONFIG.totalSupply) / 100;
  return [{ address: CONFIG.poolManager, balance: Number(balance) / 1e18, pct, tag: LOCKED_LP_TAG }];
}

export async function getCandles(token: Address, n = 96, intervalSec = 900, launch?: Launch | null): Promise<Candle[]> {
  const indexed = await indexerGet<Candle[]>(`/candles/${token}?n=${n}&interval=${intervalSec}`);
  if (indexed && indexed.length) return indexed;
  if (!launch) return [];
  const rows = await swapsOf(launch);
  if (!rows.length) return [];
  const buckets = new Map<number, Candle>();
  let prev = launch.tickLower !== undefined && launch.tickUpper !== undefined && launch.tokenIsToken0 !== undefined
    ? priceFromTick(launch.tokenIsToken0 ? launch.tickLower : launch.tickUpper, launch.tokenIsToken0, CONFIG.quoteDecimals) : rows[0].price;
  const keys: number[] = [];
  for (const r of rows) {
    const t = Math.floor(tsOf(launch, r) / intervalSec) * intervalSec;
    let c = buckets.get(t);
    if (!c) { c = { t, o: prev, h: prev, l: prev, c: prev, v: 0 }; buckets.set(t, c); keys.push(t); }
    c.h = Math.max(c.h, r.price); c.l = Math.min(c.l, r.price); c.c = r.price; c.v += r.usd;
    prev = r.price;
  }
  // Fill quiet intervals with flat candles at the last price, up to now.
  const out: Candle[] = [];
  const end = Math.floor(Date.now() / 1000 / intervalSec) * intervalSec;
  let last = buckets.get(keys[0])!.o;
  for (let t = keys[0]; t <= end && out.length < 5000; t += intervalSec) {
    const c = buckets.get(t) ?? { t, o: last, h: last, l: last, c: last, v: 0 };
    out.push(c); last = c.c;
  }
  return out.slice(-n);
}
