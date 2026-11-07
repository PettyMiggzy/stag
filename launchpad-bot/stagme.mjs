// /stagme: a personal $STAG avatar picture. Costs a few cents per image, so it is rate limited:
// one picture per person per day, and a daily cap for the whole group (STAGME_DAILY_CAP, default 30).
// Players pick a preset style (no free text), so nothing offensive can be asked for. Always clothed, safe mode on.
// Needs VENICE_API_KEY in the environment; without it the command says it is not switched on yet.
const STYLES = {
  royal: "wearing a gold crown and a deep red velvet cape with gold trim, regal pose",
  hooded: "wearing a forest-green Robin Hood hood with a tiny gold feather, holding a golden bow",
  dj: "wearing black and gold over-ear DJ headphones and a black bomber jacket, neon club lights behind",
  boss: "wearing a sharp black suit with a gold chain and gold-rimmed sunglasses, penthouse city skyline behind",
  archer: "wearing dark leather archer armor with gold details, holding a glowing bow in a moonlit forest",
  rapper: "wearing a black hoodie with a heavy gold chain and a gold grill smile, studio microphone in front",
};
const MODEL = process.env.STAGME_MODEL || "flux-2-pro";
const CAP = parseInt(process.env.STAGME_DAILY_CAP || "30", 10);
const day = () => new Date().toISOString().slice(0, 10);
const LOCK = "A majestic anthropomorphic stag with a deer head and large branching antlers, stylized painterly 3D storybook look, gold and green palette, golden-hour lighting, waist-up portrait, centered, high detail, family friendly, fully clothed";

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

  async function command(msg, args, reply) {
    const key = process.env.VENICE_API_KEY;
    if (!key) return reply("🎨 /stagme isn't switched on yet. Soon.");
    const names = Object.keys(STYLES);
    let style = (args[0] || "").toLowerCase();
    if (!style) return reply("🎨 <b>Make your stag</b>\nPick a style: " + names.map((n) => "<code>/stagme " + n + "</code>").join(" · ") + "\nOne picture per person per day.");
    if (!STYLES[style]) return reply("Pick one of: " + names.join(", "));
    const id = msg.from.id, admin = String(id) === String(adminTg);
    const c = await counts(id);
    if (!admin && c.user >= 1) return reply("You already made today's stag. Come back tomorrow. 🦌");
    if (c.all >= CAP) return reply("Today's stag picture budget is used up. Back tomorrow. 🦌");
    await bump(id); // count it before the call so spamming can't run up the bill
    const seed = Math.floor(Math.random() * 1e9);
    const prompt = `${LOCK}, ${STYLES[style]}.`;
    try {
      const r = await fetch("https://api.venice.ai/api/v1/image/generate", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, prompt, width: 896, height: 1152, format: "png", safe_mode: true, return_binary: false, seed }), signal: AbortSignal.timeout(120000) });
      const j = await r.json(); if (!j.images || !j.images[0]) throw new Error(j.error || j.message || "no image");
      const png = Buffer.from(j.images[0], "base64");
      const name = (msg.from.first_name || "Your").slice(0, 24);
      const res = await tgFile("sendPhoto", { chat_id: String(msg.chat.id), caption: `🦌 ${name}'s stag: <b>${style}</b>\nCome hang in the lounge: https://stagwifhood.fun/lounge/`, parse_mode: "HTML", reply_to_message_id: String(msg.message_id) }, "photo", png, "stag.png");
      if (!res.ok) throw new Error(res.description || "send failed");
    } catch (e) { log("stagme err:", e.message); return reply("The artist stumbled. Try again in a minute. (This one didn't count against you.)").then(async () => { try { await q("update stagme_log set n = greatest(n-1,0) where tg_id=$1 and day=$2", [String(id), day()]); } catch {} }); }
  }
  return { command, styles: () => Object.keys(STYLES) };
}
