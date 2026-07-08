#!/usr/bin/env node
/* ============================================================
   STAGWIFHOOD — "$STAG AI" art generation (The Hooded 20)
   Generates NFT art + Metaplex-style metadata via Venice AI.
   Key is read from env only (never commit it):
     AI_PROVIDER_KEY  or  VENICE_INFERENCE_KEY_*
   Usage:
     node scripts/generate-nfts.mjs            # all 20
     node scripts/generate-nfts.mjs --only 3   # regenerate token 3
     node scripts/generate-nfts.mjs --hero     # regenerate hero/logo
   ============================================================ */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COLL = join(ROOT, 'assets/nft/stagwifhood');
const IMG = join(COLL, 'img');
const META = join(COLL, 'metadata');
[IMG, META, join(ROOT, 'assets/img')].forEach((d) => mkdirSync(d, { recursive: true }));

const KEY =
  process.env.AI_PROVIDER_KEY ||
  Object.entries(process.env).find(([k]) => k.startsWith('VENICE_INFERENCE_KEY'))?.[1] ||
  process.env.VENICE_KEY;
if (!KEY) { console.error('No API key: set AI_PROVIDER_KEY'); process.exit(1); }

const CACERT = '/root/.ccr/ca-bundle.crt';
const MODEL = process.env.STAG_MODEL || 'nano-banana-pro';

const LOCK =
  'A majestic anthropomorphic brown stag character wearing a forest-green Robin Hood ranger hood ' +
  'pulled up over large branching antlers, warm intelligent dark eyes, cream-colored muzzle, ' +
  'painterly stylized-3D storybook illustration, centered circular gold-framed coin emblem composition, ' +
  'deep forest-green and heraldic gold color palette';
const TAIL = 'ultra high quality, crisp, sharp focus, no text, no words, no signature, no watermark';

/* ---- The Hooded 20: trait matrix ---- */
const TOKENS = [
  { name: 'The Hood Bearer', rarity: 'Legendary', bg: 'Radiant Sunburst Grove', gear: 'The Legendary Hood', cloak: 'Gold-Embroidered Emerald', aura: 'Golden Divine',
    scene: 'bathed in a radiant golden aura, wearing an ornate gold-embroidered emerald hood, holding up a legendary glowing hood, brilliant sunbeams bursting through ancient pines, a faint crown of light above the antlers' },
  { name: 'Nightstalker', rarity: 'Epic', bg: 'Moonlit Glade', gear: 'Silver-Tipped Arrows', cloak: 'Deep Teal', aura: 'Moonsilver',
    scene: 'in a moonlit forest glade, deep teal hood, a quiver of silver-tipped arrows, glowing eyes, drifting fireflies and cool blue moonlight' },
  { name: 'The Sharpshooter', rarity: 'Epic', bg: 'Autumn Woods', gear: 'Drawn Longbow', cloak: 'Hunter Green', aura: 'Amber',
    scene: 'drawing a wooden longbow with intense focus, surrounded by orange and gold autumn leaves, warm amber light' },
  { name: 'Gold Vein', rarity: 'Epic', bg: 'Treasure Hollow', gear: 'Spilling Gold Coins', cloak: 'Olive & Gold', aura: 'Treasure Glow',
    scene: 'beside an overflowing chest of spilling gold coins, a sly confident grin, warm torchlight glinting off the treasure' },
  { name: 'River Ranger', rarity: 'Rare', bg: 'Misty River Valley', gear: 'Wooden Bow', cloak: 'Olive Green', aura: 'Dawn Mist',
    scene: 'standing in a misty river valley at dawn, olive-green hood, a wooden bow across the back, soft golden morning haze' },
  { name: 'The Watcher', rarity: 'Rare', bg: 'Cliffside Overlook', gear: 'Spyglass', cloak: 'Moss Green', aura: 'Wind',
    scene: 'perched on a mossy cliff overlooking a vast pine valley, cloak flowing in the wind, holding a brass spyglass' },
  { name: 'Embercamp', rarity: 'Rare', bg: 'Campfire Night', gear: 'Hunting Horn', cloak: 'Warm Green', aura: 'Firelight',
    scene: 'seated beside a crackling campfire at night, warm orange firelight on the fur, a hunting horn at the belt, cozy and content' },
  { name: 'Frosthorn', rarity: 'Rare', bg: 'Winter Forest', gear: 'Frost-Rimed Bow', cloak: 'White & Green', aura: 'Frost',
    scene: 'in a snowy winter pine forest, visible breath fog, a white-and-green cloak, a light frost rimming the antlers' },
  { name: 'Thornwood', rarity: 'Rare', bg: 'Bramble Thicket', gear: 'Hunting Dagger', cloak: 'Dark Hunter Green', aura: 'Shadow',
    scene: 'emerging from a deep bramble thicket, dark hunter-green hood, a curved hunting dagger, dappled shadow light' },
  { name: 'Sunspear', rarity: 'Rare', bg: 'Golden Clearing', gear: 'Raised Bow', cloak: 'Sunlit Green', aura: 'Sunset',
    scene: 'in a golden wheat clearing at sunset, raising a bow triumphantly overhead, long warm rays of sunset light' },
  { name: 'Dawnwarden', rarity: 'Rare', bg: 'Dawn Pines', gear: 'Green-Fletched Quiver', cloak: 'Fresh Green', aura: 'Sunrise',
    scene: 'in a dawn-lit pine forest, a quiver of green-fletched arrows, first light breaking gold over the treeline' },
  { name: 'Fogwalker', rarity: 'Common', bg: 'Foggy Morning', gear: 'Coin Pouch', cloak: 'Sage Green', aura: 'Soft Mist',
    scene: 'walking through a foggy morning forest, a small leather coin pouch at the belt, soft muted light' },
  { name: 'Oakheart', rarity: 'Common', bg: 'Ancient Oak Grove', gear: 'Leaf Cloak-Clasp', cloak: 'Forest Green', aura: 'Earthy',
    scene: 'among ancient mossy oak trees, a golden leaf-shaped cloak clasp, dappled green light' },
  { name: 'Birchveil', rarity: 'Common', bg: 'Birch Woods', gear: 'Wooden Flute', cloak: 'Pale Green', aura: 'Calm',
    scene: 'in a bright white birch wood, holding a small wooden flute, calm and gentle daylight' },
  { name: 'Ridgeline', rarity: 'Common', bg: 'Mountain Ridge', gear: 'Traveler Pack', cloak: 'Slate Green', aura: 'Alpine',
    scene: 'on a high mountain ridge at golden hour, a traveler pack over the shoulder, distant peaks' },
  { name: 'Cascade', rarity: 'Common', bg: 'Waterfall Grotto', gear: 'Woven Net', cloak: 'Teal Green', aura: 'Spray',
    scene: 'in a lush waterfall grotto, fine mist in the air, a woven net at the side, cool green light' },
  { name: 'Meadowlight', rarity: 'Common', bg: 'Wildflower Meadow', gear: 'Golden Apple', cloak: 'Meadow Green', aura: 'Bloom',
    scene: 'in a sunny wildflower meadow, holding a shiny golden apple, warm cheerful light' },
  { name: 'Duskrunner', rarity: 'Common', bg: 'Twilight Forest', gear: 'Lantern', cloak: 'Twilight Green', aura: 'Dusk',
    scene: 'in a twilight forest, carrying a warm glowing lantern, deep blue-and-gold dusk sky' },
  { name: 'Rainveil', rarity: 'Common', bg: 'Rainy Forest', gear: 'Oilcloak', cloak: 'Wet Green', aura: 'Rain',
    scene: 'in a gentle rainy forest, water droplets on the hood, an oiled travel cloak, soft grey-green light' },
  { name: 'Starfern', rarity: 'Common', bg: 'Starlit Night', gear: 'Map Scroll', cloak: 'Midnight Green', aura: 'Starlight',
    scene: 'under a starlit night sky in a forest clearing, unrolling an old map scroll, faint golden starlight' },
];

/* ---- prompt builder ---- */
const buildPrompt = (t) => `${LOCK}, ${t.scene}, ${TAIL}`;

/* ---- generate one image via Venice (curl handles proxy) ---- */
function genImage(prompt, outPath) {
  const body = JSON.stringify({ model: MODEL, prompt, width: 1024, height: 1024, format: 'png', return_binary: false });
  const args = ['-sS', '-X', 'POST',
    '-H', `Authorization: Bearer ${KEY}`, '-H', 'Content-Type: application/json',
    '--data', body, 'https://api.venice.ai/api/v1/image/generate'];
  if (existsSync(CACERT)) args.push('--cacert', CACERT);
  const raw = execFileSync('curl', args, { maxBuffer: 64 * 1024 * 1024 }).toString();
  const json = JSON.parse(raw);
  if (!json.images?.[0]) throw new Error('no image in response: ' + raw.slice(0, 300));
  writeFileSync(outPath, Buffer.from(json.images[0], 'base64'));
  return json;
}

/* ---- metadata ---- */
function writeMeta(i, t) {
  const nn = String(i).padStart(2, '0');
  const meta = {
    name: `Hooded Stag #${nn} — ${t.name}`,
    symbol: 'STAG',
    description:
      `${t.name}, one of The Hooded 20 — the legendary stags who wear the stolen hood of Robin Hood. ` +
      `Face of Robinhood Chain. Holders get whitelist priority in every $STAG Prize Heist.`,
    image: `${nn}.png`,
    external_url: 'https://stagwifhood.fun',
    attributes: [
      { trait_type: 'Rarity', value: t.rarity },
      { trait_type: 'Background', value: t.bg },
      { trait_type: 'Gear', value: t.gear },
      { trait_type: 'Cloak', value: t.cloak },
      { trait_type: 'Aura', value: t.aura },
    ],
    properties: { files: [{ uri: `${nn}.png`, type: 'image/png' }], category: 'image' },
  };
  writeFileSync(join(META, `${nn}.json`), JSON.stringify(meta, null, 2));
  return meta;
}

/* ---- run ---- */
const argv = process.argv.slice(2);
const onlyIdx = argv.includes('--only') ? parseInt(argv[argv.indexOf('--only') + 1], 10) : null;
const heroOnly = argv.includes('--hero');

if (heroOnly) {
  console.log('Regenerating hero/logo…');
  genImage(buildPrompt(TOKENS[0]) + ', bold coin logo, iconic mascot portrait', join(ROOT, 'assets/img/logo.png'));
  console.log('  ✓ assets/img/logo.png');
  process.exit(0);
}

const manifest = [];
for (let i = 1; i <= TOKENS.length; i++) {
  const t = TOKENS[i - 1];
  const nn = String(i).padStart(2, '0');
  const meta = writeMeta(i, t);
  manifest.push({ id: i, file: `${nn}.png`, name: meta.name, rarity: t.rarity });
  if (onlyIdx && onlyIdx !== i) continue;
  process.stdout.write(`#${nn} ${t.name} [${t.rarity}] … `);
  try {
    genImage(buildPrompt(t), join(IMG, `${nn}.png`));
    console.log('✓');
  } catch (e) {
    console.log('✗ ' + e.message);
  }
}

/* ---- collection + manifest ---- */
writeFileSync(join(COLL, 'manifest.json'), JSON.stringify({ collection: 'The Hooded 20', symbol: 'STAG', total: TOKENS.length, items: manifest }, null, 2));
writeFileSync(join(COLL, 'collection.json'), JSON.stringify({
  name: 'The Hooded 20',
  symbol: 'STAG',
  description: 'Twenty legendary stags who wear the stolen hood of Robin Hood — the face of Robinhood Chain. Holders get whitelist priority in every $STAG Prize Heist.',
  image: 'img/01.png',
  external_url: 'https://stagwifhood.fun',
  properties: { category: 'image', creators: [] },
}, null, 2));
console.log('\nmetadata + manifest written →', COLL);
