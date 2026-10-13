// Fork test of the ETH route: buy a launch with ETH, then sell it back for ETH.
// anvil --fork-url <RPC> --port 8548 --chain-id 4663, a launch already on the fork (e2e-fork.cjs makes one).
import { createPublicClient, createWalletClient, http, formatEther, formatUnits, parseEther, type Address } from 'viem';
import { robinhood } from '../lib/chain';
import { CONFIG } from '../lib/config';
import { poolKeyFor } from '../lib/pool';
import { erc20Abi, permit2Abi, universalRouterAbi } from '../lib/abi';
import { buildBuyWithEth, buildSellForEth, quoteBuyWithEth, quoteSellForEth } from '../lib/ethroute';

const RPC = process.env.FORK ?? 'http://127.0.0.1:8548';
const token = (process.env.TOKEN ?? '0xfAc3FfDB611aBDaA56592a99b4E5C784383dce6E') as Address;
const WHO = '0x5555555555555555555555555555555555555555' as Address;
const chain = { ...robinhood, rpcUrls: { default: { http: [RPC] } } };
const pc = createPublicClient({ chain, transport: http(RPC) });
const wc = createWalletClient({ chain, transport: http(RPC), account: WHO });
const rpc = (method: string, params: unknown[]) => fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());

await rpc('anvil_setBalance', [WHO, '0x' + parseEther('5').toString(16)]);
await rpc('anvil_impersonateAccount', [WHO]);
const { key, tokenIsToken0 } = poolKeyFor(token);
const buySide = { key, zeroForOne: !tokenIsToken0, currencyOut: token };
const ethIn = parseEther('0.01');

const q = await quoteBuyWithEth(pc, buySide, ethIn);
console.log(`quote: 0.01 ETH -> ${formatUnits(q.usdg, 6)} USDG -> ${formatUnits(q.out, 18)} tokens`);
const buy = buildBuyWithEth({ key, zeroForOne: !tokenIsToken0, token, ethIn, usdgMin: (q.usdg * 99n) / 100n, tokensMin: (q.out * 99n) / 100n });
await pc.simulateContract({ address: CONFIG.router, abi: universalRouterAbi, functionName: 'execute', args: buy.args, value: buy.value, account: WHO });
const h1 = await wc.writeContract({ address: CONFIG.router, abi: universalRouterAbi, functionName: 'execute', args: buy.args, value: buy.value });
console.log('buy status', (await pc.waitForTransactionReceipt({ hash: h1 })).status);
const bal = await pc.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [WHO] });
console.log('tokens received', formatUnits(bal, 18), '(quoted', formatUnits(q.out, 18) + ')');
const leftRouter = await pc.getBalance({ address: CONFIG.router });
console.log('router ETH left', leftRouter);

// sell all back for ETH
const sellSide = { key, zeroForOne: tokenIsToken0, currencyIn: token };
const sq = await quoteSellForEth(pc, sellSide, bal);
console.log(`sell quote: ${formatUnits(bal, 18)} tokens -> ${formatUnits(sq.usdg, 6)} USDG -> ${formatEther(sq.out)} ETH`);
await wc.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [CONFIG.permit2, bal] });
await wc.writeContract({ address: CONFIG.permit2, abi: permit2Abi, functionName: 'approve', args: [token, CONFIG.router, bal, Math.floor(Date.now() / 1000) + 3600] });
const sell = buildSellForEth({ key, zeroForOne: tokenIsToken0, token, tokensIn: bal, ethMin: (sq.out * 99n) / 100n });
await pc.simulateContract({ address: CONFIG.router, abi: universalRouterAbi, functionName: 'execute', args: sell.args, account: WHO });
const before = await pc.getBalance({ address: WHO });
const h2 = await wc.writeContract({ address: CONFIG.router, abi: universalRouterAbi, functionName: 'execute', args: sell.args });
const r2 = await pc.waitForTransactionReceipt({ hash: h2 });
const after = await pc.getBalance({ address: WHO });
const gas = r2.gasUsed * r2.effectiveGasPrice;
console.log('sell status', r2.status, 'ETH received (net of gas)', formatEther(after - before + gas), 'quoted', formatEther(sq.out));
console.log('tokens left', await pc.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [WHO] }));
