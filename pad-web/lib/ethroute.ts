import { encodeAbiParameters, encodePacked, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { CONFIG } from './config';
import { encodeSwapParams, quoteExactIn, type SwapSide } from './swap';

// Paying and getting paid in ETH. Every launch's pool is token/USDG, so ETH
// goes through the router in one transaction:
//   buy : wrap ETH -> WETH/USDG on Uniswap v3 (0.01% pool) -> launch pool (v4)
//   sell: launch pool (v4) -> USDG/WETH on Uniswap v3 -> unwrap -> ETH to you
// Both legs are Uniswap's own contracts; nothing new is deployed or trusted.
// This router (v2.1.x) takes a sixth field on swaps, an array of per-hop
// minimum prices; empty = off. Command ids are from Uniswap's universal-router Commands.sol; the v4 action
// ids match this repo's pinned v4-periphery Actions.sol.

const CMD_V3_SWAP_EXACT_IN = 0x00;
const CMD_WRAP_ETH = 0x0b;
const CMD_UNWRAP_WETH = 0x0c;
const CMD_V4_SWAP = 0x10;
const ACT_SWAP_EXACT_IN_SINGLE = 0x06;
const ACT_SETTLE = 0x0b;
const ACT_SETTLE_ALL = 0x0c;
const ACT_TAKE = 0x0e;
const ACT_TAKE_ALL = 0x0f;

const MSG_SENDER = '0x0000000000000000000000000000000000000001' as Address;
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002' as Address;
const CONTRACT_BALANCE = 1n << 255n; // "whatever the router holds"
const OPEN_DELTA = 0n;

const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

const deadlineIn = (sec: number) => BigInt(Math.floor(Date.now() / 1000) + sec);
const v3Path = (a: Address, b: Address): Hex => encodePacked(['address', 'uint24', 'address'], [a, CONFIG.ethPoolFee, b]);

/** How much USDG `ethIn` buys, or how much ETH `usdgIn` buys, on the v3 pool. */
export async function quoteV3(client: PublicClient, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint> {
  const { result } = await client.simulateContract({
    address: CONFIG.v3Quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle',
    args: [{ tokenIn, tokenOut, amountIn, fee: CONFIG.ethPoolFee, sqrtPriceLimitX96: 0n }],
  });
  return result[0];
}

/** Tokens out for `ethIn` (ETH -> USDG -> launch token), quoted from the live pools. */
export async function quoteBuyWithEth(client: PublicClient, side: Omit<SwapSide, 'amountIn' | 'currencyIn'>, ethIn: bigint): Promise<{ usdg: bigint; out: bigint }> {
  const usdg = await quoteV3(client, CONFIG.weth, CONFIG.usdg, ethIn);
  if (usdg === 0n) return { usdg, out: 0n };
  const out = await quoteExactIn(client, { ...side, currencyIn: CONFIG.usdg, amountIn: usdg });
  return { usdg, out };
}

/** ETH out for selling `tokensIn` (launch token -> USDG -> ETH). */
export async function quoteSellForEth(client: PublicClient, side: Omit<SwapSide, 'amountIn' | 'currencyOut'>, tokensIn: bigint): Promise<{ usdg: bigint; out: bigint }> {
  const usdg = await quoteExactIn(client, { ...side, currencyOut: CONFIG.usdg, amountIn: tokensIn });
  if (usdg === 0n) return { usdg, out: 0n };
  const out = await quoteV3(client, CONFIG.usdg, CONFIG.weth, usdg);
  return { usdg, out };
}

/** execute() args + the ETH to send. `usdgMin` guards the v3 leg, `tokensMin` the whole trade. */
export function buildBuyWithEth(p: { key: SwapSide['key']; zeroForOne: boolean; token: Address; ethIn: bigint; usdgMin: bigint; tokensMin: bigint; deadlineSec?: number }) {
  const commands = encodePacked(['uint8', 'uint8', 'uint8'], [CMD_WRAP_ETH, CMD_V3_SWAP_EXACT_IN, CMD_V4_SWAP]);
  const wrap = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [ADDRESS_THIS, p.ethIn]);
  const v3 = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }, { type: 'uint256[]' }],
    [ADDRESS_THIS, p.ethIn, p.usdgMin, v3Path(CONFIG.weth, CONFIG.usdg), false, []],
  );
  // Pay the pool manager from the router's own USDG, then swap what that credits.
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [CONFIG.usdg, CONTRACT_BALANCE, false]);
  const swap = encodeSwapParams({ key: p.key, zeroForOne: p.zeroForOne, amountIn: OPEN_DELTA, currencyIn: CONFIG.usdg, currencyOut: p.token }, p.tokensMin);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [p.token, p.tokensMin]);
  const actions = encodePacked(['uint8', 'uint8', 'uint8'], [ACT_SETTLE, ACT_SWAP_EXACT_IN_SINGLE, ACT_TAKE_ALL]);
  const v4 = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [settle, swap, take]]);
  return { args: [commands, [wrap, v3, v4], deadlineIn(p.deadlineSec ?? 600)] as const, value: p.ethIn };
}

/** Sell `tokensIn` for ETH sent straight to the wallet; `ethMin` is checked at the end. */
export function buildSellForEth(p: { key: SwapSide['key']; zeroForOne: boolean; token: Address; tokensIn: bigint; ethMin: bigint; deadlineSec?: number }) {
  const commands = encodePacked(['uint8', 'uint8', 'uint8'], [CMD_V4_SWAP, CMD_V3_SWAP_EXACT_IN, CMD_UNWRAP_WETH]);
  const swap = encodeSwapParams({ key: p.key, zeroForOne: p.zeroForOne, amountIn: p.tokensIn, currencyIn: p.token, currencyOut: CONFIG.usdg }, 1n);
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [p.token, p.tokensIn]);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [CONFIG.usdg, ADDRESS_THIS, OPEN_DELTA]);
  const actions = encodePacked(['uint8', 'uint8', 'uint8'], [ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE]);
  const v4 = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [swap, settle, take]]);
  const v3 = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }, { type: 'uint256[]' }],
    [ADDRESS_THIS, CONTRACT_BALANCE, 0n, v3Path(CONFIG.usdg, CONFIG.weth), false, []],
  );
  const unwrap = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [MSG_SENDER, p.ethMin]);
  return { args: [commands, [v4, v3, unwrap], deadlineIn(p.deadlineSec ?? 600)] as const };
}

