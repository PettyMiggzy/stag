import {
  createPublicClient, encodeAbiParameters, encodeFunctionData, encodePacked, decodeErrorResult, defineChain, http, keccak256, maxUint256, parseAbi, parseAbiItem,
  type Address, type Hash, type Hex, type PublicClient, type WalletClient,
} from 'viem';

/**
 * $STAG Pad SDK. Everything a bot or sniper needs, on viem only:
 *  - watch new launches, read prices, quote
 *  - buy and sell with ETH (wrap -> Uniswap v3 WETH/USDG -> launch pool, one tx) or USDG
 * Launch tokens trade in Uniswap v4 pools with the pad's hook, so the creator's
 * buy/sell tax is applied on EVERY swap path (this SDK, the site, or a direct
 * PoolManager swap from your own contract). Nothing here can skip it.
 */

export const ADDRESSES = {
  chainId: 4663,
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  portal: '0xAA34Fc6CD722344B61592E07369634BD72e8226d' as Address, // main pad: LaunchCreated events come from here
  hook: '0x319Fdb13053C5CFf7F610bd05AAE891D870dA8Cc' as Address,
  feeDesk: '0xF24FB67f3e43dE6b23284C504E1831EC74F11215' as Address,
  housePad: '0xE078f4C3818eC6a87FE6DA08e0c1706dC479ff81' as Address, // "STAG Pad by Jarvis" holder pad
  factory: '0xA856E63Ae02856A668a00A7fE7bAf7Ce337Fd3Cf' as Address,
  poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951' as Address,
  universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904' as Address,
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address,
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address,
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address,
  v3Quoter: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7' as Address,
  ethPoolFee: 100, // Uniswap v3 WETH/USDG 0.01% pool
  poolFee: 10_000, // every launch pool: 1%
  tickSpacing: 200,
  genesisBlock: 87_453_000n,
} as const;

export const chain = defineChain({
  id: ADDRESSES.chainId, name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ADDRESSES.rpcUrl] } },
});

export const launchCreatedEvent = parseAbiItem(
  'event LaunchCreated(address indexed token, address indexed creator, address locker, address splitter, bytes32 poolId, address quoteAsset, bool tokenIsToken0, uint16 buyTaxBps, uint16 sellTaxBps, int24 tickLower, int24 tickUpper, uint160 initSqrtPriceX96, string name, string symbol)',
);
const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
]);
const permit2Abi = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);
const routerAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);
const poolManagerAbi = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)']);
const routerErrorsAbi = parseAbi(['error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)']);

export type Launch = {
  token: Address; creator: Address; locker: Address; splitter: Address; poolId: Hex; quoteAsset: Address; tokenIsToken0: boolean;
  buyTaxBps: number; sellTaxBps: number; tickLower: number; tickUpper: number; name: string; symbol: string; blockNumber: bigint; txHash: Hash;
};
export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
export type TradeOpts = { slippageBps?: number; deadlineSec?: number };

// ───────────────────────── pool helpers ─────────────────────────
export function poolKeyFor(token: Address, hook: Address = ADDRESSES.hook): { key: PoolKey; tokenIsToken0: boolean } {
  const tokenIsToken0 = token.toLowerCase() < ADDRESSES.usdg.toLowerCase();
  return {
    tokenIsToken0,
    key: {
      currency0: tokenIsToken0 ? token : ADDRESSES.usdg, currency1: tokenIsToken0 ? ADDRESSES.usdg : token,
      fee: ADDRESSES.poolFee, tickSpacing: ADDRESSES.tickSpacing, hooks: hook,
    },
  };
}
export const poolId = (k: PoolKey): Hex => keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
  [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));

/** Current price of 1 token in USDG, read straight from the pool (slot0). */
export async function priceUsdg(pc: PublicClient, token: Address, hook?: Address): Promise<number> {
  const { key, tokenIsToken0 } = poolKeyFor(token, hook);
  const slot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId(key), 6n]));
  const word = BigInt(await pc.readContract({ address: ADDRESSES.poolManager, abi: poolManagerAbi, functionName: 'extsload', args: [slot] }));
  const sqrt = Number(word & ((1n << 160n) - 1n)) / 2 ** 96;
  const raw = sqrt * sqrt; // token1 per token0
  return (tokenIsToken0 ? raw : 1 / raw) * 1e12; // 18-dec token vs 6-dec USDG
}

// ───────────────────────── router encoding ─────────────────────────
const CMD = { V3_SWAP_EXACT_IN: 0x00, WRAP_ETH: 0x0b, UNWRAP_WETH: 0x0c, V4_SWAP: 0x10 } as const;
const ACT = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE: 0x0b, SETTLE_ALL: 0x0c, TAKE: 0x0e, TAKE_ALL: 0x0f } as const;
const MSG_SENDER = '0x0000000000000000000000000000000000000001' as Address;
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002' as Address;
const CONTRACT_BALANCE = 1n << 255n;
const deadlineIn = (s: number) => BigInt(Math.floor(Date.now() / 1000) + s);
const v3Path = (a: Address, b: Address): Hex => encodePacked(['address', 'uint24', 'address'], [a, ADDRESSES.ethPoolFee, b]);
const keyTuple = { type: 'tuple', components: [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] } as const;

function swapParams(key: PoolKey, zeroForOne: boolean, amountIn: bigint, minOut: bigint): Hex {
  return encodeAbiParameters([{ type: 'tuple', components: [
    { name: 'poolKey', ...keyTuple }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' }, { name: 'minHopPriceX36', type: 'uint256' }, { name: 'hookData', type: 'bytes' }] }],
  [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: '0x' }]);
}
const v3Input = (amountIn: bigint, minOut: bigint, path: Hex) => encodeAbiParameters(
  [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }, { type: 'uint256[]' }],
  [ADDRESS_THIS, amountIn, minOut, path, false, []]);
const v4 = (actions: number[], params: Hex[]) => encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [encodePacked(actions.map(() => 'uint8' as const), actions), params]);
const takeAll = (c: Address, min: bigint) => encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [c, min]);

/** Exact output of a v4 swap on the live pool, tax and fees included (reverts-with-amount trick, no funds move). */
async function quoteV4(pc: PublicClient, key: PoolKey, zeroForOne: boolean, amountIn: bigint, currencyOut: Address): Promise<bigint> {
  const input = v4([ACT.SWAP_EXACT_IN_SINGLE, ACT.TAKE_ALL], [swapParams(key, zeroForOne, amountIn, 0n), takeAll(currencyOut, maxUint256)]);
  const data = encodeFunctionData({ abi: routerAbi, functionName: 'execute', args: [encodePacked(['uint8'], [CMD.V4_SWAP]), [input], deadlineIn(600)] });
  try { await pc.call({ to: ADDRESSES.universalRouter, data }); } catch (e) {
    let err: any = e;
    for (let i = 0; i < 8 && err; i++, err = err.cause) {
      const raw = err?.data; const hex = typeof raw === 'string' ? raw : raw?.data;
      if (typeof hex === 'string' && hex.startsWith('0x')) {
        try { return decodeErrorResult({ abi: routerErrorsAbi, data: hex as Hex }).args[1]; } catch { /* other revert */ }
        if (hex.startsWith('0x90bfb865') && hex.includes('43d335e6')) return 0n; // NoLiquidityToFill: nothing to trade against yet
      }
    }
    throw e;
  }
  throw new Error('quote call returned instead of reverting');
}
async function quoteV3(pc: PublicClient, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint> {
  const { result } = await pc.simulateContract({ address: ADDRESSES.v3Quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle',
    args: [{ tokenIn, tokenOut, amountIn, fee: ADDRESSES.ethPoolFee, sqrtPriceLimitX96: 0n }] });
  return result[0];
}

// ───────────────────────── the client ─────────────────────────
export function createPad(opts: { rpcUrl?: string; publicClient?: PublicClient } = {}) {
  const pc: PublicClient = opts.publicClient ?? createPublicClient({ chain, transport: http(opts.rpcUrl ?? ADDRESSES.rpcUrl, { batch: true }) });
  const slip = (v: bigint, bps = 100) => (v * BigInt(10_000 - bps)) / 10_000n;

  async function approveRouter(wc: WalletClient, token: Address, amount: bigint) {
    const owner = wc.account!.address;
    if ((await pc.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, ADDRESSES.permit2] })) < amount) {
      await pc.waitForTransactionReceipt({ hash: await wc.writeContract({ chain, account: wc.account!, address: token, abi: erc20Abi, functionName: 'approve', args: [ADDRESSES.permit2, amount] }) });
    }
    const [amt, exp] = await pc.readContract({ address: ADDRESSES.permit2, abi: permit2Abi, functionName: 'allowance', args: [owner, token, ADDRESSES.universalRouter] });
    const now = Math.floor(Date.now() / 1000);
    if (amt < amount || exp <= now + 60) {
      await pc.waitForTransactionReceipt({ hash: await wc.writeContract({ chain, account: wc.account!, address: ADDRESSES.permit2, abi: permit2Abi, functionName: 'approve', args: [token, ADDRESSES.universalRouter, amount, now + 86_400] }) });
    }
  }
  async function send(wc: WalletClient, args: readonly [Hex, readonly Hex[], bigint], value?: bigint): Promise<Hash> {
    await pc.simulateContract({ address: ADDRESSES.universalRouter, abi: routerAbi, functionName: 'execute', args: args as never, value, account: wc.account! });
    return wc.writeContract({ chain, account: wc.account!, address: ADDRESSES.universalRouter, abi: routerAbi, functionName: 'execute', args: args as never, value });
  }

  return {
    publicClient: pc, addresses: ADDRESSES, poolKeyFor, poolId,
    price: (token: Address, hook?: Address) => priceUsdg(pc, token, hook),

    /** Past launches from the main pad, newest last. Scans in 100k-block steps (the RPC's limit). */
    async launches(fromBlock: bigint = ADDRESSES.genesisBlock, toBlock?: bigint): Promise<Launch[]> {
      const tip = toBlock ?? (await pc.getBlockNumber());
      const out: Launch[] = [];
      for (let from = fromBlock; from <= tip; from += 100_000n) {
        const to = from + 99_999n > tip ? tip : from + 99_999n;
        const logs = await pc.getLogs({ address: ADDRESSES.portal, event: launchCreatedEvent, fromBlock: from, toBlock: to, strict: true });
        for (const l of logs) out.push({ ...l.args, blockNumber: l.blockNumber, txHash: l.transactionHash } as Launch);
      }
      return out;
    },
    /** Calls `onLaunch` the moment a launch is mined. Returns an unsubscribe function. */
    watchLaunches(onLaunch: (l: Launch) => void | Promise<void>) {
      return pc.watchEvent({ address: ADDRESSES.portal, event: launchCreatedEvent, strict: true, pollingInterval: 500,
        onLogs: (logs) => { for (const l of logs) void onLaunch({ ...l.args, blockNumber: l.blockNumber, txHash: l.transactionHash } as Launch); } });
    },

    /** Tokens you would get for `ethIn` wei, with the USDG hop. */
    async quoteBuyWithEth(token: Address, ethIn: bigint) {
      const { key, tokenIsToken0 } = poolKeyFor(token);
      const usdg = await quoteV3(pc, ADDRESSES.weth, ADDRESSES.usdg, ethIn);
      const out = usdg === 0n ? 0n : await quoteV4(pc, key, !tokenIsToken0, usdg, token);
      return { usdg, out };
    },
    async quoteBuyWithUsdg(token: Address, usdgIn: bigint) {
      const { key, tokenIsToken0 } = poolKeyFor(token);
      return quoteV4(pc, key, !tokenIsToken0, usdgIn, token);
    },
    /** ETH (wei) you would get for selling `tokensIn`. */
    async quoteSellForEth(token: Address, tokensIn: bigint) {
      const { key, tokenIsToken0 } = poolKeyFor(token);
      const usdg = await quoteV4(pc, key, tokenIsToken0, tokensIn, ADDRESSES.usdg);
      const out = usdg === 0n ? 0n : await quoteV3(pc, ADDRESSES.usdg, ADDRESSES.weth, usdg);
      return { usdg, out };
    },
    async quoteSellForUsdg(token: Address, tokensIn: bigint) {
      const { key, tokenIsToken0 } = poolKeyFor(token);
      return quoteV4(pc, key, tokenIsToken0, tokensIn, ADDRESSES.usdg);
    },

    /** Buy with ETH in one tx. No approvals. Pass `minOut` to skip the quote (fastest for snipers). */
    async buyWithEth(wc: WalletClient, token: Address, ethIn: bigint, o: TradeOpts & { minTokensOut?: bigint; minUsdg?: bigint } = {}): Promise<Hash> {
      const { key, tokenIsToken0 } = poolKeyFor(token);
      let usdgMin = o.minUsdg, tokensMin = o.minTokensOut;
      if (usdgMin === undefined || tokensMin === undefined) {
        const q = await this.quoteBuyWithEth(token, ethIn);
        if (q.out === 0n) throw new Error('pool has nothing to sell yet');
        usdgMin ??= slip(q.usdg, o.slippageBps); tokensMin ??= slip(q.out, o.slippageBps);
      }
      const commands = encodePacked(['uint8', 'uint8', 'uint8'], [CMD.WRAP_ETH, CMD.V3_SWAP_EXACT_IN, CMD.V4_SWAP]);
      const wrap = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [ADDRESS_THIS, ethIn]);
      const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [ADDRESSES.usdg, CONTRACT_BALANCE, false]);
      const swap = v4([ACT.SETTLE, ACT.SWAP_EXACT_IN_SINGLE, ACT.TAKE_ALL], [settle, swapParams(key, !tokenIsToken0, 0n, tokensMin), takeAll(token, tokensMin)]);
      return send(wc, [commands, [wrap, v3Input(ethIn, usdgMin, v3Path(ADDRESSES.weth, ADDRESSES.usdg)), swap], deadlineIn(o.deadlineSec ?? 120)], ethIn);
    },
    /** Sell for ETH sent to your wallet. Approves the router first when needed. */
    async sellForEth(wc: WalletClient, token: Address, tokensIn: bigint, o: TradeOpts & { minEthOut?: bigint } = {}): Promise<Hash> {
      const { key, tokenIsToken0 } = poolKeyFor(token);
      const ethMin = o.minEthOut ?? slip((await this.quoteSellForEth(token, tokensIn)).out, o.slippageBps);
      if (ethMin === 0n) throw new Error('pool cannot fill this sell (no buyers yet?)');
      await approveRouter(wc, token, tokensIn);
      const commands = encodePacked(['uint8', 'uint8', 'uint8'], [CMD.V4_SWAP, CMD.V3_SWAP_EXACT_IN, CMD.UNWRAP_WETH]);
      const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [token, tokensIn]);
      const take = encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [ADDRESSES.usdg, ADDRESS_THIS, 0n]);
      const swap = v4([ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE_ALL, ACT.TAKE], [swapParams(key, tokenIsToken0, tokensIn, 1n), settle, take]);
      const unwrap = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [MSG_SENDER, ethMin]);
      return send(wc, [commands, [swap, v3Input(CONTRACT_BALANCE, 0n, v3Path(ADDRESSES.usdg, ADDRESSES.weth)), unwrap], deadlineIn(o.deadlineSec ?? 120)]);
    },
    async buyWithUsdg(wc: WalletClient, token: Address, usdgIn: bigint, o: TradeOpts & { minTokensOut?: bigint } = {}): Promise<Hash> {
      const { key, tokenIsToken0 } = poolKeyFor(token);
      const min = o.minTokensOut ?? slip(await this.quoteBuyWithUsdg(token, usdgIn), o.slippageBps);
      if (min === 0n) throw new Error('pool has nothing to sell yet');
      await approveRouter(wc, ADDRESSES.usdg, usdgIn);
      const swap = v4([ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE_ALL, ACT.TAKE_ALL], [swapParams(key, !tokenIsToken0, usdgIn, min),
        encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [ADDRESSES.usdg, usdgIn]), takeAll(token, min)]);
      return send(wc, [encodePacked(['uint8'], [CMD.V4_SWAP]), [swap], deadlineIn(o.deadlineSec ?? 120)]);
    },
    async sellForUsdg(wc: WalletClient, token: Address, tokensIn: bigint, o: TradeOpts & { minUsdgOut?: bigint } = {}): Promise<Hash> {
      const { key, tokenIsToken0 } = poolKeyFor(token);
      const min = o.minUsdgOut ?? slip(await this.quoteSellForUsdg(token, tokensIn), o.slippageBps);
      if (min === 0n) throw new Error('pool cannot fill this sell (no buyers yet?)');
      await approveRouter(wc, token, tokensIn);
      const swap = v4([ACT.SWAP_EXACT_IN_SINGLE, ACT.SETTLE_ALL, ACT.TAKE_ALL], [swapParams(key, tokenIsToken0, tokensIn, min),
        encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [token, tokensIn]), takeAll(ADDRESSES.usdg, min)]);
      return send(wc, [encodePacked(['uint8'], [CMD.V4_SWAP]), [swap], deadlineIn(o.deadlineSec ?? 120)]);
    },
  };
}
