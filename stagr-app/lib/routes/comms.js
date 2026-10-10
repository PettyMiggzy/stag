import { route } from '../router.js';
import { sql } from '../db.js';
import { bad, missing, HttpError } from '../http.js';
import { need } from '../auth.js';
import { clean, phone as cleanPhone } from '../util.js';
import { shapeInvoice } from './shapes.js';

export const baseUrl = req => (process.env.PUBLIC_URL || (req ? `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}` : '')).replace(/\/$/, '');

// ---- automations: each business turns these on or off and edits the wording ----
export const T = {
  appointment_reminder: 'Hi {first}, this is {business}. A reminder that your appointment is {when}{where}. Reply or call {phone} to reschedule.',
  quote_followup: 'Hi {first}, just checking in on the quote from {business}. You can look it over and approve it here: {link}',
  invoice_reminder: 'Hi {first}, a friendly reminder that invoice {number} from {business} ({balance} due) is waiting: {link}',
  monthly_followup: '{business} is back in {city}! Book today and get {discount} off your next service. Reply to this text or call {phone} to schedule.',
  review_request: 'Hi {first}, thanks for choosing {business}! If you have a minute, we would really appreciate a Google review: {review_link}'
};
export const DEFAULT_AUTOMATIONS = [
  ['appointment_reminder', true, { hours_before: 24, template: T.appointment_reminder }],
  ['quote_followup', true, { days_after: 2, max_sends: 2, template: T.quote_followup }],
  ['invoice_reminder', true, { days_between: 7, max_sends: 4, template: T.invoice_reminder }],
  ['monthly_followup', false, { discount: '$50', days_since_last_job: 30, min_gap_days: 30, template: T.monthly_followup }],
  ['review_request', false, { delay_mode: 'hours', delay_hours: 2, min_gap_days: 60, template: T.review_request }]
];
const MARKETING = new Set(['monthly_followup']);
export const fill = (tpl, v) => String(tpl).replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '').replace(/\s+([.,!?])/g, '$1').replace(/ {2,}/g, ' ').trim();

// ---- delivery. Without a provider connected, messages are saved as "preview" and nothing is sent. ----
async function deliver(m, tenant) {
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM;
  if (m.channel === 'sms' && sid && tok && from) {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ To: '+1' + m.to_addr, From: from, Body: m.body, ...(process.env.PUBLIC_URL ? { StatusCallback: process.env.PUBLIC_URL.replace(/\/$/, '') + '/api/webhooks/twilio' } : {}) }) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { status: 'sent', provider_id: j.sid || '' } : { status: 'failed', error: String(j.message || r.status).slice(0, 200) };
  }
  if (m.channel === 'email' && process.env.RESEND_API_KEY && process.env.EMAIL_FROM) {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ from: `${tenant.name} <${process.env.EMAIL_FROM}>`, to: [m.to_addr], subject: m.subject || `A message from ${tenant.name}`, text: m.body, reply_to: tenant.email || undefined }) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { status: 'sent', provider_id: j.id || '' } : { status: 'failed', error: String(j.message || r.status).slice(0, 200) };
  }
  return { status: 'preview', provider_id: '' };
}
// Save a message and try to send it. Marketing texts need the customer's recorded opt-in and always carry an opt-out line.
export async function queueMessage({ tid, customer, channel, kind, body, ref = '', subject = '', scheduled_for = null, visit_id = null, job_id = null }) {
  const marketing = MARKETING.has(kind) || kind === 'manual_marketing';
  const to = channel === 'sms' ? customer.phone : customer.email;
  let text = String(body).slice(0, 1000);
  if (channel === 'sms' && (marketing || kind === 'review_request') && !/reply stop/i.test(text)) text += ' Reply STOP to opt out.';
  let status = 'queued', error = '';
  if (!to) { status = 'blocked'; error = channel === 'sms' ? 'No phone number' : 'No email address'; }
  else if (channel === 'sms' && customer.sms_opt_out_at && !customer.sms_opt_in) { status = 'blocked'; error = 'Customer opted out of texts'; }
  else if (channel === 'sms' && marketing && !customer.sms_opt_in) { status = 'blocked'; error = 'No text consent on file'; }
  else if (channel === 'email' && customer.email_opt_out && marketing) { status = 'blocked'; error = 'Customer opted out of email'; }
  let row;
  try { [row] = await sql`INSERT INTO messages (tenant_id, customer_id, channel, direction, kind, body, to_addr, status, error, ref, scheduled_for, visit_id, job_id) VALUES (${tid}, ${customer.id}, ${channel}, 'out', ${kind}, ${text}, ${to || ''}, ${status}, ${error}, ${ref}, ${scheduled_for || new Date()}, ${visit_id}, ${job_id}) RETURNING *`; }
  catch (e) { if (/messages_ref/.test(String(e.message))) return null; throw e; } // already queued for this ref
  if (status === 'queued' && !scheduled_for) {
    const [t] = await sql`SELECT name, email FROM tenants WHERE id = ${tid}`;
    const r = await deliver({ ...row, subject }, t);
    [row] = await sql`UPDATE messages SET status = ${r.status}, error = ${r.error || ''}, provider_id = ${r.provider_id || ''}, sent_at = ${r.status === 'sent' ? new Date() : null}, delivery_status = ${r.status === 'sent' ? 'sent' : ''} WHERE id = ${row.id} AND tenant_id = ${tid} RETURNING *`;
  }
  return row;
}

route('GET', '/api/messages', async ctx => ({ messages: await sql`SELECT m.*, c.name AS customer_name FROM messages m LEFT JOIN customers c ON c.id = m.customer_id AND c.tenant_id = m.tenant_id WHERE m.tenant_id = ${ctx.tid} ORDER BY m.created_at DESC LIMIT 200`, delivery: { sms: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM), email: !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM) } }));
route('POST', '/api/messages', async ctx => {
  const b = ctx.body, [c] = await sql`SELECT * FROM customers WHERE id = ${Number(b.customer_id) || 0} AND tenant_id = ${ctx.tid}`; if (!c) throw missing('Customer not found');
  const body = clean(b.body, 800); if (!body) throw bad('Write a message');
  const channel = b.channel === 'email' ? 'email' : 'sms';
  return { message: await queueMessage({ tid: ctx.tid, customer: c, channel, kind: b.promo ? 'manual_marketing' : 'manual', body, subject: clean(b.subject, 120) }) };
});
route('GET', '/api/automations', async ctx => ({ automations: await sql`SELECT kind, enabled, config, last_run_at FROM automations WHERE tenant_id = ${ctx.tid} ORDER BY id` }));
route('PUT', '/api/automations/:kind', async ctx => {
  need(ctx, 'admin'); const [o] = await sql`SELECT * FROM automations WHERE tenant_id = ${ctx.tid} AND kind = ${clean(ctx.params.kind, 40)}`; if (!o) throw missing('Unknown automation');
  const b = ctx.body, cfg = { ...o.config }; const num = (k, lo, hi) => { if (b.config && b.config[k] !== undefined) cfg[k] = Math.max(lo, Math.min(hi, Number(b.config[k]) || lo)); };
  num('hours_before', 1, 168); num('days_after', 0, 60); num('max_sends', 1, 10); num('days_between', 1, 60); num('days_since_last_job', 1, 365); num('min_gap_days', 1, 365);
  if (b.config && typeof b.config.template === 'string') { const t = clean(b.config.template, 500); if (t.length < 10) throw bad('The message is too short'); cfg.template = t; }
  if (b.config && b.config.discount !== undefined) cfg.discount = clean(b.config.discount, 20);
  const [a] = await sql`UPDATE automations SET enabled = ${b.enabled === undefined ? o.enabled : !!b.enabled}, config = ${cfg} WHERE id = ${o.id} AND tenant_id = ${ctx.tid} RETURNING kind, enabled, config, last_run_at`; return { automation: a };
});
// Preview the monthly offer text for this business with real values
route('POST', '/api/automations/preview', async ctx => {
  const [t] = await sql`SELECT name, phone, city FROM tenants WHERE id = ${ctx.tid}`, b = ctx.body;
  const text = fill(clean(b.template, 500) || T.monthly_followup, { business: t.name, city: t.city || 'your area', discount: clean(b.discount, 20) || '$50', phone: fmtPhone(t.phone), first: 'Sam', link: '(link)', review_link: '(review link)' });
  return { text: text + ' Reply STOP to opt out.' };
});
export const fmtPhone = p => p && p.length === 10 ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : p || '';
