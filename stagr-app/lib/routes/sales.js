import { route } from '../router.js';
import { sql } from '../db.js';
import { bad, missing, HttpError } from '../http.js';
import { clean, amt, cleanItems, token, totals } from '../util.js';
import { logActivity } from './activity.js';
import { getCustomer } from './customers.js';
import { shapeQuote } from './shapes.js';
import { queueMessage, baseUrl } from './comms.js';

async function nextNumber(tid, col) {
  const [r] = col === 'quote' ? await sql`UPDATE tenants SET quote_seq = quote_seq + 1 WHERE id = ${tid} RETURNING quote_seq AS n`
    : col === 'invoice' ? await sql`UPDATE tenants SET invoice_seq = invoice_seq + 1 WHERE id = ${tid} RETURNING invoice_seq AS n`
    : await sql`UPDATE tenants SET job_seq = job_seq + 1 WHERE id = ${tid} RETURNING job_seq AS n`;
  return r.n;
}
export { nextNumber };
async function ownProperty(tid, customerId, propertyId) {
  if (!propertyId) return null;
  const [p] = await sql`SELECT id FROM properties WHERE id = ${Number(propertyId) || 0} AND tenant_id = ${tid} AND customer_id = ${customerId}`;
  if (!p) throw bad('That property does not belong to this customer'); return p.id;
}
const getQuote = async (tid, id) => { const [q] = await sql`SELECT * FROM quotes WHERE id = ${Number(id) || 0} AND tenant_id = ${tid}`; if (!q) throw missing('Quote not found'); return q; };

route('GET', '/api/quotes', async ctx => {
  const rows = await sql`SELECT q.*, c.name AS customer_name FROM quotes q JOIN customers c ON c.id = q.customer_id AND c.tenant_id = q.tenant_id WHERE q.tenant_id = ${ctx.tid} ORDER BY q.created_at DESC LIMIT 300`;
  return { quotes: rows.map(shapeQuote) };
});
route('POST', '/api/quotes', async ctx => {
  const b = ctx.body, c = await getCustomer(ctx.tid, b.customer_id), pid = await ownProperty(ctx.tid, c.id, b.property_id);
  const items = cleanItems(b.items); if (!items.length) throw bad('Add at least one line item');
  const [t] = await sql`SELECT tax_pct FROM tenants WHERE id = ${ctx.tid}`;
  const [req] = b.request_id ? await sql`SELECT id FROM requests WHERE id = ${Number(b.request_id) || 0} AND tenant_id = ${ctx.tid}` : [];
  const n = await nextNumber(ctx.tid, 'quote');
  const [q] = await sql`INSERT INTO quotes (tenant_id, number, customer_id, property_id, request_id, items, discount_pct, tax_pct, deposit, message, token)
    VALUES (${ctx.tid}, ${n}, ${c.id}, ${pid}, ${req ? req.id : null}, ${JSON.stringify(items)}::jsonb, ${Math.min(100, amt(b.discount_pct) ?? 0)}, ${b.tax_pct !== undefined ? Math.min(30, amt(b.tax_pct) ?? 0) : t.tax_pct}, ${amt(b.deposit) ?? 0}, ${clean(b.message, 1000)}, ${token()}) RETURNING *`;
  await logActivity(ctx.tid, c.id, 'quote', `Quote Q-${n} created`, ctx.user.id);
  return { quote: shapeQuote(q) };
});
route('GET', '/api/quotes/:id', async ctx => ({ quote: shapeQuote(await getQuote(ctx.tid, ctx.params.id)) }));
route('PUT', '/api/quotes/:id', async ctx => {
  const o = await getQuote(ctx.tid, ctx.params.id); if (o.status === 'approved') throw bad('An approved quote cannot be edited. Make a new quote instead.');
  const b = ctx.body, items = b.items !== undefined ? cleanItems(b.items) : o.items; if (!items.length) throw bad('Add at least one line item');
  const pid = b.property_id !== undefined ? await ownProperty(ctx.tid, o.customer_id, b.property_id) : o.property_id;
  const [q] = await sql`UPDATE quotes SET items = ${JSON.stringify(items)}::jsonb, discount_pct = ${b.discount_pct !== undefined ? Math.min(100, amt(b.discount_pct) ?? 0) : o.discount_pct}, tax_pct = ${b.tax_pct !== undefined ? Math.min(30, amt(b.tax_pct) ?? 0) : o.tax_pct},
    deposit = ${b.deposit !== undefined ? amt(b.deposit) ?? 0 : o.deposit}, message = ${clean(b.message ?? o.message, 1000)}, property_id = ${pid}, status = ${o.status === 'declined' ? 'draft' : o.status}
    WHERE id = ${o.id} AND tenant_id = ${ctx.tid} RETURNING *`;
  return { quote: shapeQuote(q) };
});
route('DELETE', '/api/quotes/:id', async ctx => {
  const o = await getQuote(ctx.tid, ctx.params.id); if (o.status === 'approved') throw bad('An approved quote cannot be deleted');
  await sql`DELETE FROM quotes WHERE id = ${o.id} AND tenant_id = ${ctx.tid}`; return { ok: true };
});
// Mark as sent and (optionally) text/email the customer the link. Returns the link so the owner can also copy it.
route('POST', '/api/quotes/:id/send', async ctx => {
  const o = await getQuote(ctx.tid, ctx.params.id); if (o.status === 'approved') throw bad('Already approved');
  const c = await getCustomer(ctx.tid, o.customer_id), [t] = await sql`SELECT name, phone FROM tenants WHERE id = ${ctx.tid}`;
  const link = baseUrl(ctx.req) + '/q/' + o.token;
  await sql`UPDATE quotes SET status = 'sent', sent_at = now() WHERE id = ${o.id} AND tenant_id = ${ctx.tid}`;
  const first = c.name.split(' ')[0], sent = [];
  const body = `Hi ${first}, here is your quote from ${t.name}: ${link}`;
  if (ctx.body.sms !== false && c.phone) sent.push(await queueMessage({ tid: ctx.tid, customer: c, channel: 'sms', kind: 'quote', body, ref: '' }));
  if (ctx.body.email !== false && c.email) sent.push(await queueMessage({ tid: ctx.tid, customer: c, channel: 'email', kind: 'quote', body, subject: `Your quote from ${t.name}`, ref: '' }));
  await logActivity(ctx.tid, c.id, 'quote', `Quote Q-${o.number} sent`, ctx.user.id);
  return { link, messages: sent };
});

// ---- the customer's view (no sign-in; the long random link is the key) ----
route('GET', '/api/public/q/:token', { public: true }, async ctx => {
  const [q] = await sql`SELECT * FROM quotes WHERE token = ${clean(ctx.params.token, 80)}`; if (!q || q.status === 'draft') throw missing('Quote not found');
  const [t] = await sql`SELECT name, phone, email, city, state, brand_color FROM tenants WHERE id = ${q.tenant_id}`;
  const [c] = await sql`SELECT name FROM customers WHERE id = ${q.customer_id} AND tenant_id = ${q.tenant_id}`;
  const [p] = q.property_id ? await sql`SELECT address, city, state, zip FROM properties WHERE id = ${q.property_id} AND tenant_id = ${q.tenant_id}` : [];
  if (!q.viewed_at) await sql`UPDATE quotes SET viewed_at = now() WHERE id = ${q.id} AND tenant_id = ${q.tenant_id}`;
  const s = shapeQuote(q);
  return { business: t, customer: c.name, property: p || null, quote: { label: s.label, status: s.status, items: s.items, subtotal: s.subtotal, discount: s.discount, discount_pct: s.discount_pct, tax: s.tax, tax_pct: s.tax_pct, total: s.total, deposit: s.deposit, message: s.message, sent_at: s.sent_at, decided_at: s.decided_at, signed_name: s.signed_name } };
});
route('POST', '/api/public/q/:token/decide', { public: true }, async ctx => {
  const [q] = await sql`SELECT * FROM quotes WHERE token = ${clean(ctx.params.token, 80)}`; if (!q || q.status === 'draft') throw missing('Quote not found');
  if (q.status === 'approved' || q.status === 'declined') throw bad('This quote has already been ' + q.status);
  const decision = ctx.body.decision === 'approve' ? 'approved' : ctx.body.decision === 'decline' ? 'declined' : ''; if (!decision) throw bad('Choose approve or decline');
  const name = clean(ctx.body.name, 120); if (decision === 'approved' && name.length < 2) throw bad('Type your name to approve');
  await sql`UPDATE quotes SET status = ${decision}, decided_at = now(), signed_name = ${name}, client_note = ${clean(ctx.body.note, 500)} WHERE id = ${q.id} AND tenant_id = ${q.tenant_id}`;
  await logActivity(q.tenant_id, q.customer_id, 'quote', `Quote Q-${q.number} ${decision} by customer`);
  return { ok: true, status: decision };
});
