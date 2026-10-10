import { totals, paidSum, r2, pad } from '../util.js';
export const shapeQuote = v => { const t = totals(v.items, v.discount_pct, v.tax_pct), pct = Number(v.deposit_pct) || 0;
  return { ...v, label: 'Q-' + v.number, ...t, deposit_due: pct > 0 ? r2(t.total * pct / 100) : r2(Number(v.deposit) || 0) }; };
export function shapeInvoice(v) {
  const t = totals(v.items, v.discount_pct, v.tax_pct), paid = paidSum(v.payments);
  return { ...v, label: 'INV-' + v.number, ...t, paid, balance: Math.max(0, r2(t.total - paid)) };
}
export const label = (kind, n) => ({ quote: 'Q-', invoice: 'INV-', job: 'J-' }[kind] || '') + n;
