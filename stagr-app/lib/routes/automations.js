import { route } from '../router.js';
import { sql } from '../db.js';
import { HttpError } from '../http.js';
import { need } from '../auth.js';
import { queueMessage, baseUrl, fill, fmtPhone } from './comms.js';
import { shapeInvoice } from './shapes.js';
import { runReviewRequests } from './reviews.js';

const DAY = 864e5;
// Creates the messages that are due for ONE business. Every message has a unique "ref", so running this
// again (or from two places at once) never sends the same message twice.
export async function runAutomations(tid, base = '', now = new Date()) {
  const [t] = await sql`SELECT * FROM tenants WHERE id = ${tid}`; if (!t) return { made: 0 };
  const autos = Object.fromEntries((await sql`SELECT * FROM automations WHERE tenant_id = ${tid}`).map(a => [a.kind, a]));
  const biz = { business: t.name, phone: fmtPhone(t.phone), city: t.city || 'your area', review_link: (t.settings || {}).review_link || '' };
  const custs = new Map(); const getC = async id => { if (!custs.has(id)) custs.set(id, (await sql`SELECT * FROM customers WHERE id = ${id} AND tenant_id = ${tid}`)[0] || null); return custs.get(id); };
  let made = 0;
  const push = async (customer, kind, ref, body, channel = 'sms') => { if (!customer) return; const r = await queueMessage({ tid, customer, channel, kind, body, ref, subject: `A message from ${t.name}` }); if (r) made++; };
  const when = d => new Intl.DateTimeFormat('en-US', { timeZone: t.timezone, weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(d));
  const on = k => autos[k] && autos[k].enabled, cfg = k => autos[k].config;

  if (on('appointment_reminder')) {
    const hrs = cfg('appointment_reminder').hours_before || 24;
    const rows = await sql`SELECT v.id, v.starts_at, j.customer_id, p.address FROM visits v JOIN jobs j ON j.id = v.job_id AND j.tenant_id = v.tenant_id LEFT JOIN properties p ON p.id = j.property_id AND p.tenant_id = j.tenant_id
      WHERE v.tenant_id = ${tid} AND v.status = 'scheduled' AND j.status = 'active' AND v.starts_at > ${now} AND v.starts_at <= ${new Date(now.getTime() + hrs * 3600e3)}`;
    for (const r of rows) { const c = await getC(r.customer_id); await push(c, 'appointment_reminder', `appt:${r.id}:${new Date(r.starts_at).getTime()}`, fill(cfg('appointment_reminder').template, { ...biz, first: (c?.name || '').split(' ')[0], when: when(r.starts_at), where: r.address ? ' at ' + r.address : '' })); }
  }
  if (on('quote_followup')) {
    const c0 = cfg('quote_followup'), step = (c0.days_after || 2) * DAY, max = c0.max_sends || 2;
    const rows = await sql`SELECT * FROM quotes WHERE tenant_id = ${tid} AND status = 'sent' AND sent_at IS NOT NULL AND sent_at <= ${new Date(now.getTime() - step)}`;
    for (const q of rows) { const n = Math.min(max, Math.floor((now - new Date(q.sent_at)) / step)); if (n < 1) continue; const c = await getC(q.customer_id);
      await push(c, 'quote_followup', `quote:${q.id}:${n}`, fill(c0.template, { ...biz, first: (c?.name || '').split(' ')[0], link: (base || '') + '/q/' + q.token })); }
  }
  if (on('invoice_reminder')) {
    const c0 = cfg('invoice_reminder'), step = (c0.days_between || 7) * DAY, max = c0.max_sends || 4;
    const rows = await sql`SELECT * FROM invoices WHERE tenant_id = ${tid} AND status IN ('sent', 'partial') AND sent_at IS NOT NULL AND sent_at <= ${new Date(now.getTime() - step)}`;
    for (const i of rows) { const s = shapeInvoice(i); if (s.balance <= 0) continue; const n = Math.min(max, Math.floor((now - new Date(i.sent_at)) / step)); if (n < 1) continue; const c = await getC(i.customer_id);
      await push(c, 'invoice_reminder', `inv:${i.id}:${n}`, fill(c0.template, { ...biz, first: (c?.name || '').split(' ')[0], number: 'INV-' + i.number, balance: '$' + s.balance.toFixed(2), link: (base || '') + '/i/' + i.token })); }
  }
  if (on('monthly_followup')) {
    const c0 = cfg('monthly_followup'), since = new Date(now.getTime() - (c0.days_since_last_job || 30) * DAY), gap = new Date(now.getTime() - (c0.min_gap_days || 30) * DAY);
    const rows = await sql`SELECT c.* FROM customers c WHERE c.tenant_id = ${tid} AND c.sms_opt_in AND NOT c.archived AND c.phone <> ''
      AND EXISTS (SELECT 1 FROM visits v JOIN jobs j ON j.id = v.job_id AND j.tenant_id = v.tenant_id WHERE j.customer_id = c.id AND v.tenant_id = c.tenant_id AND v.status = 'completed' AND v.starts_at <= ${since})
      AND NOT EXISTS (SELECT 1 FROM visits v JOIN jobs j ON j.id = v.job_id AND j.tenant_id = v.tenant_id WHERE j.customer_id = c.id AND v.tenant_id = c.tenant_id AND (v.status = 'scheduled' OR (v.status = 'completed' AND v.starts_at > ${since})))
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id = c.tenant_id AND m.customer_id = c.id AND m.kind = 'monthly_followup' AND m.created_at > ${gap}) LIMIT 200`;
    for (const c of rows) await push(c, 'monthly_followup', `monthly:${c.id}:${now.toISOString().slice(0, 7)}`, fill(c0.template, { ...biz, first: c.name.split(' ')[0], discount: c0.discount || '$50' }));
  }
  made += (await runReviewRequests(tid, base, now)).made;
  await sql`UPDATE automations SET last_run_at = ${now} WHERE tenant_id = ${tid}`;
  return { made };
}
route('POST', '/api/automations/run', async ctx => { need(ctx, 'admin'); return runAutomations(ctx.tid, baseUrl(ctx.req)); });
// Called on a schedule (Vercel Cron) with the CRON_SECRET. Runs every business.
route('GET', '/api/cron/run', { public: true }, async ctx => {
  const secret = process.env.CRON_SECRET, auth = String(ctx.req.headers.authorization || '');
  if (!secret || auth !== 'Bearer ' + secret) throw new HttpError(401, 'Not allowed');
  let made = 0; for (const t of await sql`SELECT id FROM tenants`) made += (await runAutomations(t.id, baseUrl(ctx.req))).made; return { made };
});
