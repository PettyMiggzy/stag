import crypto from 'node:crypto';
export const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const token = (bytes = 18) => crypto.randomBytes(bytes).toString('base64url');
export const clean = (s, max = 200) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
export const email = s => { const v = clean(s, 120).toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? v : ''; };
export const phone = s => { const d = String(s ?? '').replace(/\D/g, ''); return d.length === 10 ? d : d.length === 11 && d[0] === '1' ? d.slice(1) : ''; };
export const amt = v => { if (v === '' || v === null || v === undefined) return null; const n = Number(String(v).replace(/[$,]/g, '')); return Number.isFinite(n) && n >= 0 && n < 1e8 ? r2(n) : null; };
export const slugify = s => clean(s, 60).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'business';
// Line items: [{name, description, qty, price, kind: 'item' | 'text', optional, selected, image}] cleaned and capped.
// 'text' lines are only words (no price). 'optional' lines are add-ons the customer can tick; 'selected' says if it is ticked.
export function cleanItems(items) {
  return (Array.isArray(items) ? items : []).slice(0, 60).map(i => {
    const text = !!(i && i.kind === 'text');
    const image = i && typeof i.image === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(i.image) && i.image.length < 250000 ? i.image : '';
    return {
      kind: text ? 'text' : 'item', name: clean(i && i.name, 120), description: clean(i && i.description, text ? 1500 : 300),
      qty: text ? 1 : (() => { const q = Number(i && i.qty); return Number.isFinite(q) && q > 0 && q <= 10000 ? r2(q) : 1; })(),
      price: text ? 0 : amt(i && i.price) ?? 0, optional: !text && !!(i && i.optional), selected: !text && !!(i && i.optional) ? !!(i && i.selected) : true, image: text ? '' : image
    };
  }).filter(i => i.kind === 'text' ? (i.name || i.description) : (i.name || i.price));
}
// Lines that count toward the total: real items, and optional items only when ticked.
export const billable = items => (items || []).filter(i => i.kind !== 'text' && (!i.optional || i.selected));
export function totals(items, discountPct = 0, taxPct = 0) {
  const subtotal = r2(billable(items).reduce((a, i) => a + Number(i.qty) * Number(i.price), 0));
  const discount = r2(subtotal * Math.min(100, Math.max(0, Number(discountPct) || 0)) / 100);
  const taxable = r2(subtotal - discount);
  const tax = r2(taxable * Math.min(30, Math.max(0, Number(taxPct) || 0)) / 100);
  return { subtotal, discount, tax, total: r2(taxable + tax) };
}
export const paidSum = payments => r2((payments || []).reduce((a, p) => a + Number(p.amount || 0), 0));
export const pad = (n, w = 4) => String(n).padStart(w, '0');
export const isoDate = d => new Date(d).toISOString().slice(0, 10);
