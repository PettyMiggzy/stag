import { totals, paidSum, r2, pad } from '../util.js';
export const shapeQuote = v => ({ ...v, label: 'Q-' + v.number, ...totals(v.items, v.discount_pct, v.tax_pct) });
export function shapeInvoice(v) {
  const t = totals(v.items, v.discount_pct, v.tax_pct), paid = paidSum(v.payments);
  return { ...v, label: 'INV-' + v.number, ...t, paid, balance: Math.max(0, r2(t.total - paid)) };
}
export const label = (kind, n) => ({ quote: 'Q-', invoice: 'INV-', job: 'J-' }[kind] || '') + n;
