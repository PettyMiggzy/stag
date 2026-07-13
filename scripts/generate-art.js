#!/usr/bin/env node
/**
 * STAG WARS — Venice AI art asset generator.
 *
 * Generates real art for arena.html and writes PNGs into assets/game/.
 * Requires a Venice API key in the environment:  VENICE_API_KEY=...  node scripts/generate-art.js
 *
 * Optional: pass asset ids to (re)generate a subset, e.g.
 *   node scripts/generate-art.js ground sky
 */
const fs = require("fs");
const path = require("path");

const KEY = process.env.VENICE_API_KEY || process.env.VENICE_KEY;
if (!KEY) {
  console.error("\n  Missing VENICE_API_KEY. Run:  VENICE_API_KEY=sk-... node scripts/generate-art.js\n");
  process.exit(1);
}

const OUT = path.join(__dirname, "..", "assets", "game");
fs.mkdirSync(OUT, { recursive: true });

// Venice image models seen live: krea-2-turbo (SOTA, aspect_ratio), venice-sd35 (w/h), grok-imagine-image-quality.
const ASSETS = [
  {
    id: "ground",
    file: "ground.png",
    model: "venice-sd35",
    width: 1024, height: 1024,
    prompt:
      "seamless tileable top-down texture of a dark forest meadow floor, trampled green grass, patches of dirt and dead leaves, moss, muted desaturated colors, gritty realistic, no shadows, flat overhead lighting, game texture, high detail",
    negative_prompt: "seams, borders, watermark, text, characters, animals, blur, tiling artifacts, vignette",
  },
  {
    id: "sky",
    file: "sky.png",
    model: "krea-2-turbo",
    aspect_ratio: "16:9",
    prompt:
      "dramatic ominous fantasy sky, heavy storm clouds parting, blood-orange dusk light on the horizon, dark moody atmosphere, medieval Sherwood forest battlefield mood, cinematic, no ground, no characters, epic wide vista, high detail concept art",
    negative_prompt: "watermark, text, characters, animals, ground, trees in foreground, logo, frame",
  },
  {
    id: "fur",
    file: "fur.png",
    model: "venice-sd35",
    width: 1024, height: 1024,
    prompt:
      "seamless tileable close-up texture of dark reddish-brown stag fur, short coarse deer hair, muscular animal hide, realistic, subtle sheen, natural lighting, game material, high detail",
    negative_prompt: "seams, borders, watermark, text, whole animal, face, blur, tiling artifacts",
  },
  {
    id: "hood",
    file: "hood.png",
    model: "venice-sd35",
    width: 768, height: 768,
    prompt:
      "a single glowing emerald-green Robin Hood hood, medieval hooded cloak with a feather, floating, mystical golden aura, centered on pure black background, video game power-up icon, dramatic rim light, high detail, painterly",
    negative_prompt: "person, face, body, text, watermark, multiple objects, cluttered background",
  },
  {
    id: "blood",
    file: "blood.png",
    model: "venice-sd35",
    width: 768, height: 768,
    format: "png",
    prompt:
      "top-down blood splatter decal, dark crimson red splash and droplets, isolated on pure black background, sharp edges, realistic wet blood, game decal texture",
    negative_prompt: "background scene, text, watermark, character, gradient background",
  },
];

async function gen(a) {
  const body = {
    model: a.model,
    prompt: a.prompt,
    negative_prompt: a.negative_prompt || "",
    format: "png",
    return_binary: false,
    hide_watermark: true,
    safe_mode: false,
    cfg_scale: a.cfg_scale || 7,
  };
  if (a.aspect_ratio) body.aspect_ratio = a.aspect_ratio;
  else { body.width = a.width || 1024; body.height = a.height || 1024; }

  process.stdout.write(`  → ${a.id} (${a.model}) ... `);
  const res = await fetch("https://api.venice.ai/api/v1/image/generate", {
    method: "POST",
    headers: { "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    console.log(`FAIL ${res.status}`);
    console.error("    " + txt.slice(0, 300));
    return false;
  }
  const json = await res.json();
  const b64 = json.images && json.images[0];
  if (!b64) { console.log("FAIL no image"); return false; }
  const buf = Buffer.from(b64, "base64");
  fs.writeFileSync(path.join(OUT, a.file), buf);
  console.log(`ok  ${(buf.length / 1024).toFixed(0)}kb  -> assets/game/${a.file}`);
  return true;
}

(async () => {
  const only = process.argv.slice(2);
  const list = only.length ? ASSETS.filter((a) => only.includes(a.id)) : ASSETS;
  console.log(`\nSTAG WARS art gen — ${list.length} asset(s)\n`);
  let ok = 0;
  for (const a of list) {
    try { if (await gen(a)) ok++; }
    catch (e) { console.log("ERROR", e.message); }
  }
  console.log(`\nDone. ${ok}/${list.length} generated into assets/game/\n`);
})();
