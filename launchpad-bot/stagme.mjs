// /stagme: a personal $STAG avatar picture. Costs a few cents per image, so it is rate limited:
// one picture per person per day, and a daily cap for the whole group (STAGME_DAILY_CAP, default 30).
// Players can type any outfit or vibe (or use a shortcut word). Text is cleaned and checked first, the stag look is locked in by the server, and Venice safe mode stays on. Always clothed.
// Needs VENICE_API_KEY in the environment; without it the command says it is not switched on yet.
const STYLES = {
  royal: "wearing a heavy gold crown and a dark red fur-trimmed cloak over ornate gold armor, holding a gold scepter, regal and dominant",
  hooded: "wearing a dark forest-green hood pulled low and golden leaf-patterned shoulder armor, drawing a glowing golden bow",
  dj: "wearing a dark hood and huge black and gold over-ear headphones, hands on a glowing DJ deck, neon club lights",
  boss: "wearing a sharp black suit with a gold stag-head chain, arms crossed, gold-ringed fingers, penthouse city lights behind",
  archer: "wearing dark leather ranger armor with gold trim and a hood, a glowing arrow nocked on a golden bow",
  rapper: "wearing a black hood pulled up and a heavy gold stag pendant chain, a gold grill showing, holding a studio microphone",
};
const MODEL = process.env.STAGME_MODEL || "flux-2-pro";
const CAP = parseInt(process.env.STAGME_DAILY_CAP || "30", 10);
const day = () => new Date().toISOString().slice(0, 10);
const LOCK = "A powerful muscular anthropomorphic stag warrior with realistic dark brown fur, huge branching antlers, glowing neon green eyes and an intense stern expression, bust portrait, glowing green trading candlestick charts and a dark neon city skyline in the background, dramatic cinematic lighting, highly detailed fantasy digital painting, no text, fully clothed, family friendly";

export function initStagme(X) {
  const { q, log, tgFile, adminTg } = X;
  let ready = false;
  async function table() { if (ready) return; await q("create table if not exists stagme_log(tg_id text not null, day text not null, n int not null default 0, primary key(tg_id, day))"); ready = true; }
  async function counts(id) {
    await table();
    const [u] = await q("select coalesce(sum(n),0)::int as n from stagme_log where tg_id=$1 and day=$2", [String(id), day()]);
    const [g] = await q("select coalesce(sum(n),0)::int as n from stagme_log where day=$1", [day()]);
    return { user: u.n, all: g.n };
  }
  async function bump(id) { await q("insert into stagme_log(tg_id, day, n) values ($1,$2,1) on conflict(tg_id, day) do update set n = stagme_log.n + 1", [String(id), day()]); }

  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const BLOCK = /\b(nude|naked|nsfw|porn\w*|sex\w*|topless|lingerie|erotic|fetish|genital\w*|boob\w*|breast\w*|nipple\w*|dick|cock|pussy|penis|vagina|anal|rape\w*|gore|bloody|beheaded|dismember\w*|suicide|nazi\w*|hitler|swastika|kkk|isis|terroris\w*|child\w*|kids?|minor|loli\w*|underage|teen\w*|n[i1]gg\w*|f[a4]gg?\w*|retard\w*|trump|biden|obama|putin|elon|musk|kamala|harris|zelensky|jesus|allah|muhammad|ignore|system prompt|instructions?)\b/i;
  const clean = (t) => String(t).replace(/https?:\/\/\S+|www\.\S+|@\w+/gi, " ").replace(/[^\p{L}\p{N} ,.'&+-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 140);

  async function command(msg, args, reply) {
    const key = process.env.VENICE_API_KEY;
    if (!key) return reply("🎨 /stagme isn't switched on yet. Soon.");
    const names = Object.keys(STYLES);
    const raw = args.join(" ").trim();
    if (!raw) return reply("🎨 <b>Make your stag</b>\nType any outfit or vibe, for example:\n<code>/stagme gold suit holding a glowing sword</code>\n<code>/stagme biker jacket, sunglasses, smoking a cigar</code>\nOr use a shortcut: " + names.map((n) => "<code>/stagme " + n + "</code>").join(" · ") + "\nOne picture per person per day. Keep it clean.");
    const preset = args.length === 1 && STYLES[raw.toLowerCase()] ? raw.toLowerCase() : "";
    const text = preset ? "" : clean(raw);
    if (!preset && (text.length < 3 || BLOCK.test(text) || BLOCK.test(raw))) return reply("I can't draw that one. Keep it clean and don't use real people's names. Try another outfit or vibe. (This didn't use up your picture.)");
    const id = msg.from.id, admin = String(id) === String(adminTg);
    const c = await counts(id);
    if (!admin && c.user >= 1) return reply("You already made today's stag. Come back tomorrow. 🦌");
    if (c.all >= CAP) return reply("Today's stag picture budget is used up. Back tomorrow. 🦌");
    await bump(id); // count it before the call so spamming can't run up the bill
    const seed = Math.floor(Math.random() * 1e9);
    const desc = preset ? STYLES[preset] : `outfit and vibe: ${text}`;
    const label = preset || text.slice(0, 48);
    const prompt = `${LOCK}, ${desc}. An original character, not a real person or celebrity, no text, no logos.`;
    try {
      const r = await fetch("https://api.venice.ai/api/v1/image/generate", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, prompt, width: 896, height: 1152, format: "png", safe_mode: true, return_binary: false, seed }), signal: AbortSignal.timeout(120000) });
      const j = await r.json(); if (!j.images || !j.images[0]) throw new Error(j.error || j.message || "no image");
      const png = Buffer.from(j.images[0], "base64");
      const name = esc((msg.from.first_name || "Your").slice(0, 24));
      const res = await tgFile("sendPhoto", { chat_id: String(msg.chat.id), caption: `🦌 ${name}'s stag: <b>${esc(label)}</b>\nCome hang in the lounge: https://stagwifhood.fun/lounge/`, parse_mode: "HTML", reply_to_message_id: String(msg.message_id) }, "photo", png, "stag.png");
      if (!res.ok) throw new Error(res.description || "send failed");
    } catch (e) { log("stagme err:", e.message); return reply("The artist stumbled. Try again in a minute. (This one didn't count against you.)").then(async () => { try { await q("update stagme_log set n = greatest(n-1,0) where tg_id=$1 and day=$2", [String(id), day()]); } catch {} }); }
  }
  return { command, styles: () => Object.keys(STYLES) };
}
