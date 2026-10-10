import { route } from '../router.js';
import { sql } from '../db.js';
import { bad, missing, HttpError } from '../http.js';
import { need } from '../auth.js';
import { clean, cleanItems, totals, r2 } from '../util.js';
import { logActivity } from './activity.js';
import { getCustomer } from './customers.js';
import { nextNumber } from './sales.js';
import { shapeInvoice } from './shapes.js';

// ---- time zone aware date math, so a 9:00 visit stays at 9:00 across daylight saving changes ----
const dtf = {};
function parts(date, tz) {
  const f = dtf[tz] ||= new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {}; f.formatToParts(date).forEach(x => { p[x.type] = x.value; });
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}
function fromParts(p, tz) {
  const want = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s); let guess = want;
  for (let i = 0; i < 3; i++) { const g = parts(new Date(guess), tz); guess += want - Date.UTC(g.y, g.mo - 1, g.d, g.h, g.mi, g.s); }
  return new Date(guess);
}
export function occurrence(first, rec, n, tz) {
  const p = parts(first, tz), iv = Math.max(1, Math.min(52, Number(rec.interval) || 1));
  let y = p.y, mo = p.mo, d = p.d;
  if (rec.freq === 'daily') d += n * iv; else if (rec.freq === 'weekly') d += 7 * n * iv;
  else if (rec.freq === 'monthly') { mo += n * iv; y += Math.floor((mo - 1) / 12); mo = ((mo - 1) % 12 + 12) % 12 + 1; d = Math.min(d, new Date(Date.UTC(y, mo, 0)).getUTCDate()); }
  else if (rec.freq === 'yearly') { y += n * iv; d = Math.min(d, new Date(Date.UTC(y, mo, 0)).getUTCDate()); }
  else throw bad('Repeat must be daily, weekly, monthly or yearly');
  const n2 = new Date(Date.UTC(y, mo - 1, d, p.h, p.mi, p.s));
  return fromParts({ y: n2.getUTCFullYear(), mo: n2.getUTCMonth() + 1, d: n2.getUTCDate(), h: p.h, mi: p.mi, s: p.s }, tz);
}
const cleanRec = r => {
  if (!r) return null; const freq = ['daily', 'weekly', 'monthly', 'yearly'].includes(r.freq) ? r.freq : null; if (!freq) throw bad('Choose how often the job repeats');
  const out = { freq, interval: Math.max(1, Math.min(52, Number(r.interval) || 1)), next_n: 1 };
  if (r.until && /^\d{4}-\d{2}-\d{2}$/.test(r.until)) out.until = r.until; if (Number(r.count) > 0) out.count = Math.min(520, Number(r.count));
  return out;
};
// Create future visits for a repeating job up to the horizon (default 90 days). Safe to call again and again.
export async function extendVisits(tid, jobId, horizonDays = 90) {
  const [job] = await sql`SELECT * FROM jobs WHERE id = ${jobId} AND tenant_id = ${tid}`; if (!job || !job.recurrence || job.status !== 'active') return 0;
  const [t] = await sql`SELECT timezone FROM tenants WHERE id = ${tid}`;
  const [first] = await sql`SELECT * FROM visits WHERE tenant_id = ${tid} AND job_id = ${jobId} ORDER BY starts_at LIMIT 1`; if (!first) return 0;
  const rec = job.recurrence, horizon = Date.now() + horizonDays * 864e5, dur = first.ends_at ? new Date(first.ends_at) - new Date(first.starts_at) : null;
  let n = rec.next_n || 1, made = 0;
  while (made < 200) {
    if (rec.count && n >= rec.count) break;
    const at = occurrence(new Date(first.starts_at), rec, n, t.timezone);
    if (at.getTime() > horizon || (rec.until && at.toISOString().slice(0, 10) > rec.until)) break;
    await sql`INSERT INTO visits (tenant_id, job_id, starts_at, ends_at, assigned, checklist) VALUES (${tid}, ${jobId}, ${at}, ${dur !== null ? new Date(at.getTime() + dur) : null}, ${first.assigned}, ${JSON.stringify((first.checklist || []).map(c => ({ ...c, done: false })))}::jsonb)`;
    n++; made++;
  }
  if (made) await sql`UPDATE jobs SET recurrence = ${{ ...rec, next_n: n }} WHERE id = ${jobId} AND tenant_id = ${tid}`;
  return made;
}
async function validAssigned(tid, ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger))].slice(0, 12); if (!list.length) return [];
  const rows = await sql`SELECT id FROM users WHERE tenant_id = ${tid} AND active AND id = ANY(${list})`; return rows.map(r => r.id);
}
const cleanChecklist = c => (Array.isArray(c) ? c : []).slice(0, 40).map(i => ({ text: clean(i && i.text, 120), done: !!(i && i.done) })).filter(i => i.text);
const when = d => { const x = new Date(d); return isNaN(x) ? null : x; };

route('POST', '/api/jobs', async ctx => {
  need(ctx, 'admin'); const b = ctx.body, c = await getCustomer(ctx.tid, b.customer_id);
  let pid = null; if (b.property_id) { const [p] = await sql`SELECT id FROM properties WHERE id = ${Number(b.property_id) || 0} AND tenant_id = ${ctx.tid} AND customer_id = ${c.id}`; if (!p) throw bad('That property does not belong to this customer'); pid = p.id; }
  let items = cleanItems(b.items), qid = null, title = clean(b.title, 120);
  if (b.quote_id) { const [q] = await sql`SELECT * FROM quotes WHERE id = ${Number(b.quote_id) || 0} AND tenant_id = ${ctx.tid} AND customer_id = ${c.id}`; if (!q) throw bad('Quote not found'); qid = q.id; if (!items.length) items = q.items; if (!pid) pid = q.property_id; if (!title) title = 'Job from quote Q-' + q.number; }
  if (!title) throw bad('Give the job a title');
  const rec = cleanRec(b.recurrence), n = await nextNumber(ctx.tid, 'job');
  const [job] = await sql`INSERT INTO jobs (tenant_id, number, customer_id, property_id, quote_id, title, description, items, recurrence) VALUES (${ctx.tid}, ${n}, ${c.id}, ${pid}, ${qid}, ${title}, ${clean(b.description, 4000)}, ${JSON.stringify(items)}::jsonb, ${rec ? JSON.stringify(rec) : null}::jsonb) RETURNING *`;
  const v = b.visit || {}, start = when(v.starts_at);
  if (start) {
    const end = when(v.ends_at);
    await sql`INSERT INTO visits (tenant_id, job_id, starts_at, ends_at, assigned, checklist) VALUES (${ctx.tid}, ${job.id}, ${start}, ${end}, ${await validAssigned(ctx.tid, v.assigned)}, ${JSON.stringify(cleanChecklist(v.checklist))}::jsonb)`;
    if (rec) await extendVisits(ctx.tid, job.id);
  }
  await logActivity(ctx.tid, c.id, 'job', `Job J-${n} created: ${title}`, ctx.user.id);
  return { job };
});
route('GET', '/api/jobs', async ctx => {
  const st = ['active', 'completed', 'cancelled'].includes(ctx.query.status) ? ctx.query.status : null;
  const rows = await sql`SELECT j.*, c.name AS customer_name, (SELECT min(v.starts_at) FROM visits v WHERE v.job_id = j.id AND v.tenant_id = j.tenant_id AND v.status = 'scheduled' AND v.starts_at > now() - interval '1 day') AS next_visit
    FROM jobs j JOIN customers c ON c.id = j.customer_id AND c.tenant_id = j.tenant_id WHERE j.tenant_id = ${ctx.tid} AND (${st}::text IS NULL OR j.status = ${st}) ORDER BY j.created_at DESC LIMIT 300`;
  return { jobs: rows };
});
route('GET', '/api/jobs/:id', async ctx => {
  const id = Number(ctx.params.id) || 0, tid = ctx.tid;
  const [job] = await sql`SELECT * FROM jobs WHERE id = ${id} AND tenant_id = ${tid}`; if (!job) throw missing('Job not found');
  await extendVisits(tid, id);
  const [customer, visits, invoices, expenses, time] = await Promise.all([
    sql`SELECT id, name, phone, email FROM customers WHERE id = ${job.customer_id} AND tenant_id = ${tid}`,
    sql`SELECT * FROM visits WHERE job_id = ${id} AND tenant_id = ${tid} ORDER BY starts_at`,
    sql`SELECT * FROM invoices WHERE job_id = ${id} AND tenant_id = ${tid} ORDER BY created_at`,
    sql`SELECT * FROM expenses WHERE job_id = ${id} AND tenant_id = ${tid} ORDER BY incurred_on DESC`,
    sql`SELECT COALESCE(sum(extract(epoch FROM (COALESCE(t.ended_at, now()) - t.started_at))), 0)::float AS secs FROM time_entries t JOIN visits v ON v.id = t.visit_id AND v.tenant_id = t.tenant_id WHERE v.job_id = ${id} AND t.tenant_id = ${tid}`]);
  const inv = invoices.map(shapeInvoice), revenue = r2(inv.filter(i => i.status !== 'void').reduce((a, i) => a + i.total, 0)), spent = r2(expenses.reduce((a, e) => a + Number(e.amount), 0));
  return { job, customer: customer[0], visits, invoices: inv, expenses, costing: { invoiced: revenue, collected: r2(inv.reduce((a, i) => a + i.paid, 0)), expenses: spent, profit: r2(revenue - spent), hours: r2(time[0].secs / 3600) } };
});
route('PUT', '/api/jobs/:id', async ctx => {
  need(ctx, 'admin'); const [o] = await sql`SELECT * FROM jobs WHERE id = ${Number(ctx.params.id) || 0} AND tenant_id = ${ctx.tid}`; if (!o) throw missing('Job not found'); const b = ctx.body;
  const status = ['active', 'completed', 'cancelled'].includes(b.status) ? b.status : o.status;
  const rec = b.recurrence === null ? null : b.recurrence ? { ...cleanRec(b.recurrence), next_n: (o.recurrence || {}).next_n || 1 } : o.recurrence;
  const [j] = await sql`UPDATE jobs SET title = ${clean(b.title ?? o.title, 120)}, description = ${clean(b.description ?? o.description, 4000)}, status = ${status}, recurrence = ${rec ? JSON.stringify(rec) : null}::jsonb,
    items = ${b.items !== undefined ? JSON.stringify(cleanItems(b.items)) : JSON.stringify(o.items)}::jsonb, completed_at = ${status === 'completed' && !o.completed_at ? new Date() : o.completed_at} WHERE id = ${o.id} AND tenant_id = ${ctx.tid} RETURNING *`;
  if (status === 'cancelled') await sql`UPDATE visits SET status = 'cancelled' WHERE job_id = ${o.id} AND tenant_id = ${ctx.tid} AND status = 'scheduled'`;
  return { job: j };
});
route('POST', '/api/jobs/:id/visits', async ctx => {
  need(ctx, 'admin'); const [j] = await sql`SELECT id, customer_id FROM jobs WHERE id = ${Number(ctx.params.id) || 0} AND tenant_id = ${ctx.tid}`; if (!j) throw missing('Job not found');
  const b = ctx.body, start = when(b.starts_at); if (!start) throw bad('Pick a date and time');
  const [v] = await sql`INSERT INTO visits (tenant_id, job_id, starts_at, ends_at, assigned, notes, checklist) VALUES (${ctx.tid}, ${j.id}, ${start}, ${when(b.ends_at)}, ${await validAssigned(ctx.tid, b.assigned)}, ${clean(b.notes, 2000)}, ${JSON.stringify(cleanChecklist(b.checklist))}::jsonb) RETURNING *`;
  return { visit: v };
});

route('GET', '/api/visits', async ctx => {
  const from = when(ctx.query.from) || new Date(Date.now() - 7 * 864e5), to = when(ctx.query.to) || new Date(Date.now() + 30 * 864e5);
  if (to - from > 400 * 864e5) throw bad('Date range too long');
  const mineOnly = ctx.user.role === 'worker' ? ctx.user.id : (Number(ctx.query.assigned) || null);
  // keep repeating jobs filled out as far as the calendar is looking
  const recJobs = await sql`SELECT id FROM jobs WHERE tenant_id = ${ctx.tid} AND status = 'active' AND recurrence IS NOT NULL`;
  const span = Math.max(90, Math.ceil((to - Date.now()) / 864e5) + 7);
  for (const r of recJobs) await extendVisits(ctx.tid, r.id, Math.min(span, 400));
  const rows = await sql`SELECT v.*, j.title, j.number AS job_number, j.customer_id, c.name AS customer_name, c.phone AS customer_phone, p.address, p.city
    FROM visits v JOIN jobs j ON j.id = v.job_id AND j.tenant_id = v.tenant_id JOIN customers c ON c.id = j.customer_id AND c.tenant_id = j.tenant_id LEFT JOIN properties p ON p.id = j.property_id AND p.tenant_id = j.tenant_id
    WHERE v.tenant_id = ${ctx.tid} AND v.starts_at >= ${from} AND v.starts_at < ${to} AND (${mineOnly}::int IS NULL OR ${mineOnly} = ANY(v.assigned)) ORDER BY v.starts_at LIMIT 1000`;
  return { visits: rows };
});
async function getVisit(ctx) {
  const [v] = await sql`SELECT v.*, j.customer_id, j.status AS job_status FROM visits v JOIN jobs j ON j.id = v.job_id AND j.tenant_id = v.tenant_id WHERE v.id = ${Number(ctx.params.id) || 0} AND v.tenant_id = ${ctx.tid}`;
  if (!v) throw missing('Visit not found');
  if (ctx.user.role === 'worker' && !v.assigned.includes(ctx.user.id)) throw new HttpError(403, 'This visit is not assigned to you');
  return v;
}
route('PUT', '/api/visits/:id', async ctx => {
  const o = await getVisit(ctx), b = ctx.body, admin = ctx.user.role !== 'worker';
  if (!admin && (b.starts_at !== undefined || b.ends_at !== undefined || b.assigned !== undefined)) throw new HttpError(403, 'Only managers can reschedule or reassign');
  const st = ['scheduled', 'in_progress', 'completed', 'cancelled'].includes(b.status) ? b.status : o.status;
  const [v] = await sql`UPDATE visits SET starts_at = ${b.starts_at !== undefined ? when(b.starts_at) || o.starts_at : o.starts_at}, ends_at = ${b.ends_at !== undefined ? when(b.ends_at) : o.ends_at},
    assigned = ${b.assigned !== undefined ? await validAssigned(ctx.tid, b.assigned) : o.assigned}, status = ${st}, notes = ${clean(b.notes ?? o.notes, 2000)},
    checklist = ${JSON.stringify(b.checklist !== undefined ? cleanChecklist(b.checklist) : o.checklist)}::jsonb, completed_at = ${st === 'completed' ? (o.completed_at || new Date()) : null},
    reminder_sent_at = ${b.starts_at !== undefined ? null : o.reminder_sent_at} WHERE id = ${o.id} AND tenant_id = ${ctx.tid} RETURNING *`;
  if (st === 'completed' && o.status !== 'completed') await logActivity(ctx.tid, o.customer_id, 'visit', 'Visit completed', ctx.user.id);
  return { visit: v };
});
route('DELETE', '/api/visits/:id', async ctx => { need(ctx, 'admin'); await sql`DELETE FROM visits WHERE id = ${Number(ctx.params.id) || 0} AND tenant_id = ${ctx.tid}`; return { ok: true }; });
route('POST', '/api/visits/:id/photos', async ctx => {
  const o = await getVisit(ctx), data = String(ctx.body.data || '');
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(data) || data.length > 900000) throw bad('Send a JPEG, PNG or WebP photo under 600 KB');
  if ((o.photos || []).length >= 12) throw bad('That visit already has 12 photos');
  const photos = [...(o.photos || []), { data, by: ctx.user.id, at: new Date().toISOString(), caption: clean(ctx.body.caption, 120) }];
  const [v] = await sql`UPDATE visits SET photos = ${JSON.stringify(photos)}::jsonb WHERE id = ${o.id} AND tenant_id = ${ctx.tid} RETURNING id, photos`; return { photos: v.photos };
});

// ---- time clock and expenses ----
route('POST', '/api/time/start', async ctx => {
  const [open] = await sql`SELECT id FROM time_entries WHERE tenant_id = ${ctx.tid} AND user_id = ${ctx.user.id} AND ended_at IS NULL`; if (open) throw bad('You are already clocked in');
  let vid = null; if (ctx.body.visit_id) { const [v] = await sql`SELECT id FROM visits WHERE id = ${Number(ctx.body.visit_id) || 0} AND tenant_id = ${ctx.tid}`; if (!v) throw missing('Visit not found'); vid = v.id; }
  const [t] = await sql`INSERT INTO time_entries (tenant_id, user_id, visit_id) VALUES (${ctx.tid}, ${ctx.user.id}, ${vid}) RETURNING *`; return { entry: t };
});
route('POST', '/api/time/stop', async ctx => {
  const [t] = await sql`UPDATE time_entries SET ended_at = now() WHERE tenant_id = ${ctx.tid} AND user_id = ${ctx.user.id} AND ended_at IS NULL RETURNING *`; if (!t) throw bad('You are not clocked in'); return { entry: t };
});
route('GET', '/api/time', async ctx => {
  const from = when(ctx.query.from) || new Date(Date.now() - 14 * 864e5), to = when(ctx.query.to) || new Date(Date.now() + 864e5), only = ctx.user.role === 'worker' ? ctx.user.id : null;
  const rows = await sql`SELECT t.*, u.name AS user_name, round((extract(epoch FROM (COALESCE(t.ended_at, now()) - t.started_at)) / 3600)::numeric, 2)::float AS hours FROM time_entries t JOIN users u ON u.id = t.user_id AND u.tenant_id = t.tenant_id
    WHERE t.tenant_id = ${ctx.tid} AND t.started_at >= ${from} AND t.started_at < ${to} AND (${only}::int IS NULL OR t.user_id = ${only}) ORDER BY t.started_at DESC LIMIT 500`;
  return { entries: rows, total_hours: r2(rows.reduce((a, r) => a + r.hours, 0)) };
});
route('POST', '/api/expenses', async ctx => {
  const b = ctx.body, a = Number(b.amount); if (!(a > 0 && a < 1e7)) throw bad('Enter the amount');
  let jid = null; if (b.job_id) { const [j] = await sql`SELECT id FROM jobs WHERE id = ${Number(b.job_id) || 0} AND tenant_id = ${ctx.tid}`; if (!j) throw missing('Job not found'); jid = j.id; }
  const [e] = await sql`INSERT INTO expenses (tenant_id, job_id, description, amount, incurred_on, user_id) VALUES (${ctx.tid}, ${jid}, ${clean(b.description, 200)}, ${r2(a)}, ${/^\d{4}-\d{2}-\d{2}$/.test(b.incurred_on || '') ? b.incurred_on : new Date().toISOString().slice(0, 10)}, ${ctx.user.id}) RETURNING *`; return { expense: e };
});
route('GET', '/api/expenses', async ctx => ({ expenses: await sql`SELECT * FROM expenses WHERE tenant_id = ${ctx.tid} ORDER BY incurred_on DESC, id DESC LIMIT 300` }));
route('DELETE', '/api/expenses/:id', async ctx => { need(ctx, 'admin'); await sql`DELETE FROM expenses WHERE id = ${Number(ctx.params.id) || 0} AND tenant_id = ${ctx.tid}`; return { ok: true }; });
