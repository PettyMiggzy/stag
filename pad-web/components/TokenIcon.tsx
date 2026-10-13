/**
 * Generated token art, drawn locally (no outside service): a green/gold
 * gradient tile with the token's first letter, shifted by a hash of the
 * address so each token keeps the same icon on every visit. Used wherever no
 * uploaded picture is shown.
 */
function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function TokenIcon({ seed, symbol, className }: { seed: string; symbol?: string; className?: string }) {
  const h = hash(seed || '??');
  const hue = 95 + (h % 70); // greens through lime
  const gold = 38 + ((h >> 8) % 14);
  const letter = (symbol?.trim()[0] || '$').toUpperCase().replace(/[<>&"']/g, '$');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 38%)"/><stop offset="1" stop-color="hsl(${gold} 85% 52%)"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><circle cx="${20 + (h % 24)}" cy="${18 + ((h >> 4) % 28)}" r="${10 + ((h >> 12) % 10)}" fill="#fff" fill-opacity=".12"/><text x="32" y="42" text-anchor="middle" font-family="Arial,sans-serif" font-weight="900" font-size="30" fill="#0a1208">${letter}</text></svg>`;
  const src = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className={className} />;
}
