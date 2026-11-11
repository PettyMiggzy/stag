// Two-way texting: customer replies land here, STOP/START are honoured, and the crew can send "on my way".
import crypto from 'node:crypto';
import { route } from '../router.js';
import { sql } from '../db.js';
import { bad, missing, HttpError } from '../http.js';
import { need } from '../auth.js';
import { clean, phone as cleanPhone } from '../util.js';
import { queueMessage, baseUrl, smsReady } from './comms.js';
import { twilioSignature } from './reviews.js';
import { logActivity } from './activity.js';
import { notify } from './devices.js';

const STOP = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout']);
const START = new Set(['start', 'unstop', 'yes']);
const xml = body => ({ __raw: true, headers: { 'content-type': 'text/xml; charset=utf-8' }, body: `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>` });

// Twilio posts every text a customer sends to the STAGR number. The signature proves it came from Twilio.
route('POST', '/api/webhooks/twilio/inbound', { public: true, raw: true }, async ctx => {
  const tok = process.env.TWILIO_AUTH_TOKEN; if (!tok) throw new HttpError(404, 'Not found');
  const chunks = []; let size = 0; for await (const c of ctx.req) { size += c.length; if (size > 1e5) throw bad('Too large'); chunks.push(c); }
  const params = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
  const want = Buffer.from(twilioSignature(tok, baseUrl(ctx.req) + '/api/webhooks/twilio/inbound', params)), got = Buffer.from(String(ctx.req.headers['x-twilio-signature'] || ''));
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw new HttpError(403, 'Bad signature');
  const from = cleanPhone(params.From), text = clean(params.Body, 1600), sid = clean(params.MessageSid || params.SmsSid, 80); if (!from || !sid) return xml('');
  const word = text.trim().toLowerCase().replace(/[^a-z]/g, '');
  // One shared number serves every business, so an opt-out applies to that phone everywhere.
  if (STOP.has(word)) await sql`UPDATE customers SET sms_opt_in = false, sms_opt_out_at = now() WHERE phone = ${from}`;
  else if (START.has(word)) await sql`UPDATE customers SET sms_opt_out_at = NULL WHERE phone = ${from} AND sms_opt_out_at IS NOT NULL`;
  // The reply belongs to the business that texted this phone most recently (or the only business that knows the number).
  let [hit] = await sql`SELECT m.tenant_id, m.customer_id FROM messages m WHERE m.channel = 'sms' AND m.direction = 'out' AND m.to_addr = ${from} AND m.customer_id IS NOT NULL ORDER BY m.created_at DESC LIMIT 1`;
  if (!hit) { const known = await sql`SELECT tenant_id, id AS customer_id FROM customers WHERE phone = ${from} AND NOT archived ORDER BY created_at DESC LIMIT 2`; if (known.length === 1) hit = known[0]; }
  if (!hit) return xml('');
  const [dup] = await sql`SELECT 1 FROM messages WHERE provider_id = ${sid} AND tenant_id = ${hit.tenant_id}`; if (dup) return xml('');
  await sql`INSERT INTO messages (tenant_id, customer_id, channel, direction, kind, body, to_addr, status, provider_id, sent_at) VALUES (${hit.tenant_id}, ${hit.customer_id}, 'sms', 'in', 'reply', ${text || '(no text)'}, ${from}, 'received', ${sid}, now())`;
  const [c] = await sql`SELECT name FROM customers WHERE id = ${hit.customer_id} AND tenant_id = ${hit.tenant_id}`;
  if (STOP.has(word)) await logActivity(hit.tenant_id, hit.customer_id, 'message', 'Customer replied STOP. Texts to them are now blocked.');
  await notify(hit.tenant_id, { title: c ? c.name : 'New text', body: text.slice(0, 120) || 'Sent a message', path: '/messages?c=' + hit.customer_id });
  return xml('');
});

// Conversations: one row per customer who has texts, newest first, with how many replies are unread.
route('GET', '/api/inbox', async ctx => {
  need(ctx, 'admin');
  const rows = await sql`SELECT DISTINCT ON (m.customer_id) m.customer_id, c.name, c.phone, c.sms_opt_out_at, m.body, m.direction, m.status, m.created_at,
      (SELECT count(*)::int FROM messages u WHERE u.tenant_id = m.tenant_id AND u.customer_id = m.customer_id AND u.direction = 'in' AND u.read_at IS NULL) AS unread
    FROM messages m JOIN customers c ON c.id = m.customer_id AND c.tenant_id = m.tenant_id
    WHERE m.tenant_id = ${ctx.tid} AND m.channel = 'sms' AND m.customer_id IS NOT NULL ORDER BY m.customer_id, m.created_at DESC`;
  rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return { conversations: rows.slice(0, 200), unread: rows.reduce((a, r) => a + r.unread, 0), sms_connected: smsReady() };
});
route('GET', '/api/inbox/:id', async ctx => {
  need(ctx, 'admin'); const id = Number(ctx.params.id) || 0;
  const [c] = await sql`SELECT id, name, phone, sms_opt_in, sms_opt_out_at FROM customers WHERE id = ${id} AND tenant_id = ${ctx.tid}`; if (!c) throw missing('Customer not found');
  const msgs = await sql`SELECT id, direction, kind, body, status, error, created_at FROM messages WHERE tenant_id = ${ctx.tid} AND customer_id = ${id} AND channel = 'sms' ORDER BY created_at DESC LIMIT 100`;
  await sql`UPDATE messages SET read_at = now() WHERE tenant_id = ${ctx.tid} AND customer_id = ${id} AND direction = 'in' AND read_at IS NULL`;
  return { customer: c, messages: msgs.reverse(), sms_connected: smsReady() };
});

// "On my way": the crew member taps it from the visit; the customer gets one text per visit per day.
route('POST', '/api/visits/:id/omw', async ctx => {
  const [v] = await sql`SELECT v.id, v.assigned, v.starts_at, j.customer_id, j.id AS job_id FROM visits v JOIN jobs j ON j.id = v.job_id AND j.tenant_id = v.tenant_id WHERE v.id = ${Number(ctx.params.id) || 0} AND v.tenant_id = ${ctx.tid}`;
  if (!v) throw missing('Visit not found');
  if (ctx.user.role === 'worker' && !v.assigned.includes(ctx.user.id)) throw new HttpError(403, 'This visit is not assigned to you');
  const [c] = await sql`SELECT * FROM customers WHERE id = ${v.customer_id} AND tenant_id = ${ctx.tid}`, [t] = await sql`SELECT name FROM tenants WHERE id = ${ctx.tid}`;
  if (!c || !c.phone) throw bad('This customer has no mobile number on file');
  const eta = Math.max(0, Math.min(180, Math.round(Number(ctx.body.eta_minutes) || 0)));
  const body = `Hi ${c.name.split(' ')[0]}, ${ctx.user.name.split(' ')[0]} from ${t.name} is on the way${eta ? ` and should arrive in about ${eta} minutes` : ''}.`;
  const m = await queueMessage({ tid: ctx.tid, customer: c, channel: 'sms', kind: 'on_my_way', body, ref: `omw:${v.id}:${new Date().toISOString().slice(0, 10)}`, visit_id: v.id, job_id: v.job_id });
  if (!m) return { already: true, status: 'sent' };
  await logActivity(ctx.tid, c.id, 'visit', `"On my way" text ${m.status === 'preview' ? 'saved (texting is not connected)' : m.status}`, ctx.user.id);
  return { status: m.status, error: m.error || '' };
});
