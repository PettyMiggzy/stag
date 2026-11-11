// Card payments through each business's own Square account. The customer pays on Square's hosted checkout page, so
// card numbers never touch STAGR. Money goes straight to the business; STAGR only records that the invoice was paid.
import crypto from 'node:crypto';
import { route } from '../router.js';
import { sql } from '../db.js';
import { bad, missing, HttpError } from '../http.js';
import { need, appKey, checkLockout, recordFail } from '../auth.js';
import { clean, token } from '../util.js';
import { shapeInvoice, shapeQuote } from './shapes.js';
import { addPayment } from './billing.js';
import { logActivity } from './activity.js';
import { baseUrl } from './comms.js';
import { notify } from './devices.js';

const SQ_VERSION = '2025-01-23';
const sandbox = () => process.env.SQUARE_ENV === 'sandbox';
const apiBase = () => (process.env.SQUARE_API_BASE || (sandbox() ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com')).replace(/\/$/, '');
const oauthReady = () => !!(process.env.SQUARE_APP_ID && process.env.SQUARE_APP_SECRET);
const SCOPES = 'MERCHANT_PROFILE_READ PAYMENTS_WRITE PAYMENTS_READ ORDERS_WRITE ORDERS_READ';

// ---- secrets at rest: AES-256-GCM with a key derived from SESSION_SECRET ----
const key = () => crypto.createHash('sha256').update('stagr-integrations:' + appKey()).digest();
export function seal(obj) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv); const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]); return [iv, c.getAuthTag(), ct].map(b => b.toString('base64url')).join('.'); }
export function unseal(s) { try { const [iv, tag, ct] = String(s).split('.').map(x => Buffer.from(x, 'base64url')); const d = crypto.createDecipheriv('aes-256-gcm', key(), iv); d.setAuthTag(tag); return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8')); } catch { return null; } }

async function sq(accessToken, method, path, body) {
  let r; try { r = await fetch(apiBase() + path, { method, headers: { authorization: 'Bearer ' + accessToken, 'content-type': 'application/json', 'square-version': SQ_VERSION }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) }); }
  catch { throw new HttpError(502, 'Could not reach Square. Try again in a minute.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = (j.errors && j.errors[0]) || {}; const err = new HttpError(r.status === 401 ? 401 : 502, 'Square said: ' + clean(e.detail || e.code || ('error ' + r.status), 160)); err.square = e.code || ''; throw err; }
  return j;
}
// The connected account for a business, refreshing an OAuth token that is close to expiring. Returns null when not connected.
export async function squareFor(tid) {
  const [row] = await sql`SELECT secret_enc, meta FROM integrations WHERE tenant_id = ${tid} AND provider = 'square'`; if (!row) return null;
  let s = unseal(row.secret_enc); if (!s || !s.access_token) return null;
  if (s.refresh_token && s.expires_at && new Date(s.expires_at).getTime() - Date.now() < 7 * 864e5 && oauthReady()) {
    try {
      const r = await fetch(apiBase() + '/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/json', 'square-version': SQ_VERSION }, body: JSON.stringify({ client_id: process.env.SQUARE_APP_ID, client_secret: process.env.SQUARE_APP_SECRET, grant_type: 'refresh_token', refresh_token: s.refresh_token }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.access_token) { s = { ...s, access_token: j.access_token, refresh_token: j.refresh_token || s.refresh_token, expires_at: j.expires_at }; await sql`UPDATE integrations SET secret_enc = ${seal(s)} WHERE tenant_id = ${tid} AND provider = 'square'`; }
    } catch { /* keep using the current token until it really expires */ }
  }
  return { ...s, ...(row.meta || {}) };
}
// Pick the location that will take the money: the first active one that can take cards.
async function saveConnection(tid, secrets, mode) {
  const { locations = [] } = await sq(secrets.access_token, 'GET', '/v2/locations');
  const usable = locations.filter(l => l.status === 'ACTIVE'), loc = usable.find(l => (l.capabilities || []).includes('CREDIT_CARD_PROCESSING')) || null;
  if (!loc) throw bad(usable.length ? 'That Square account cannot take card payments yet. Finish activating it in Square, then connect again.' : 'That Square account has no active location.');
  if (loc.currency && loc.currency !== 'USD') throw bad('STAGR takes card payments in US dollars only for now.');
  const meta = { mode, merchant_id: loc.merchant_id || '', location_id: loc.id, location_name: clean(loc.business_name || loc.name, 80), currency: loc.currency || 'USD', sandbox: sandbox(), connected_at: new Date().toISOString() };
  await sql`INSERT INTO integrations (tenant_id, provider, secret_enc, meta) VALUES (${tid}, 'square', ${seal(secrets)}, ${meta}) ON CONFLICT (tenant_id, provider) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, meta = EXCLUDED.meta`;
  return meta;
}

// ---- connect / disconnect (owner only: this decides where the business's money goes) ----
route('GET', '/api/square', async ctx => {
  need(ctx, 'admin'); const [row] = await sql`SELECT meta FROM integrations WHERE tenant_id = ${ctx.tid} AND provider = 'square'`;
  return { connected: !!row, oauth_available: oauthReady(), sandbox: sandbox(), location_name: row ? row.meta.location_name : '', connected_at: row ? row.meta.connected_at : null, mode: row ? row.meta.mode : '' };
});
route('POST', '/api/square/token', async ctx => {
  need(ctx, 'owner'); const t = String(ctx.body.access_token || '').trim(); if (t.length < 20 || t.length > 400 || /\s/.test(t)) throw bad('Paste the access token from your Square developer dashboard');
  let meta; try { meta = await saveConnection(ctx.tid, { access_token: t }, 'token'); } catch (e) { if (e.status === 401) throw bad('Square did not accept that access token. Copy it again from Square and paste it here.'); throw e; }
  await logActivity(ctx.tid, null, 'settings', 'Square card payments connected', ctx.user.id);
  return { connected: true, location_name: meta.location_name };
});
const signState = o => { const b = Buffer.from(JSON.stringify(o)).toString('base64url'); return b + '.' + crypto.createHmac('sha256', key()).update(b).digest('base64url'); };
const readState = s => { const [b, sig] = String(s || '').split('.'); if (!b || !sig) return null; const want = crypto.createHmac('sha256', key()).update(b).digest('base64url'); if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null; try { const o = JSON.parse(Buffer.from(b, 'base64url').toString()); return o.exp > Date.now() ? o : null; } catch { return null; } };
route('GET', '/api/square/oauth/start', async ctx => {
  need(ctx, 'owner'); if (!oauthReady()) throw bad('Square sign-in is not set up on this STAGR server yet');
  const state = signState({ tid: ctx.tid, uid: ctx.user.id, exp: Date.now() + 15 * 60e3, n: token(8) });
  return { url: `${apiBase()}/oauth2/authorize?client_id=${encodeURIComponent(process.env.SQUARE_APP_ID)}&scope=${encodeURIComponent(SCOPES)}&session=false&state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(baseUrl(ctx.req) + '/api/square/oauth/callback')}` };
});
// Square sends the owner back here. The signed state says which business started it; nothing is taken from the cookie.
route('GET', '/api/square/oauth/callback', { public: true }, async ctx => {
  const back = msg => ({ __raw: true, status: 302, headers: { location: baseUrl(ctx.req) + '/app#/settings?square=' + encodeURIComponent(msg) }, body: '' });
  const st = readState(ctx.query.state); if (!st) return back('expired');
  if (ctx.query.error || !ctx.query.code) return back('declined');
  try {
    const r = await fetch(apiBase() + '/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/json', 'square-version': SQ_VERSION }, body: JSON.stringify({ client_id: process.env.SQUARE_APP_ID, client_secret: process.env.SQUARE_APP_SECRET, code: String(ctx.query.code), grant_type: 'authorization_code', redirect_uri: baseUrl(ctx.req) + '/api/square/oauth/callback' }) });
    const j = await r.json().catch(() => ({})); if (!r.ok || !j.access_token) return back('failed');
    const [u] = await sql`SELECT id FROM users WHERE id = ${st.uid} AND tenant_id = ${st.tid} AND role = 'owner' AND active`; if (!u) return back('failed');
    await saveConnection(st.tid, { access_token: j.access_token, refresh_token: j.refresh_token || '', expires_at: j.expires_at || null }, 'oauth');
    await logActivity(st.tid, null, 'settings', 'Square card payments connected', st.uid);
    return back('connected');
  } catch (e) { return back(e instanceof HttpError && e.status === 400 ? 'notready' : 'failed'); }
});
route('DELETE', '/api/square', async ctx => {
  need(ctx, 'owner'); await sql`DELETE FROM integrations WHERE tenant_id = ${ctx.tid} AND provider = 'square'`;
  await logActivity(ctx.tid, null, 'settings', 'Square card payments disconnected', ctx.user.id); return { connected: false };
});

// ---- checkout ----
const cents = n => Math.round(Number(n) * 100);
async function startCheckout(ctx, { tid, kind, invoiceId = null, quoteId = null, amount, name, returnPath, customerId }) {
  await checkLockout(['pay-ip:' + ctx.ip]); await recordFail(['pay-ip:' + ctx.ip]);
  const conn = await squareFor(tid); if (!conn) throw bad('Online card payment is not available for this business');
  if (!(amount >= 1)) throw bad('Card payments start at $1.00');
  // a customer tapping Pay twice gets the same checkout page, not two charges
  const [open] = await sql`SELECT url FROM card_checkouts WHERE tenant_id = ${tid} AND kind = ${kind} AND COALESCE(invoice_id, 0) = ${invoiceId || 0} AND COALESCE(quote_id, 0) = ${quoteId || 0} AND amount = ${amount} AND status = 'pending' AND created_at > now() - interval '45 minutes' ORDER BY id DESC LIMIT 1`;
  if (open) return { url: open.url };
  const ref = token(12);
  const j = await sq(conn.access_token, 'POST', '/v2/online-checkout/payment-links', {
    idempotency_key: ref, quick_pay: { name: clean(name, 120), price_money: { amount: cents(amount), currency: 'USD' }, location_id: conn.location_id },
    checkout_options: { redirect_url: baseUrl(ctx.req) + returnPath, ask_for_shipping_address: false }, payment_note: clean('STAGR ' + name, 200) });
  const link = j.payment_link || {}; if (!link.url || !link.order_id) throw new HttpError(502, 'Square did not return a checkout page. Try again.');
  await sql`INSERT INTO card_checkouts (tenant_id, kind, invoice_id, quote_id, amount, order_id, link_id, url) VALUES (${tid}, ${kind}, ${invoiceId}, ${quoteId}, ${amount}, ${link.order_id}, ${link.id || ''}, ${link.url})`;
  await logActivity(tid, customerId, 'payment', `Customer opened card checkout for ${name}`);
  return { url: link.url };
}
// Ask Square whether a checkout was paid and, if so, record it. Safe to call any number of times.
async function settle(c, conn) {
  let order; try { order = (await sq(conn.access_token, 'GET', '/v2/orders/' + encodeURIComponent(c.order_id))).order; } catch { return false; }
  const tendered = ((order && order.tenders) || []).reduce((a, t) => a + Number((t.amount_money || {}).amount || 0), 0);
  await sql`UPDATE card_checkouts SET checked_at = now() WHERE id = ${c.id} AND tenant_id = ${c.tenant_id}`;
  if (!order || tendered < cents(c.amount)) return false;
  const [won] = await sql`UPDATE card_checkouts SET status = 'paid' WHERE id = ${c.id} AND tenant_id = ${c.tenant_id} AND status = 'pending' RETURNING id`; if (!won) return true; // someone else is recording it
  if (c.kind === 'invoice') {
    const [inv] = await sql`SELECT * FROM invoices WHERE id = ${c.invoice_id} AND tenant_id = ${c.tenant_id}`; if (!inv) return true;
    const pay = Math.min(Number(c.amount), shapeInvoice(inv).balance);
    if (pay > 0) await addPayment(c.tenant_id, inv, { amount: pay, method: 'card', note: 'Paid online by card (Square)', provider_id: 'sq:' + c.order_id });
    if (pay < Number(c.amount)) await logActivity(c.tenant_id, inv.customer_id, 'payment', `Card payment of $${Number(c.amount).toFixed(2)} was more than the balance on INV-${inv.number}. Refund the difference in Square.`);
    await notify(c.tenant_id, { title: 'Invoice paid', body: `INV-${inv.number}: $${Number(c.amount).toFixed(2)} by card`, path: '/invoices/' + inv.id });
  } else {
    const [q] = await sql`UPDATE quotes SET deposit_paid_at = COALESCE(deposit_paid_at, now()), deposit_paid_method = 'card' WHERE id = ${c.quote_id} AND tenant_id = ${c.tenant_id} RETURNING id, number, customer_id`;
    if (q) { await logActivity(c.tenant_id, q.customer_id, 'quote', `Deposit of $${Number(c.amount).toFixed(2)} paid online by card on Q-${q.number}`); await notify(c.tenant_id, { title: 'Deposit paid', body: `Q-${q.number}: $${Number(c.amount).toFixed(2)} by card`, path: '/quotes/' + q.id }); }
  }
  return true;
}
// Called when the customer's page loads and from the scheduled job. Only does work when a checkout is waiting.
export async function settlePending(tid, { invoiceId = null, quoteId = null } = {}) {
  const rows = invoiceId ? await sql`SELECT * FROM card_checkouts WHERE tenant_id = ${tid} AND invoice_id = ${invoiceId} AND status = 'pending' AND created_at > now() - interval '3 days'`
    : quoteId ? await sql`SELECT * FROM card_checkouts WHERE tenant_id = ${tid} AND quote_id = ${quoteId} AND status = 'pending' AND created_at > now() - interval '3 days'`
    : await sql`SELECT * FROM card_checkouts WHERE tenant_id = ${tid} AND status = 'pending' AND created_at > now() - interval '3 days' AND (checked_at IS NULL OR checked_at < now() - interval '10 minutes') LIMIT 40`;
  if (!rows.length) return 0;
  const conn = await squareFor(tid); if (!conn) return 0;
  let n = 0; for (const c of rows) if (await settle(c, conn)) n++;
  if (!invoiceId && !quoteId) await sql`UPDATE card_checkouts SET status = 'expired' WHERE tenant_id = ${tid} AND status = 'pending' AND created_at < now() - interval '3 days'`;
  return n;
}
export const cardReady = async tid => { const [r] = await sql`SELECT 1 FROM integrations WHERE tenant_id = ${tid} AND provider = 'square'`; return !!r; };

route('POST', '/api/public/i/:token/pay', { public: true }, async ctx => {
  const [i] = await sql`SELECT * FROM invoices WHERE token = ${clean(ctx.params.token, 80)}`; if (!i || i.status === 'draft' || i.status === 'void') throw missing('Invoice not found');
  await settlePending(i.tenant_id, { invoiceId: i.id });
  const [fresh] = await sql`SELECT * FROM invoices WHERE id = ${i.id} AND tenant_id = ${i.tenant_id}`, s = shapeInvoice(fresh); if (!(s.balance > 0)) throw bad('This invoice is already paid');
  return startCheckout(ctx, { tid: i.tenant_id, kind: 'invoice', invoiceId: i.id, amount: s.balance, name: 'Invoice ' + s.label, returnPath: '/i/' + i.token + '?paid=1', customerId: i.customer_id });
});
route('POST', '/api/public/q/:token/pay-deposit', { public: true }, async ctx => {
  const [q] = await sql`SELECT * FROM quotes WHERE token = ${clean(ctx.params.token, 80)}`; if (!q || q.status === 'draft') throw missing('Quote not found');
  if (q.status !== 'approved') throw bad('Approve the quote first');
  await settlePending(q.tenant_id, { quoteId: q.id });
  const [fresh] = await sql`SELECT * FROM quotes WHERE id = ${q.id} AND tenant_id = ${q.tenant_id}`, s = shapeQuote(fresh);
  if (fresh.deposit_paid_at) throw bad('The deposit is already paid'); if (!(s.deposit_due > 0)) throw bad('This quote has no deposit');
  return startCheckout(ctx, { tid: q.tenant_id, kind: 'deposit', quoteId: q.id, amount: s.deposit_due, name: 'Deposit for quote ' + s.label, returnPath: '/q/' + q.token + '?paid=1', customerId: q.customer_id });
});
