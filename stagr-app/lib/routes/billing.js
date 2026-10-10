import { route } from '../router.js';
import { sql } from '../db.js';
import { bad, missing } from '../http.js';
import { need } from '../auth.js';
import { clean, amt, cleanItems, token, totals, paidSum, r2 } from '../util.js';
import { logActivity } from './activity.js';
import { getCustomer } from './customers.js';
import { nextNumber } from './sales.js';
import { shapeInvoice } from './shapes.js';
import { queueMessage, baseUrl } from './comms.js';

const getInvoice = async (tid, id) => { const [i] = await sql`SELECT * FROM invoices WHERE id = ${Number(id) || 0} AND tenant_id = ${tid}`; if (!i) throw missing('Invoice not found'); return i; };
const METHODS = ['cash', 'check', 'zelle', 'card', 'bank', 'other'];

route('GET', '/api/invoices', async ctx => {
  const rows = await sql`SELECT i.*, c.name AS customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id AND c.tenant_id = i.tenant_id WHERE i.tenant_id = ${ctx.tid} ORDER BY i.created_at DESC LIMIT 300`;
  return { invoices: rows.map(shapeInvoice) };
});
route('POST', '/api/invoices', async ctx => {
  need(ctx, 'admin'); const b = ctx.body, c = await getCustomer(ctx.tid, b.customer_id);
  let items = cleanItems(b.items), jid = null, qid = null, tax = null, disc = null;
  if (b.job_id) { const [j] = await sql`SELECT * FROM jobs WHERE id = ${Number(b.job_id) || 0} AND tenant_id = ${ctx.tid} AND customer_id = ${c.id}`; if (!j) throw bad('Job not found'); jid = j.id; if (!items.length) items = j.items; qid = j.quote_id; }
  if (b.quote_id) qid = Number(b.quote_id) || null;
  if (qid) { // take tax and discount from the quote this invoice comes from (items too, when none were given)
    const [q] = await sql`SELECT * FROM quotes WHERE id = ${qid} AND tenant_id = ${ctx.tid} AND customer_id = ${c.id}`; if (!q) throw bad('Quote not found');
    if (!items.length) items = q.items; tax = q.tax_pct; disc = q.discount_pct;
  }
  if (!items.length) throw bad('Add at least one line item');
  const [t] = await sql`SELECT tax_pct FROM tenants WHERE id = ${ctx.tid}`, n = await nextNumber(ctx.tid, 'invoice');
  const due = /^\d{4}-\d{2}-\d{2}$/.test(b.due_date || '') ? b.due_date : new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
  const [i] = await sql`INSERT INTO invoices (tenant_id, number, customer_id, job_id, quote_id, items, discount_pct, tax_pct, due_date, message, token)
    VALUES (${ctx.tid}, ${n}, ${c.id}, ${jid}, ${qid}, ${JSON.stringify(items)}::jsonb, ${b.discount_pct !== undefined ? Math.min(100, amt(b.discount_pct) ?? 0) : disc ?? 0}, ${b.tax_pct !== undefined ? Math.min(30, amt(b.tax_pct) ?? 0) : tax ?? t.tax_pct}, ${due}, ${clean(b.message, 1000)}, ${token()}) RETURNING *`;
  await logActivity(ctx.tid, c.id, 'invoice', `Invoice INV-${n} created`, ctx.user.id);
  return { invoice: shapeInvoice(i) };
});
route('GET', '/api/invoices/:id', async ctx => ({ invoice: shapeInvoice(await getInvoice(ctx.tid, ctx.params.id)) }));
route('PUT', '/api/invoices/:id', async ctx => {
  need(ctx, 'admin'); const o = await getInvoice(ctx.tid, ctx.params.id); if (o.status === 'void') throw bad('This invoice is void');
  const b = ctx.body, items = b.items !== undefined ? cleanItems(b.items) : o.items; if (!items.length) throw bad('Add at least one line item');
  const t = totals(items, b.discount_pct ?? o.discount_pct, b.tax_pct ?? o.tax_pct); if (t.total < paidSum(o.payments)) throw bad('The total cannot be lower than what was already paid');
  const [i] = await sql`UPDATE invoices SET items = ${JSON.stringify(items)}::jsonb, discount_pct = ${b.discount_pct !== undefined ? Math.min(100, amt(b.discount_pct) ?? 0) : o.discount_pct}, tax_pct = ${b.tax_pct !== undefined ? Math.min(30, amt(b.tax_pct) ?? 0) : o.tax_pct},
    due_date = ${/^\d{4}-\d{2}-\d{2}$/.test(b.due_date || '') ? b.due_date : o.due_date}, message = ${clean(b.message ?? o.message, 1000)} WHERE id = ${o.id} AND tenant_id = ${ctx.tid} RETURNING *`;
  return { invoice: shapeInvoice(i) };
});
route('POST', '/api/invoices/:id/send', async ctx => {
  need(ctx, 'admin'); const o = await getInvoice(ctx.tid, ctx.params.id); if (o.status === 'void') throw bad('This invoice is void');
  const c = await getCustomer(ctx.tid, o.customer_id), [t] = await sql`SELECT name FROM tenants WHERE id = ${ctx.tid}`, link = baseUrl(ctx.req) + '/i/' + o.token, s = shapeInvoice(o);
  await sql`UPDATE invoices SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END, sent_at = COALESCE(sent_at, now()) WHERE id = ${o.id} AND tenant_id = ${ctx.tid}`;
  const body = `Hi ${c.name.split(' ')[0]}, your invoice from ${t.name} (INV-${o.number}, $${s.balance.toFixed(2)} due) is here: ${link}`, sent = [];
  if (ctx.body.sms !== false && c.phone) sent.push(await queueMessage({ tid: ctx.tid, customer: c, channel: 'sms', kind: 'invoice', body, ref: '' }));
  if (ctx.body.email !== false && c.email) sent.push(await queueMessage({ tid: ctx.tid, customer: c, channel: 'email', kind: 'invoice', body, subject: `Invoice INV-${o.number} from ${t.name}`, ref: '' }));
  await logActivity(ctx.tid, c.id, 'invoice', `Invoice INV-${o.number} sent`, ctx.user.id);
  return { link, messages: sent };
});
// Record money received outside the app (cash, check, Zelle, card terminal). Online card payments are added later.
export async function addPayment(tid, inv, { amount, method, note, userId = null, provider_id = '' }) {
  const s = shapeInvoice(inv), a = amt(amount); if (!a || a <= 0) throw bad('Enter the amount received');
  if (a > s.balance + 0.005) throw bad(`That is more than the balance of $${s.balance.toFixed(2)}`);
  const pays = [...inv.payments, { amount: a, method: METHODS.includes(method) ? method : 'other', note: clean(note, 200), at: new Date().toISOString(), by: userId, provider_id }];
  const paidAll = paidSum(pays) >= s.total - 0.005;
  const [i] = await sql`UPDATE invoices SET payments = ${JSON.stringify(pays)}::jsonb, status = ${paidAll ? 'paid' : 'partial'}, paid_at = ${paidAll ? new Date() : null}, sent_at = COALESCE(sent_at, now()) WHERE id = ${inv.id} AND tenant_id = ${tid} RETURNING *`;
  await logActivity(tid, inv.customer_id, 'payment', `Payment of $${a.toFixed(2)} (${method || 'other'}) on INV-${inv.number}`, userId);
  return i;
}
route('POST', '/api/invoices/:id/payments', async ctx => {
  need(ctx, 'admin'); const o = await getInvoice(ctx.tid, ctx.params.id); if (o.status === 'void') throw bad('This invoice is void');
  return { invoice: shapeInvoice(await addPayment(ctx.tid, o, { ...ctx.body, userId: ctx.user.id })) };
});
route('POST', '/api/invoices/:id/void', async ctx => {
  need(ctx, 'admin'); const o = await getInvoice(ctx.tid, ctx.params.id); if (paidSum(o.payments) > 0) throw bad('This invoice has payments. It cannot be voided.');
  const [i] = await sql`UPDATE invoices SET status = 'void' WHERE id = ${o.id} AND tenant_id = ${ctx.tid} RETURNING *`; return { invoice: shapeInvoice(i) };
});
route('GET', '/api/public/i/:token', { public: true }, async ctx => {
  const [i] = await sql`SELECT * FROM invoices WHERE token = ${clean(ctx.params.token, 80)}`; if (!i || i.status === 'draft') throw missing('Invoice not found');
  const [t] = await sql`SELECT name, phone, email, city, state, brand_color, settings FROM tenants WHERE id = ${i.tenant_id}`;
  const [c] = await sql`SELECT name FROM customers WHERE id = ${i.customer_id} AND tenant_id = ${i.tenant_id}`;
  if (!i.viewed_at) await sql`UPDATE invoices SET viewed_at = now() WHERE id = ${i.id} AND tenant_id = ${i.tenant_id}`;
  const s = shapeInvoice(i);
  return { business: { name: t.name, phone: t.phone, email: t.email, city: t.city, state: t.state, brand_color: t.brand_color, payment_note: (t.settings || {}).payment_note || '' }, customer: c.name,
    invoice: { label: s.label, status: s.status, items: s.items, subtotal: s.subtotal, discount: s.discount, tax: s.tax, tax_pct: s.tax_pct, total: s.total, paid: s.paid, balance: s.balance, due_date: s.due_date, message: s.message, payments: s.payments.map(p => ({ amount: p.amount, method: p.method, at: p.at })) }, online_payments: false };
});
