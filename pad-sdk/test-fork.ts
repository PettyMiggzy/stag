// Fork test: TOKEN=<a launch on the fork> FORK=http://127.0.0.1:8548 npx tsx test-fork.ts
import { createPublicClient, createWalletClient, http, parseEther, formatUnits, formatEther, type Address } from 'viem';
import { createPad, chain, ADDRESSES } from './src/index.js';
const FORK = process.env.FORK ?? 'http://127.0.0.1:8548'; const token = process.env.TOKEN as Address;
const WHO = '0x6666666666666666666666666666666666666666' as Address;
const rpc = (m: string, p: unknown[]) => fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) });
await rpc('anvil_setBalance', [WHO, '0x' + parseEther('5').toString(16)]); await rpc('anvil_impersonateAccount', [WHO]);
const fc = { ...chain, rpcUrls: { default: { http: [FORK] } } };
const pc = createPublicClient({ chain: fc, transport: http(FORK) });
const pad = createPad({ publicClient: pc as never });
const wc = createWalletClient({ account: WHO, chain: fc, transport: http(FORK) });
const bal = () => pc.readContract({ address: token, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [WHO] });
console.log('launches seen:', (await pad.launches(ADDRESSES.genesisBlock)).length, ' price', await pad.price(token));
const have0 = await bal();
const q = await pad.quoteBuyWithEth(token, parseEther('0.01'));
await pc.waitForTransactionReceipt({ hash: await pad.buyWithEth(wc as never, token, parseEther('0.01')) });
const got = (await bal()) - have0; console.log('ETH buy: got', formatUnits(got, 18), 'quoted', formatUnits(q.out, 18)); if (got !== q.out) throw new Error('buy != quote');
const sq = await pad.quoteSellForEth(token, got / 2n); // note: approvals are sent by sellForEth itself
const b0 = await pc.getBalance({ address: WHO });
const r = await pc.waitForTransactionReceipt({ hash: await pad.sellForEth(wc as never, token, got / 2n) });
const gain = (await pc.getBalance({ address: WHO })) - b0 + r.gasUsed * r.effectiveGasPrice; console.log('ETH sell: got', formatEther(gain), 'quoted', formatEther(sq.out)); if (gain > sq.out || gain < (sq.out * 98n) / 100n) throw new Error('sell != quote (gain is net of the two approval txs)');
const uq = await pad.quoteSellForUsdg(token, got / 4n);
await pc.waitForTransactionReceipt({ hash: await pad.sellForUsdg(wc as never, token, got / 4n) }); console.log('USDG sell ok, quoted', formatUnits(uq, 6));
console.log('SDK TEST PASSED');
