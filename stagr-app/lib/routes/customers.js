import { route } from '../router.js';
import { sql } from '../db.js';
import { bad, missing, HttpError } from '../http.js';
import { need } from '../auth.js';
import { clean, email as cleanEmail, phone as cleanPhone, amt, token } from '../util.js';
import { logActivity } from './activity.js';
import { nextNumber } from './sales.js';
import { shapeQuote, shapeInvoice } from './shapes.js';

const cust = (b, old = {}) => ({
  name: clean(b.name ?? old.name, 120), company: clean(b.company ?? old.company, 120),
  phone: b.phone !== undefined ? cleanPhone(b.phone) : old.phone || '', email: b.email !== undefined ? cleanEmail(b.email) : old.email || '',
  notes: clean(b.notes ?? old.notes, 4000), tags: Array.isArray(b.tags) ? b.tags.map(t => clean(t, 30)).filter(Boolean).slice(0, 12) : old.tags || [], source: clean(b.source ?? old.source, 40)
});
export async function getCustomer(tid, id) {
  const [c] = await sql`SELECT * FROM customers WHERE id = ${Number(id) || 0} AND tenant_id = ${tid}`;
  if (!c) throw missing('Customer not found'); return c;
}

route('GET', '/api/customers', async ctx => {
  const q = clean(ctx.query.q, 60), like = '%' + q.replace(/[%_]/g, '') + '%', arch = ctx.query.archived === '1';
  const rows = await sql`SELECT c.*, COALESCE((SELECT sum(jsonb_array_length(i.items)) FROM invoices i WHERE i.customer_id = c.id AND i.tenant_id = c.tenant_id), 0)::int AS invoice_lines,
      (SELECT max(v.starts_at) FROM visits v JOIN jobs j ON j.id = v.job_id AND j.tenant_id = v.tenant_id WHERE j.customer_id = c.id AND v.tenant_id = c.tenant_id AND v.status = 'completed') AS last_visit
    FROM customers c WHERE c.tenant_id = ${ctx.tid} AND c.archived = ${arch}
      AND (${q} = '' OR c.name ILIKE ${like} OR c.company ILIKE ${like} OR c.phone ILIKE ${like} OR c.email ILIKE ${like})
    ORDER BY c.created_at DESC LIMIT 300`;
  return { customers: rows };
});
route('POST', '/api/customers', async ctx => {
  const v = cust(ctx.body); if (!v.name) throw bad('Enter the customer name');
  const optIn = ctx.body.sms_opt_in === true && !!v.phone;
  const [c] = await sql`INSERT INTO customers (tenant_id, name, company, phone, email, notes, tags, source, sms_opt_in, sms_opt_in_at)
    VALUES (${ctx.tid}, ${v.name}, ${v.company}, ${v.phone}, ${v.email}, ${v.notes}, ${v.tags}, ${v.source}, ${optIn}, ${optIn ? new Date() : null}) RETURNING *`;
  const p = ctx.body.property;
  if (p && clean(p.address, 200)) await sql`INSERT INTO properties (tenant_id, customer_id, address, city, state, zip, notes) VALUES (${ctx.tid}, ${c.id}, ${clean(p.address, 200)}, ${clean(p.city, 60)}, ${clean(p.state, 2).toUpperCase()}, ${clean(p.zip, 10)}, ${clean(p.notes, 500)})`;
  await logActivity(ctx.tid, c.id, 'customer', 'Customer added', ctx.user.id);
  return { customer: c };
});
route('GET', '/api/customers/:id', async ctx => {
  const c = await getCustomer(ctx.tid, ctx.params.id), tid = ctx.tid;
  const [properties, requests, quotes, jobs, invoices, messages, activity, reviewRequests] = await Promise.all([
    sql`SELECT * FROM properties WHERE tenant_id = ${tid} AND customer_id = ${c.id} ORDER BY id`,
    sql`SELECT * FROM requests WHERE tenant_id = ${tid} AND customer_id = ${c.id} ORDER BY created_at DESC LIMIT 50`,
    sql`SELECT * FROM quotes WHERE tenant_id = ${tid} AND customer_id = ${c.id} ORDER BY created_at DESC LIMIT 50`,
    sql`SELECT j.*, (SELECT count(*)::int FROM visits v WHERE v.job_id = j.id AND v.tenant_id = j.tenant_id) AS visit_count, (SELECT min(starts_at) FROM visits v WHERE v.job_id = j.id AND v.tenant_id = j.tenant_id AND v.status = 'scheduled' AND v.starts_at > now()) AS next_visit FROM jobs j WHERE j.tenant_id = ${tid} AND j.customer_id = ${c.id} ORDER BY j.created_at DESC LIMIT 50`,
    sql`SELECT * FROM invoices WHERE tenant_id = ${tid} AND customer_id = ${c.id} ORDER BY created_at DESC LIMIT 50`,
    sql`SELECT id, channel, direction, kind, body, status, delivery_status, delivered_at, error, created_at FROM messages WHERE tenant_id = ${tid} AND customer_id = ${c.id} ORDER BY created_at DESC LIMIT 50`,
    sql`SELECT * FROM activity WHERE tenant_id = ${tid} AND customer_id = ${c.id} ORDER BY at DESC LIMIT 60`,
    sql`SELECT m.id, m.body, m.status, m.delivery_status, m.delivered_at, m.error, m.sent_at, m.created_at, m.ref, m.job_id, j.title AS job_title FROM messages m LEFT JOIN jobs j ON j.id = m.job_id AND j.tenant_id = m.tenant_id WHERE m.tenant_id = ${tid} AND m.customer_id = ${c.id} AND m.kind = 'review_request' ORDER BY m.created_at DESC LIMIT 50`]);
  return { customer: c, properties, requests, quotes: quotes.map(shapeQuote), jobs, invoices: invoices.map(shapeInvoice), messages, activity, review_requests: reviewRequests };
});
route('PUT', '/api/customers/:id', async ctx => {
  const old = await getCustomer(ctx.tid, ctx.params.id), v = cust(ctx.body, old); if (!v.name) throw bad('Enter the customer name');
  const b = ctx.body; let optIn = old.sms_opt_in, optInAt = old.sms_opt_in_at, optOutAt = old.sms_opt_out_at;
  if (b.sms_opt_in === true && !old.sms_opt_in && v.phone) { optIn = true; optInAt = new Date(); optOutAt = null; }
  if (b.sms_opt_in === false && old.sms_opt_in) { optIn = false; optOutAt = new Date(); }
  const [c] = await sql`UPDATE customers SET name = ${v.name}, company = ${v.company}, phone = ${v.phone}, email = ${v.email}, notes = ${v.notes}, tags = ${v.tags}, source = ${v.source},
    sms_opt_in = ${optIn && !!v.phone}, sms_opt_in_at = ${optInAt}, sms_opt_out_at = ${optOutAt}, archived = ${b.archived === undefined ? old.archived : !!b.archived}
    WHERE id = ${old.id} AND tenant_id = ${ctx.tid} RETURNING *`;
  return { customer: c };
});

// ---- properties ----
route('POST', '/api/customers/:id/properties', async ctx => {
  const c = await getCustomer(ctx.tid, ctx.params.id), b = ctx.body; if (!clean(b.address, 200)) throw bad('Enter the address');
  const [p] = await sql`INSERT INTO properties (tenant_id, customer_id, address, city, state, zip, notes) VALUES (${ctx.tid}, ${c.id}, ${clean(b.address, 200)}, ${clean(b.city, 60)}, ${clean(b.state, 2).toUpperCase()}, ${clean(b.zip, 10)}, ${clean(b.notes, 500)}) RETURNING *`;
  return { property: p };
});
route('PUT', '/api/properties/:id', async ctx => {
  const [o] = await sql`SELECT * FROM properties WHERE id = ${Number(ctx.params.id) || 0} AND tenant_id = ${ctx.tid}`; if (!o) throw missing();
  const b = ctx.body;
  const [p] = await sql`UPDATE properties SET address = ${clean(b.address ?? o.address, 200)}, city = ${clean(b.city ?? o.city, 60)}, state = ${clean(b.state ?? o.state, 2).toUpperCase()}, zip = ${clean(b.zip ?? o.zip, 10)}, notes = ${clean(b.notes ?? o.notes, 500)} WHERE id = ${o.id} AND tenant_id = ${ctx.tid} RETURNING *`;
  return { property: p };
});
route('DELETE', '/api/properties/:id', async ctx => { await sql`DELETE FROM properties WHERE id = ${Number(ctx.params.id) || 0} AND tenant_id = ${ctx.tid}`; return { ok: true }; });

// ---- services (the price list) ----
route('GET', '/api/services', async ctx => ({ services: await sql`SELECT * FROM services WHERE tenant_id = ${ctx.tid} AND active ORDER BY name` }));
route('POST', '/api/services', async ctx => {
  need(ctx, 'admin'); const b = ctx.body; if (!clean(b.name, 120)) throw bad('Enter a name');
  const [s] = await sql`INSERT INTO services (tenant_id, name, description, unit_price) VALUES (${ctx.tid}, ${clean(b.name, 120)}, ${clean(b.description, 300)}, ${amt(b.unit_price) ?? 0}) RETURNING *`; return { service: s };
});
route('PUT', '/api/services/:id', async ctx => {
  need(ctx, 'admin'); const [o] = await sql`SELECT * FROM services WHERE id = ${Number(ctx.params.id) || 0} AND tenant_id = ${ctx.tid}`; if (!o) throw missing(); const b = ctx.body;
  const [s] = await sql`UPDATE services SET name = ${clean(b.name ?? o.name, 120)}, description = ${clean(b.description ?? o.description, 300)}, unit_price = ${b.unit_price !== undefined ? amt(b.unit_price) ?? 0 : o.unit_price}, active = ${b.active === undefined ? o.active : !!b.active} WHERE id = ${o.id} AND tenant_id = ${ctx.tid} RETURNING *`;
  return { service: s };
});

// ---- requests (new leads: from the booking page or typed in) ----
route('GET', '/api/requests', async ctx => ({ requests: await sql`SELECT * FROM requests WHERE tenant_id = ${ctx.tid} ORDER BY created_at DESC LIMIT 300` }));
route('POST', '/api/requests', async ctx => {
  const b = ctx.body; if (!clean(b.name, 120)) throw bad('Enter a name');
  const [r] = await sql`INSERT INTO requests (tenant_id, source, name, phone, email, service, address, message) VALUES (${ctx.tid}, ${clean(b.source || 'manual', 30)}, ${clean(b.name, 120)}, ${cleanPhone(b.phone)}, ${cleanEmail(b.email)}, ${clean(b.service, 120)}, ${clean(b.address, 200)}, ${clean(b.message, 2000)}) RETURNING *`;
  return { request: r };
});
// Turn a request into a customer (and property). Reuses an existing customer with the same phone or email.
// Text and email marketing consent chosen on the booking form is recorded on the customer, with the time.
async function customerFromRequest(ctx, r) {
  let [c] = r.customer_id ? await sql`SELECT * FROM customers WHERE id = ${r.customer_id} AND tenant_id = ${ctx.tid}` : [];
  if (!c && (r.phone || r.email)) [c] = await sql`SELECT * FROM customers WHERE tenant_id = ${ctx.tid} AND ((${r.phone} <> '' AND phone = ${r.phone}) OR (${r.email} <> '' AND email = ${r.email})) LIMIT 1`;
  if (!c) {
    const sms = !!(r.sms_ok && r.phone), em = !!(r.email_ok && r.email);
    [c] = await sql`INSERT INTO customers (tenant_id, name, company, phone, email, source, notes, sms_opt_in, sms_opt_in_at, email_opt_in) VALUES (${ctx.tid}, ${r.name}, ${r.company || ''}, ${r.phone}, ${r.email}, ${r.source}, ${r.message}, ${sms}, ${sms ? r.created_at : null}, ${em}) RETURNING *`;
    if (r.address) await sql`INSERT INTO properties (tenant_id, customer_id, address) VALUES (${ctx.tid}, ${c.id}, ${r.address})`;
  }
  await sql`UPDATE requests SET status = 'converted', customer_id = ${c.id}, contacted_at = COALESCE(contacted_at, now()) WHERE id = ${r.id} AND tenant_id = ${ctx.tid}`;
  await logActivity(ctx.tid, c.id, 'request', 'Request converted to a customer', ctx.user.id);
  return c;
}
const getRequest = async ctx => { const [r] = await sql`SELECT * FROM requests WHERE id = ${Number(ctx.params.id) || 0} AND tenant_id = ${ctx.tid}`; if (!r) throw missing(); return r; };
route('GET', '/api/requests/:id', async ctx => {
  const r = await getRequest(ctx); let customer = null, quotes = [];
  if (r.customer_id) { [customer] = await sql`SELECT id, name FROM customers WHERE id = ${r.customer_id} AND tenant_id = ${ctx.tid}`; quotes = await sql`SELECT id, number, status FROM quotes WHERE request_id = ${r.id} AND tenant_id = ${ctx.tid} ORDER BY id`; }
  return { request: r, customer, quotes };
});
route('PUT', '/api/requests/:id', async ctx => {
  const o = await getRequest(ctx), b = ctx.body, st = ['new', 'contacted', 'converted', 'lost'].includes(b.status) ? b.status : o.status;
  const [r] = await sql`UPDATE requests SET status = ${st}, contacted_at = ${st !== 'new' && !o.contacted_at ? new Date() : o.contacted_at}, notes = ${clean(b.notes ?? o.notes, 4000)}, service = ${clean(b.service ?? o.service, 120)} WHERE id = ${o.id} AND tenant_id = ${ctx.tid} RETURNING *`; return { request: r };
});
route('POST', '/api/requests/:id/convert', async ctx => ({ customer: await customerFromRequest(ctx, await getRequest(ctx)) }));
// Jobber-style "Convert to Quote": makes the customer and a draft quote that already points back at this request.
route('POST', '/api/requests/:id/convert-quote', async ctx => {
  const r = await getRequest(ctx), c = await customerFromRequest(ctx, r), [p] = await sql`SELECT id FROM properties WHERE customer_id = ${c.id} AND tenant_id = ${ctx.tid} ORDER BY id LIMIT 1`;
  const [t] = await sql`SELECT tax_pct FROM tenants WHERE id = ${ctx.tid}`, [sv] = r.service ? await sql`SELECT name, description, unit_price FROM services WHERE tenant_id = ${ctx.tid} AND active AND lower(name) = lower(${r.service}) LIMIT 1` : [];
  const n = await nextNumber(ctx.tid, 'quote');
  const items = [sv ? { kind: 'item', name: sv.name, description: sv.description, qty: 1, price: Number(sv.unit_price), optional: false, selected: true, image: '' } : { kind: 'item', name: r.service || 'Service', description: '', qty: 1, price: 0, optional: false, selected: true, image: '' }];
  const [q] = await sql`INSERT INTO quotes (tenant_id, number, customer_id, property_id, request_id, items, tax_pct, token, title) VALUES (${ctx.tid}, ${n}, ${c.id}, ${p ? p.id : null}, ${r.id}, ${JSON.stringify(items)}::jsonb, ${t.tax_pct}, ${token()}, ${clean(r.service, 120)}) RETURNING id, number`;
  await logActivity(ctx.tid, c.id, 'quote', `Quote Q-${n} started from a request`, ctx.user.id);
  return { customer: c, quote: q };
});

// ---- public booking page: anyone can send a request to a business by its slug ----
route('GET', '/api/public/b/:slug', { public: true }, async ctx => {
  const [t] = await sql`SELECT id, name, slug, phone, city, state, brand_color, settings FROM tenants WHERE slug = ${clean(ctx.params.slug, 60)}`;
  if (!t || (t.settings || {}).booking_enabled === false) throw missing('Booking page not found');
  const services = await sql`SELECT name, description FROM services WHERE tenant_id = ${t.id} AND active ORDER BY name`;
  return { business: { name: t.name, phone: t.phone, city: t.city, state: t.state, brand_color: t.brand_color, intro: (t.settings || {}).booking_intro || '' }, services };
});
route('POST', '/api/public/b/:slug/request', { public: true }, async ctx => {
  const [t] = await sql`SELECT id, settings FROM tenants WHERE slug = ${clean(ctx.params.slug, 60)}`;
  if (!t || (t.settings || {}).booking_enabled === false) throw missing('Booking page not found');
  const b = ctx.body, name = clean(b.name, 120), ph = cleanPhone(b.phone), em = cleanEmail(b.email);
  if (!name) throw bad('Please enter your name'); if (!ph && !em) throw bad('Please enter a phone number or email so we can reach you');
  const key = 'booking:' + ctx.ip; const [n] = await sql`SELECT count(*)::int AS n FROM login_fails WHERE key = ${key} AND at > now() - interval '1 hour'`;
  if (n.n >= 8) throw new HttpError(429, 'Too many requests. Please call us instead.');
  await sql`INSERT INTO login_fails (key) VALUES (${key})`;
  const photos = (Array.isArray(b.photos) ? b.photos : []).filter(p => typeof p === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(p) && p.length < 900000).slice(0, 6);
  const av = b.availability && typeof b.availability === 'object' ? b.availability : {};
  const dates = (Array.isArray(av.dates) ? av.dates : []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 2), arrival = (Array.isArray(av.arrival) ? av.arrival : []).filter(a => ['any', 'morning', 'afternoon'].includes(a));
  // Consent is stored with the request and copied to the customer when the request is converted.
  await sql`INSERT INTO requests (tenant_id, source, name, company, phone, email, service, address, message, photos, availability, sms_ok, email_ok)
    VALUES (${t.id}, 'booking page', ${name}, ${clean(b.company, 120)}, ${ph}, ${em}, ${clean(b.service, 120)}, ${clean(b.address, 200)}, ${clean(b.message, 2000)}, ${JSON.stringify(photos)}::jsonb, ${JSON.stringify({ dates, arrival })}::jsonb, ${b.sms_ok === true && !!ph}, ${b.email_ok === true && !!em})`;
  return { ok: true };
});
