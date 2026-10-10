// Review requests: ask a customer for a Google review by text, by hand or automatically after a visit is completed.
import crypto from 'node:crypto';
import { route } from '../router.js';
import { sql } from '../db.js';
import { bad, missing, HttpError } from '../http.js';
import { need } from '../auth.js';
import { clean, nextLocalHour } from '../util.js';
import { logActivity } from './activity.js';
import { getCustomer } from './customers.js';
import { queueMessage, baseUrl, fill, fmtPhone, T } from './comms.js';

const DAY = 864e5;
export const GOOGLE_HOSTS = ['google.com', 'g.page', 'goo.gl', 'g.co'];
// A Google review link is a normal https link on one of Google's own domains (g.page/..., search.google.com/local/writereview?placeid=..., maps.app.goo.gl/...).
export function checkReviewLink(raw) {
  const v = clean(raw, 300); if (!v) return '';
  let u; try { u = new URL(v); } catch { throw bad('That is not a web link. Paste the full link, starting with https://'); }
  if (u.protocol !== 'https:') throw bad('The link must start with https://');
  const host = u.hostname.toLowerCase();
  if (!GOOGLE_HOSTS.some(h => host === h || host.endsWith('.' + h))) throw bad('That does not look like a Google review link. It should be on google.com, g.page or maps.app.goo.gl. In Google Business Profile, choose “Ask for reviews” and copy the link.');
  return u.toString();
}
export const DELAYS = [[0, 'Right away'], [1, '1 hour later'], [2, '2 hours later'], [4, '4 hours later'], [24, '1 day later'], [48, '2 days later'], [72, '3 days later']];
const getAuto = async tid => {
  await sql`INSERT INTO automations (tenant_id, kind, enabled, config) VALUES (${tid}, 'review_request', false, ${{ delay_mode: 'hours', delay_hours: 2, min_gap_days: 60, template: T.review_request }}) ON CONFLICT (tenant_id, kind) DO NOTHING`;
  const [a] = await sql`SELECT * FROM automations WHERE tenant_id = ${tid} AND kind = 'review_request'`; return a;
};
const linkOf = t => (t.settings || {}).review_link || '';
const texting = () => !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
export const reviewText = (template, t, customer, link) => {
  let text = fill(template || T.review_request, { first: (customer.name || '').split(' ')[0], business: t.name, city: t.city || '', phone: fmtPhone(t.phone), review_link: link });
  if (!text.includes(link)) text += ' ' + link;
  return text;
};

route('GET', '/api/reviews', async ctx => {
  const [t] = await sql`SELECT * FROM tenants WHERE id = ${ctx.tid}`, a = await getAuto(ctx.tid);
  const [st] = await sql`SELECT count(*) FILTER (WHERE status <> 'blocked')::int AS total, count(*) FILTER (WHERE status = 'delivered')::int AS delivered, count(*) FILTER (WHERE status = 'failed')::int AS failed FROM messages WHERE tenant_id = ${ctx.tid} AND kind = 'review_request'`;
  return { link: linkOf(t), enabled: a.enabled, config: a.config, default_template: T.review_request, delays: DELAYS, sms_connected: texting(), stats: st };
});
route('PUT', '/api/reviews', async ctx => {
  need(ctx, 'admin'); const b = ctx.body, [t] = await sql`SELECT * FROM tenants WHERE id = ${ctx.tid}`, a = await getAuto(ctx.tid), cfg = { ...a.config };
  let link = linkOf(t); if (b.link !== undefined) link = checkReviewLink(b.link);
  if (b.template !== undefined) { const tpl = clean(b.template, 500); if (tpl.length < 10) throw bad('The message is too short'); if (!tpl.includes('{review_link}')) throw bad('Put {review_link} in the message so the customer gets your link'); cfg.template = tpl; }
  if (b.delay_mode !== undefined) cfg.delay_mode = b.delay_mode === 'next_morning' ? 'next_morning' : 'hours';
  if (b.delay_hours !== undefined) { const h = Number(b.delay_hours); if (!DELAYS.some(d => d[0] === h)) throw bad('Pick one of the delay choices'); cfg.delay_hours = h; }
  if (b.min_gap_days !== undefined) cfg.min_gap_days = Math.max(1, Math.min(365, Math.round(Number(b.min_gap_days)) || 60));
  const enabled = b.enabled === undefined ? a.enabled : !!b.enabled;
  if (enabled && !link) throw bad('Add your Google review link before turning on automatic requests');
  await sql`UPDATE tenants SET settings = ${{ ...(t.settings || {}), review_link: link }} WHERE id = ${ctx.tid}`;
  const [u] = await sql`UPDATE automations SET enabled = ${enabled}, config = ${cfg} WHERE id = ${a.id} AND tenant_id = ${ctx.tid} RETURNING enabled, config`;
  return { link, enabled: u.enabled, config: u.config };
});

// Send one by hand. If this customer already got one recently, ask first (force: true sends anyway).
route('POST', '/api/customers/:id/review-request', async ctx => {
  const c = await getCustomer(ctx.tid, ctx.params.id), [t] = await sql`SELECT * FROM tenants WHERE id = ${ctx.tid}`, link = linkOf(t), a = await getAuto(ctx.tid);
  if (!link) throw bad('Add your Google review link in Settings first');
  if (!c.phone) throw bad('This customer has no phone number');
  const [recent] = await sql`SELECT created_at FROM messages WHERE tenant_id = ${ctx.tid} AND customer_id = ${c.id} AND kind = 'review_request' AND status <> 'blocked' AND created_at > now() - interval '14 days' ORDER BY created_at DESC LIMIT 1`;
  if (recent && ctx.body.force !== true) { const e = new HttpError(409, 'This customer was already asked for a review in the last 14 days.'); e.recent = recent.created_at; throw e; }
  let visitId = null, jobId = null;
  if (ctx.body.visit_id) { const [v] = await sql`SELECT v.id, v.job_id FROM visits v JOIN jobs j ON j.id = v.job_id AND j.tenant_id = v.tenant_id WHERE v.id = ${Number(ctx.body.visit_id) || 0} AND v.tenant_id = ${ctx.tid} AND j.customer_id = ${c.id}`; if (!v) throw bad('That visit does not belong to this customer'); visitId = v.id; jobId = v.job_id; }
  else if (ctx.body.job_id) { const [j] = await sql`SELECT id FROM jobs WHERE id = ${Number(ctx.body.job_id) || 0} AND tenant_id = ${ctx.tid} AND customer_id = ${c.id}`; if (!j) throw bad('That job does not belong to this customer'); jobId = j.id; }
  const custom = clean(ctx.body.body, 600), text = custom ? (custom.includes(link) ? custom : custom + ' ' + link) : reviewText(a.config.template, t, c, link);
  const message = await queueMessage({ tid: ctx.tid, customer: c, channel: 'sms', kind: 'review_request', body: text, visit_id: visitId, job_id: jobId });
  await logActivity(ctx.tid, c.id, 'review', message.status === 'blocked' ? `Review request not sent: ${message.error}` : 'Review request sent' + (message.status === 'preview' ? ' (preview only)' : ''), ctx.user.id);
  return { message };
});
// The text for a customer, filled in, so the owner can read and edit it before sending.
route('GET', '/api/customers/:id/review-request/preview', async ctx => {
  const c = await getCustomer(ctx.tid, ctx.params.id), [t] = await sql`SELECT * FROM tenants WHERE id = ${ctx.tid}`, a = await getAuto(ctx.tid), link = linkOf(t);
  return { has_link: !!link, has_phone: !!c.phone, opted_out: !!(c.sms_opt_out_at && !c.sms_opt_in), text: link ? reviewText(a.config.template, t, c, link) + ' Reply STOP to opt out.' : '' };
});

// Automatic: once a visit is completed and the chosen wait has passed, text the customer. Safe to run any time, any number of times.
export async function runReviewRequests(tid, base = '', now = new Date()) {
  const a = await getAuto(tid); if (!a.enabled) return { made: 0 };
  const [t] = await sql`SELECT * FROM tenants WHERE id = ${tid}`, link = linkOf(t); if (!link) return { made: 0 };
  const cfg = a.config, gap = new Date(now.getTime() - (cfg.min_gap_days || 60) * DAY);
  const rows = await sql`SELECT v.id, v.job_id, v.completed_at, j.customer_id FROM visits v JOIN jobs j ON j.id = v.job_id AND j.tenant_id = v.tenant_id
    WHERE v.tenant_id = ${tid} AND v.status = 'completed' AND v.completed_at IS NOT NULL AND v.completed_at >= ${new Date(now.getTime() - 7 * DAY)} ORDER BY v.completed_at`;
  let made = 0;
  for (const v of rows) {
    const done = new Date(v.completed_at), due = cfg.delay_mode === 'next_morning' ? nextLocalHour(done, t.timezone, 9) : new Date(done.getTime() + (Number(cfg.delay_hours) || 0) * 3600e3);
    if (due > now) continue;
    const [dup] = await sql`SELECT 1 FROM messages WHERE tenant_id = ${tid} AND customer_id = ${v.customer_id} AND kind = 'review_request' AND status <> 'blocked' AND created_at > ${gap} LIMIT 1`;
    if (dup) continue;
    const [c] = await sql`SELECT * FROM customers WHERE id = ${v.customer_id} AND tenant_id = ${tid}`; if (!c) continue;
    const m = await queueMessage({ tid, customer: c, channel: 'sms', kind: 'review_request', body: reviewText(cfg.template, t, c, link), ref: `review:${v.id}`, visit_id: v.id, job_id: v.job_id });
    if (m) { made++; await logActivity(tid, c.id, 'review', m.status === 'blocked' ? `Review request not sent: ${m.error}` : 'Review request sent automatically' + (m.status === 'preview' ? ' (preview only)' : '')); }
  }
  return { made };
}

// Twilio tells us what happened to each text (sent, delivered, failed). We check Twilio's signature so nobody else can post here.
const RANK = { queued: 0, accepted: 0, sending: 1, sent: 2, delivered: 3, read: 3 };
export function twilioSignature(token, url, params) {
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('');
  return crypto.createHmac('sha1', token).update(data).digest('base64');
}
route('POST', '/api/webhooks/twilio', { public: true, raw: true }, async ctx => {
  const token = process.env.TWILIO_AUTH_TOKEN; if (!token) throw new HttpError(404, 'Not found');
  const chunks = []; let size = 0; for await (const c of ctx.req) { size += c.length; if (size > 1e5) throw bad('Too large'); chunks.push(c); }
  const params = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
  const want = Buffer.from(twilioSignature(token, baseUrl(ctx.req) + '/api/webhooks/twilio', params)), got = Buffer.from(String(ctx.req.headers['x-twilio-signature'] || ''));
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw new HttpError(403, 'Bad signature');
  const sid = clean(params.MessageSid || params.SmsSid, 80), st = clean(params.MessageStatus || params.SmsStatus, 20).toLowerCase(); if (!sid || !st) return { ok: true };
  const [m] = await sql`SELECT id, tenant_id, status, delivery_status FROM messages WHERE provider_id = ${sid}`; if (!m) return { ok: true };
  const fail = st === 'failed' || st === 'undelivered';
  if (fail && m.status !== 'delivered') await sql`UPDATE messages SET status = 'failed', delivery_status = ${st}, error = ${'Carrier reported ' + st + (params.ErrorCode ? ' (error ' + clean(params.ErrorCode, 10) + ')' : '')} WHERE id = ${m.id} AND tenant_id = ${m.tenant_id}`;
  else if (!fail && (RANK[st] ?? -1) > (RANK[m.delivery_status] ?? -1)) await sql`UPDATE messages SET delivery_status = ${st}, status = ${st === 'delivered' || st === 'read' ? 'delivered' : m.status}, delivered_at = ${st === 'delivered' || st === 'read' ? new Date() : null}, error = '' WHERE id = ${m.id} AND tenant_id = ${m.tenant_id}`;
  return { ok: true };
});
