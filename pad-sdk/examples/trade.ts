// Quote, buy and sell one token with ETH. PRIVATE_KEY=0x... TOKEN=0x... npx tsx examples/trade.ts
import { createWalletClient, formatEther, formatUnits, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createPad, chain, ADDRESSES } from '../src/index.js';

const pad = createPad();
const token = process.env.TOKEN as `0x${string}`;
const wallet = createWalletClient({ account: privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`), chain, transport: http(ADDRESSES.rpcUrl) });

console.log('price (USDG):', await pad.price(token));
const q = await pad.quoteBuyWithEth(token, parseEther('0.01'));
console.log(`0.01 ETH -> ${formatUnits(q.out, 18)} tokens`);
console.log('buy :', await pad.buyWithEth(wallet, token, parseEther('0.01'), { slippageBps: 100 }));
const bal = await pad.publicClient.readContract({ address: token, abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }], functionName: 'balanceOf', args: [wallet.account.address] });
const s = await pad.quoteSellForEth(token, bal);
console.log(`selling ${formatUnits(bal, 18)} -> ${formatEther(s.out)} ETH`);
console.log('sell:', await pad.sellForEth(wallet, token, bal, { slippageBps: 100 }));
