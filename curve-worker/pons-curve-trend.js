#!/usr/bin/env node
/**
 * Pons V2 curve buyer (Robinhood Chain, 4663). Buys straight from the token's bonding curve:
 *   curve.buy(quoteIn, minTokensOut, recipient) payable      (quote is native ETH on this launch)
 * Each burst funds 5-10 FRESH wallets from the master; each makes one buy, burns what it bought to
 * 0xdEaD, and sweeps its leftover ETH back to the master. Every fresh wallet is written to the ledger
 * BEFORE it is funded, so --recover can always find it.
 *
 * The curve is looked up from the Pons factory (getLaunchedToken). The script stops itself when the
 * launch graduates (phase != 0): after that the token trades on Uniswap v4 and this script does not trade it.
 *
 *   node scripts/pons-curve-trend.js --init        create the master wallet, print its ADDRESS only
 *   node scripts/pons-curve-trend.js --dry-run     show the plan and simulate one buy, send nothing
 *   node scripts/pons-curve-trend.js --audit       read-only: wallets it made that still hold the token or ETH
 *   node scripts/pons-curve-trend.js --recover     burn leftover token and sweep leftover ETH from every wallet it made
 *   node scripts/pons-curve-trend.js               run
 *
 * Flags: --token 0x..  --eth-per-hour 0.01  --buy-min 0.001  --buy-max 0.01  --burst-min 5  --burst-max 10  --no-burn
 * Master key: data/pons-master.key (chmod 600, gitignored). Fresh wallets: data/pons-wallets.json (chmod 600, gitignored).
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

try { require('dotenv').config(); } catch { /* dotenv optional */ }

const DATA_DIR = process.env.PONS_DATA_DIR || path.join(__dirname, '..', 'data');
const KEY_FILE = path.join(DATA_DIR, 'pons-master.key');
const LEDGER = path.join(DATA_DIR, 'pons-wallets.json');
const CHAIN_ID = 4663;
const DEAD = '0x000000000000000000000000000000000000dEaD';
const FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';   // Pons V2 launch factory (docs.ponsfamily.com/v2)
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
// Plain transfers: the chain's estimate is 21,000, but funding sends failed with 'intrinsic gas too low' at that limit,
// so transfers get 35,000. Unused gas is refunded, so this only raises the reserve, not the cost.
const BUY_GAS = 260000n, BURN_GAS = 90000n, SWEEP_GAS = 35000n, TRANSFER_GAS = 35000n;
const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const PHASES = ['NotGraduated', 'Swept', 'PoolCreated', 'Rescued'];

// Public node first. Alchemy is the backup, taken from the server's own .env (never printed).
const RPCS = (process.env.PONS_RPC_URLS || 'https://rpc.mainnet.chain.robinhood.com').split(',').map(s => s.trim()).filter(Boolean);
if (!process.env.PONS_RPC_URLS) {
  const m = `${process.env.ARC_RPC_FALLBACK || ''} ${process.env.RPC_URL || ''} ${process.env.RPC_FALLBACK_URLS || ''} ${process.env.MONAD_RPC_URLS || ''}`.match(/g\.alchemy\.com\/v2\/([A-Za-z0-9_-]+)/);
  if (m) RPCS.push(`https://robinhood-mainnet.g.alchemy.com/v2/${m[1]}`);
}

const FACTORY_IFACE = new ethers.Interface(['function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))']);
const CURVE_IFACE = new ethers.Interface(['function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)']);
const ERC20_IFACE = new ethers.Interface(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const MC_ABI = ['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])'];

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i === -1 || i === argv.length - 1 ? d : argv[i + 1]; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const logUniform = (lo, hi) => Math.exp(rand(Math.log(lo), Math.log(hi)));
const fmt = (w, d = 5) => Number(ethers.formatEther(w)).toFixed(d);
const errText = e => String(e?.error?.message || e?.info?.error?.message || e?.shortMessage || e?.message || e).replace(/\s+/g, ' ').slice(0, 160);

function buildProvider() {
  const ps = RPCS.map((u, i) => ({ provider: new ethers.JsonRpcProvider(u, CHAIN_ID, { staticNetwork: true }), priority: i + 1, weight: 1, stallTimeout: 2500 }));
  return ps.length === 1 ? ps[0].provider : new ethers.FallbackProvider(ps, CHAIN_ID, { quorum: 1 });
}
async function withRetry(fn, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) { try { return await fn(); } catch (e) { last = e; await sleep(400 * (i + 1) + Math.random() * 300); } }
  throw last;
}
async function waitReceipt(provider, hash, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const rc = await provider.getTransactionReceipt(hash); if (rc) return rc; } catch { /* keep polling */ }
    await sleep(1000 + Math.random() * 500);
  }
  throw new Error(`no receipt for ${hash} after ${ms / 1000}s`);
}

function loadMasterKey() {
  if (process.env.PONS_MASTER_KEY) return process.env.PONS_MASTER_KEY.trim();
  return fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf8').trim() : null;
}
function initMaster() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(KEY_FILE)) return new ethers.Wallet(fs.readFileSync(KEY_FILE, 'utf8').trim());
  const w = ethers.Wallet.createRandom();
  fs.writeFileSync(KEY_FILE, w.privateKey + '\n', { mode: 0o600 });
  return w;
}
function readLedger() { return fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, 'utf8')) : []; }
function appendLedger(ws) {
  const all = readLedger().concat(ws.map(w => ({ address: w.address, privateKey: w.privateKey, at: new Date().toISOString() })));
  const tmp = LEDGER + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, LEDGER);
}

async function feeData(provider) {
  const fd = await withRetry(() => provider.getFeeData());
  const maxFeePerGas = (fd.maxFeePerGas ?? fd.gasPrice) * 12n / 10n;
  return { maxFeePerGas, maxPriorityFeePerGas: fd.maxPriorityFeePerGas ?? 0n };
}

// Read the launch from the factory. Refuses anything that is not a live native-ETH curve.
async function resolveLaunch(provider, token) {
  const r = FACTORY_IFACE.decodeFunctionResult('getLaunchedToken', await withRetry(() => provider.call({ to: FACTORY, data: FACTORY_IFACE.encodeFunctionData('getLaunchedToken', [token]) })))[0];
  if (!r.exists) throw new Error(`${token} is not a Pons V2 launch on this chain`);
  if (r.pairToken !== ethers.ZeroAddress) throw new Error(`this launch is quoted in ${r.pairToken}, not native ETH; this script only buys ETH-quoted curves`);
  return { curve: r.curve, phase: Number(r.phase), graduationThreshold: r.graduationThreshold, creatorTaxBps: Number(r.creatorTaxBps) };
}

// Sweep everything above the cost of the sweep itself back to `to`.
async function sweepTo(provider, wallet, to, fees) {
  const bal = await withRetry(() => provider.getBalance(wallet.address));
  const amount = bal - SWEEP_GAS * fees.maxFeePerGas;
  if (amount < ethers.parseEther('0.00001')) return 0n;
  const tx = await withRetry(() => wallet.sendTransaction({ to, value: amount, gasLimit: SWEEP_GAS, ...fees }), 3);
  const rc = await waitReceipt(provider, tx.hash);
  return rc.status === 1 ? amount : 0n;
}

// Burn whatever token the wallet holds (by balance, so a lost receipt cannot leave a holder behind).
async function burnAll(provider, wallet, token, fees) {
  const bal = BigInt(await withRetry(() => provider.call({ to: token, data: ERC20_IFACE.encodeFunctionData('balanceOf', [wallet.address]) }), 6));
  if (bal === 0n) return 0n;
  const t = await withRetry(() => wallet.sendTransaction({ to: token, data: ERC20_IFACE.encodeFunctionData('transfer', [DEAD, bal]), gasLimit: BURN_GAS, ...fees }), 4);
  await waitReceipt(provider, t.hash);
  return bal;
}

// One maker: buy from the curve, burn what it bought, sweep the rest of its ETH to the master.
async function makerRun(provider, w, buyWei, token, curve, burn, masterAddr, fees, setStep) {
  const wallet = new ethers.Wallet(w.privateKey, provider);
  setStep('wait-funded');
  const needBal = buyWei + BUY_GAS * fees.maxFeePerGas;
  for (let i = 0; i < 40; i++) {
    if ((await withRetry(() => provider.getBalance(wallet.address, 'latest'), 4)) >= needBal) break;
    await sleep(750);
  }
  // Burn mode: the curve sends the tokens straight to the dead address, so no wallet ever holds or receives them
  // (nothing for an indexer to count as a holder) and no separate burn transaction is needed.
  const recipient = burn ? DEAD : wallet.address;
  setStep('simulate');
  // The curve has no quote function. Simulate the buy from this wallet now and accept 90% of the answer.
  const sim = await withRetry(() => provider.call({ from: wallet.address, to: curve, value: buyWei, data: CURVE_IFACE.encodeFunctionData('buy', [buyWei, 0n, recipient]) }), 3);
  const expected = CURVE_IFACE.decodeFunctionResult('buy', sim)[0];
  const minOut = (expected * 90n) / 100n;
  setStep('buy-send');
  const nonce = await withRetry(() => provider.getTransactionCount(wallet.address, 'pending'), 8);
  const buy = await withRetry(() => wallet.sendTransaction({ to: curve, value: buyWei, data: CURVE_IFACE.encodeFunctionData('buy', [buyWei, minOut, recipient]), gasLimit: BUY_GAS, nonce, ...fees }), 8);
  setStep('buy-confirm');
  const rc = await waitReceipt(provider, buy.hash);
  if (rc.status !== 1) throw new Error('buy reverted');
  let bought = 0n;
  const pad = ethers.zeroPadValue(wallet.address, 32).toLowerCase();
  for (const l of rc.logs) if (l.address.toLowerCase() === token.toLowerCase() && l.topics[0] === TRANSFER && l.topics[2]?.toLowerCase() === pad) bought += BigInt(l.data);
  setStep('burn');
  if (burn && bought > 0n) {
    try { await burnAll(provider, wallet, token, fees); } catch (e) { console.log(`  ⚠ burn failed ${wallet.address.slice(0, 10)}: ${errText(e)}`); }
  }
  setStep('sweep');
  let swept = 0n;
  try { swept = await sweepTo(provider, wallet, masterAddr, fees); } catch (e) { console.log(`  ⚠ sweep failed ${wallet.address.slice(0, 10)}: ${errText(e)}`); }
  return { bought, swept };
}

// Cleanup after a burst: a wallet whose buy or burn failed may still hold the token or ETH.
async function cleanupWallet(provider, w, token, burn, masterAddr, fees) {
  const wallet = new ethers.Wallet(w.privateKey, provider);
  if (burn) await burnAll(provider, wallet, token, fees);
  return withRetry(() => sweepTo(provider, wallet, masterAddr, fees), 4);
}

// Before each burst, look at the most recent wallets in one multicall and burn any token still held.
async function burnStragglers(provider, token, burn, masterAddr, fees) {
  if (!burn) return;
  const recent = readLedger().slice(-120);
  if (!recent.length) return;
  const mc = new ethers.Contract(MULTICALL3, MC_ABI, provider);
  const res = await withRetry(() => mc.aggregate3(recent.map(w => ({ target: token, allowFailure: true, callData: ERC20_IFACE.encodeFunctionData('balanceOf', [w.address]) }))), 4);
  const holders = recent.filter((w, i) => res[i].success && BigInt(res[i].returnData) > 0n);
  for (const w of holders) {
    try { await cleanupWallet(provider, w, token, true, masterAddr, fees); console.log(`  🔥 burned leftover token in ${w.address.slice(0, 10)}`); }
    catch (e) { console.log(`  ⚠ leftover in ${w.address.slice(0, 10)} not burned yet (${errText(e)}), retrying next burst`); }
  }
}

async function main() {
  const token = ethers.getAddress(val('--token', '0x67ef4460a1280fbd9d31d6312fed2ce1efd66305'));
  const ethPerHour = parseFloat(val('--eth-per-hour', '0.01'));
  const buyMin = parseFloat(val('--buy-min', '0.00001')), buyMax = parseFloat(val('--buy-max', '0.0001'));
  const burstMin = parseInt(val('--burst-min', '5'), 10), burstMax = parseInt(val('--burst-max', '10'), 10);
  const burn = !has('--no-burn');

  if (has('--init')) {
    const m = initMaster();
    console.log(`Master wallet: ${m.address}\nSend ETH (Robinhood Chain, 4663) to this address. Key is in ${KEY_FILE} (chmod 600, not in git).`);
    return;
  }
  const key = loadMasterKey();
  if (!key) { const m = initMaster(); console.log(`No master yet - created one.\nSend ETH on Robinhood Chain to: ${m.address}\nThen start again.`); return; }

  const provider = buildProvider();
  const master = new ethers.Wallet(key, provider);
  const net = await withRetry(() => provider.getNetwork());
  if (net.chainId !== BigInt(CHAIN_ID)) throw new Error(`wrong chain ${net.chainId}, expected ${CHAIN_ID} (Robinhood)`);
  const launch = await resolveLaunch(provider, token);
  const phase = PHASES[launch.phase] ?? launch.phase;

  if (has('--audit')) {
    const ws = readLedger();
    const mc = new ethers.Contract(MULTICALL3, MC_ABI, provider);
    let holders = 0, withEth = 0, ethTotal = 0n, tokTotal = 0n;
    for (let i = 0; i < ws.length; i += 100) {
      const chunk = ws.slice(i, i + 100);
      const res = await withRetry(() => mc.aggregate3(chunk.map(w => ({ target: token, allowFailure: true, callData: ERC20_IFACE.encodeFunctionData('balanceOf', [w.address]) }))), 6);
      const eth = await Promise.all(chunk.map(w => withRetry(() => provider.getBalance(w.address), 6)));
      res.forEach((r, j) => {
        const t = r.success ? BigInt(r.returnData) : 0n;
        if (t > 0n) { holders++; tokTotal += t; }
        if (eth[j] >= ethers.parseEther('0.00001')) { withEth++; ethTotal += eth[j]; }
      });
    }
    console.log(`${ws.length} wallets created so far`);
    console.log(`  still holding the token (counts as a holder): ${holders}  (${ethers.formatEther(tokTotal)})`);
    console.log(`  still holding ETH: ${withEth}  (${fmt(ethTotal, 6)} ETH)`);
    if (holders || withEth) console.log('  fix: node scripts/pons-curve-trend.js --recover');
    return;
  }

  if (has('--recover')) {
    const fees = await feeData(provider);
    const ws = readLedger();
    let total = 0n, fail = 0;
    for (let i = 0; i < ws.length; i += 3) {
      const res = await Promise.allSettled(ws.slice(i, i + 3).map(w => cleanupWallet(provider, w, token, true, master.address, fees)));
      for (const r of res) { if (r.status === 'fulfilled') total += r.value; else fail++; }
      if ((i / 3) % 20 === 19) console.log(`  ${Math.min(i + 3, ws.length)}/${ws.length} wallets checked`);
    }
    console.log(`recovered ${fmt(total, 6)} ETH from ${ws.length} wallets -> ${master.address}` + (fail ? `  (${fail} wallets failed, run again)` : ''));
    return;
  }

  const fees = await feeData(provider);
  const gasEach = (BUY_GAS + (burn ? BURN_GAS : 0n) + SWEEP_GAS) * fees.maxFeePerGas;
  const avgBuy = (buyMin + buyMax) / 2;
  const gasEachEth = Number(ethers.formatEther(gasEach));
  const makersPerHour = ethPerHour / (avgBuy + gasEachEth);
  const avgBurst = (burstMin + burstMax) / 2;
  const burstsPerHour = makersPerHour / avgBurst;
  const capWei = ethers.parseEther((ethPerHour * 1.3).toFixed(6));

  console.log(`\n🔄 PONS V2 CURVE LANE (Robinhood ${CHAIN_ID}) token ${token}`);
  console.log(`   phase ${phase}, curve ${launch.curve}, creator tax ${launch.creatorTaxBps / 100}%`);
  console.log(`   graduates at ${ethers.formatEther(launch.graduationThreshold)} ETH raised`);
  console.log(`   rpc: ${RPCS.map(u => new URL(u).host).join(' -> ')}`);
  console.log(`   master ${master.address}  balance ${fmt(await provider.getBalance(master.address), 5)} ETH`);
  console.log(`   ${ethPerHour} ETH/hr -> ~${makersPerHour.toFixed(0)} makers/hr in ~${burstsPerHour.toFixed(0)} bursts of ${burstMin}-${burstMax}, buy ${buyMin}-${buyMax} ETH each, ${burn ? 'BURN after buy' : 'HOLD (no burn)'}`);
  console.log(`   gas/maker ~${gasEachEth.toFixed(7)} ETH (gas ${ethers.formatUnits(fees.maxFeePerGas, 'gwei')} gwei max), hard cap ${(ethPerHour * 1.3).toFixed(4)} ETH/hr\n`);

  if (has('--dry-run')) {
    const from = '0x1111111111111111111111111111111111111111', value = ethers.parseEther('0.005');
    try {
      const r = await provider.send('eth_call', [{ from, to: launch.curve, value: ethers.toQuantity(value), data: CURVE_IFACE.encodeFunctionData('buy', [value, 0n, from]) }, 'latest', { [from]: { balance: '0x56bc75e2d63100000' } }]);
      console.log(`   simulated buy: 0.005 ETH -> ${ethers.formatUnits(BigInt(r.slice(0, 66)), 18)} token ✅`);
    } catch (e) { console.log(`   simulated buy FAILED: ${errText(e)}`); }
    return;
  }
  if (launch.phase !== 0) { console.log(`Launch is in phase ${phase}, not trading on the curve. Nothing to do.`); return; }

  let running = true, done = 0, burstNo = 0, empty = 0;
  let windowStart = Date.now(), windowSpent = 0n;
  process.on('SIGINT', () => { console.log('\n🛑 stopping after this burst'); running = false; });
  process.on('SIGTERM', () => { running = false; });

  while (running) {
    const size = randInt(burstMin, burstMax);
    const buys = Array.from({ length: size }, () => ethers.parseEther(logUniform(buyMin, buyMax).toFixed(6)));
    const f = await feeData(provider);
    const gasEachNow = (BUY_GAS + BURN_GAS + SWEEP_GAS) * f.maxFeePerGas;
    const fundEach = buys.map(b => b + gasEachNow + gasEachNow / 5n);
    const need = fundEach.reduce((a, b) => a + b, 0n) + ethers.parseEther('0.00005');

    // Graduation check before every burst: once it is on Uniswap v4 this curve bot stops.
    const now = await resolveLaunch(provider, token);
    if (now.phase !== 0) { console.log(`🎓 launch is now ${PHASES[now.phase] ?? now.phase}: it left the curve. Stopping this bot.`); break; }

    if (Date.now() - windowStart > 3600_000) { windowStart = Date.now(); windowSpent = 0n; }
    if (windowSpent + need > capWei) {
      const wait = windowStart + 3600_000 - Date.now();
      console.log(`⏸ hourly cap ${(ethPerHour * 1.3).toFixed(4)} ETH reached, waiting ${Math.ceil(wait / 60000)} min`);
      await sleep(Math.max(wait, 5000)); continue;
    }
    for (let warned = false; running;) {
      const mb = await withRetry(() => provider.getBalance(master.address));
      if (mb >= need) break;
      if (!warned) { console.log(`⏸ master low: ${fmt(mb, 5)} ETH, burst needs ${fmt(need, 5)} - send ETH (Robinhood) to ${master.address}; checking every 60s`); warned = true; }
      await sleep(60000);
    }
    if (!running) break;

    try { await burnStragglers(provider, token, burn, master.address, f); } catch (e) { console.log(`  ⚠ straggler check skipped: ${errText(e)}`); }

    const wallets = Array.from({ length: size }, () => ethers.Wallet.createRandom());
    appendLedger(wallets);                     // recorded BEFORE funding
    const before = await withRetry(() => provider.getBalance(master.address));
    try {
      let nonce = await withRetry(() => provider.getTransactionCount(master.address, 'pending'), 6);
      const sent = [];
      for (let i = 0; i < size; i++) sent.push(await withRetry(() => master.sendTransaction({ to: wallets[i].address, value: fundEach[i], gasLimit: TRANSFER_GAS, nonce: nonce++, ...f }), 3));
      await Promise.all(sent.map(t => waitReceipt(provider, t.hash)));
    } catch (e) { console.error(`❌ funding failed: ${errText(e)} (wallets are in the ledger; run --recover)`); process.exit(1); }

    burstNo++;
    const results = [];
    await Promise.all(wallets.map(async (w, i) => {
      await sleep(i === 0 ? 0 : Math.random() * 3000);
      let step = 'start';
      try { results[i] = { ok: true, ...(await makerRun(provider, w, buys[i], token, launch.curve, burn, master.address, f, s => { step = s; })) }; }
      catch (e) { results[i] = { ok: false, error: `${step}: ${errText(e)}` }; }
    }));
    let ok = 0, swept = 0n, spent = 0n;
    results.forEach((r, i) => {
      if (r.ok) { ok++; done++; swept += r.swept; }
      else console.log(`  ✗ ${wallets[i].address.slice(0, 10)} ${r.error}`);
    });
    // second pass: anything an RPC error left behind (token or ETH)
    for (let i = 0; i < wallets.length; i += 3) {
      const res = await Promise.allSettled(wallets.slice(i, i + 3).map(w => cleanupWallet(provider, w, token, burn, master.address, f)));
      for (const r of res) if (r.status === 'fulfilled') swept += r.value;
    }
    const after = await withRetry(() => provider.getBalance(master.address));
    spent = before > after ? before - after : 0n;
    windowSpent += spent;
    console.log(`💥 burst #${burstNo}: ${ok}/${size} buys landed (${done} total), swept back ${fmt(swept, 5)} ETH, master ${fmt(after, 5)} ETH`);

    if (ok === 0) { if (++empty >= 3) { console.error('3 bursts in a row with zero buys - exiting (run --recover to pull stranded ETH back)'); process.exit(1); } }
    else empty = 0;
    if (running) {
      const meanMs = 3600_000 / burstsPerHour;
      // --steady: an even cadence (0.6x-1.4x of the mean gap) so a buy shows up regularly, instead of random long gaps.
      const gap = has('--steady') ? meanMs * (0.6 + 0.8 * Math.random()) : -Math.log(Math.random()) * meanMs;
      await sleep(Math.max(2000, gap));
    }
  }
  console.log(`\n📊 ${done} makers this run`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
