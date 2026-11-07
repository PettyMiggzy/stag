// $STAG burn counter. A "burn" is $STAG sent to the dead address 0x…dEaD, which nobody can ever move again.
// Every burn transfer is read from chain logs and kept in the database, so totals and daily numbers are exact and survive restarts.
// The daily post is OFF until bot_state.burnPostOn = '1' (use /burnpost on in the bot DM after approving a draft with /burndraft).
export function initBurn(X) {
  const { provider, ethers, CFG, q, log, fmt, usd, tgPost, chat, market, stGet, stSet, adminTg } = X;
  const DEAD = "0x000000000000000000000000000000000000dEaD";
  const TRANSFER = ethers.id("Transfer(address,address,uint256)");
  const DEAD_T = ethers.zeroPadValue(DEAD, 32);
  const FIRST_BLOCK = parseInt(process.env.BURN_FROM_BLOCK || "100000000", 10);
  const STEP = 99999; // this chain's RPC allows 100,000 blocks per log query
  const POST_HOUR = parseInt(process.env.BURN_POST_HOUR_UTC || "15", 10); // 15:00 UTC = 10:00 Central
  let supply = 1_000_000_000, busy = false, ready = false;
  const tsCache = new Map();

  async function ensureTable() {
    await q("create table if not exists burn_events(tx text not null, li int not null, block bigint not null, ts timestamptz not null, amount double precision not null, burner text, primary key(tx, li))");
  }
  async function blockTs(n) { if (tsCache.has(n)) return tsCache.get(n); const b = await provider.getBlock(n); tsCache.set(n, b.timestamp); if (tsCache.size > 500) tsCache.delete(tsCache.keys().next().value); return b.timestamp; }
  async function sync() { // pick up every new burn since the last scan
    if (busy) return; busy = true;
    try {
      await ensureTable();
      const head = await provider.getBlockNumber(); let from = parseInt((await stGet("burnScanned")) || String(FIRST_BLOCK), 10) + 1; let added = 0;
      try { supply = Number(ethers.formatUnits(await new ethers.Contract(CFG.token, ["function totalSupply() view returns (uint256)"], provider).totalSupply(), 18)) || supply; } catch {}
      while (from <= head) {
        const to = Math.min(from + STEP, head);
        const logs = await provider.getLogs({ address: CFG.token, topics: [TRANSFER, null, DEAD_T], fromBlock: from, toBlock: to });
        for (const l of logs) {
          const ts = await blockTs(l.blockNumber);
          await q("insert into burn_events(tx, li, block, ts, amount, burner) values ($1,$2,$3,to_timestamp($4),$5,$6) on conflict do nothing", [l.transactionHash, l.index, l.blockNumber, ts, Number(ethers.formatUnits(l.data, 18)), "0x" + l.topics[1].slice(-40)]); added++;
        }
        await stSet("burnScanned", to); from = to + 1;
      }
      ready = true; if (added) log("burn: +", added, "burn transfers");
    } catch (e) { log("burn sync err:", e.shortMessage || e.message); } finally { busy = false; }
  }
  async function numbers() {
    const [t] = await q("select coalesce(sum(amount),0) as total, count(*)::int as n from burn_events");
    const [d] = await q("select coalesce(sum(amount),0) as amt, count(*)::int as n from burn_events where ts > now() - interval '24 hours'");
    const [u] = await q("select coalesce(sum(amount),0) as amt from burn_events where ts >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'");
    const [f] = await q("select min(ts) as first from burn_events");
    let price = 0; try { price = (await market()).priceUsd || 0; } catch {}
    return { total: Number(t.total), burns: t.n, day: Number(d.amt), dayBurns: d.n, today: Number(u.amt), first: f.first, price };
  }
  const pct = (n) => (n / supply) * 100;
  const bar = (p, n = 12) => { const f = Math.max(0, Math.min(n, Math.ceil((p / 5) * n))); return "▰".repeat(f) + "▱".repeat(n - f); }; // scale: 5% of supply fills the bar
  async function text(daily = false) {
    const n = await numbers();
    if (!ready && !n.total) return "🔥 Burn counter is still reading the chain. Try again in a minute.";
    const lines = [
      daily ? "🔥 <b>DAILY BURN REPORT</b>" : "🔥 <b>$STAG BURNED</b>",
      "",
      `Last 24h: <b>${fmt(n.day, 0)}</b> $STAG${n.price ? ` (~${usd(n.day * n.price)})` : ""} · ${n.dayBurns} burn${n.dayBurns === 1 ? "" : "s"}`,
      `Total burned: <b>${fmt(n.total, 0)}</b> $STAG${n.price ? ` (~${usd(n.total * n.price)})` : ""}`,
      `${bar(pct(n.total))} <b>${fmt(pct(n.total), 3)}%</b> of ${fmt(supply, 0)} supply`,
      "",
      `<i>Sent to the dead address, gone forever. <a href="${CFG.explorer}/address/${DEAD}">Verify on the explorer</a>.</i>`,
    ];
    return lines.join("\n");
  }
  async function dailyPost() { // once a day at POST_HOUR UTC, only when switched on
    try {
      if ((await stGet("burnPostOn")) !== "1" || !chat) return; const now = new Date(); if (now.getUTCHours() < POST_HOUR) return;
      const day = now.toISOString().slice(0, 10); if ((await stGet("burnPostDay")) === day) return; await stSet("burnPostDay", day);
      await sync(); const r = await tgPost("sendMessage", { chat_id: chat, text: await text(true), parse_mode: "HTML", disable_web_page_preview: true });
      if (r.ok) log("burn: daily post sent"); else log("burn post err:", r.description);
    } catch (e) { log("burn post err:", e.message); }
  }
  function start() { setTimeout(sync, 45000); setInterval(sync, 10 * 60000); setInterval(dailyPost, 5 * 60000); setTimeout(dailyPost, 180000); }
  return { start, text, sync, numbers };
}
