// Keeps the Pons curve buyer running 24/7 and serves a small status page.
// The buyer itself is pons-curve-trend.js; this only supervises it and restarts it if it stops.
// Secrets come from env (PONS_MASTER_KEY, PONS_RPC_URLS). Nothing secret is printed or served.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 3000);
const DATA = process.env.PONS_DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

// $1/hour at ETH ~ $2,315 is about 0.00043 ETH/hour. Buys are split into small bursts.
const ARGS = ['--token', '0x67ef4460a1280fbd9d31d6312fed2ce1efd66305',
  '--eth-per-hour', '0.00043', '--buy-min', '0.00002', '--buy-max', '0.0001',
  '--burst-min', '5', '--burst-max', '10'];

const state = { started: new Date().toISOString(), restarts: 0, running: false, lastLine: '', lastExit: null };
let child = null, backoff = 5000;

function run() {
  state.running = true;
  child = spawn(process.execPath, [path.join(__dirname, 'pons-curve-trend.js'), ...ARGS], {
    cwd: __dirname, env: { ...process.env, PONS_DATA_DIR: DATA }
  });
  const onLine = d => d.toString().split('\n').filter(Boolean).forEach(l => {
    state.lastLine = l.replace(/0x[0-9a-fA-F]{64}/g, '[redacted]').slice(0, 300);
    console.log(l);
  });
  child.stdout.on('data', onLine);
  child.stderr.on('data', onLine);
  child.on('exit', (code, signal) => {
    state.running = false; state.lastExit = { code, signal, at: new Date().toISOString() };
    state.restarts++;
    console.log(`buyer exited (code ${code}, signal ${signal}); restarting in ${backoff / 1000}s`);
    setTimeout(run, backoff);
    backoff = Math.min(backoff * 2, 5 * 60 * 1000);
  });
  setTimeout(() => { if (state.running) backoff = 5000; }, 60000);
}

http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true, ...state }, null, 2));
}).listen(PORT, () => console.log(`status on :${PORT}`));

process.on('SIGTERM', () => { if (child) child.kill('SIGINT'); setTimeout(() => process.exit(0), 15000); });
run();
