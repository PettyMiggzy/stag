import { route } from '../router.js';
import { sql } from '../db.js';
import { need } from '../auth.js';
import { r2, paidSum, totals } from '../util.js';
import { shapeInvoice, shapeQuote } from './shapes.js';

route('GET', '/api/dashboard', async ctx => {
  const tid = ctx.tid, worker = ctx.user.role === 'worker', now = new Date(), in7 = new Date(now.getTime() + 7 * 864e5), startDay = new Date(now.getTime() - 12 * 3600e3);
  const upcoming = await sql`SELECT v.id, v.starts_at, v.ends_at, v.status, v.assigned, j.title, j.id AS job_id, c.name AS customer_name, p.address FROM visits v JOIN jobs j ON j.id = v.job_id AND j.tenant_id = v.tenant_id JOIN customers c ON c.id = j.customer_id AND c.tenant_id = j.tenant_id LEFT JOIN properties p ON p.id = j.property_id AND p.tenant_id = j.tenant_id
    WHERE v.tenant_id = ${tid} AND v.status IN ('scheduled', 'in_progress') AND v.starts_at >= ${startDay} AND v.starts_at < ${in7} AND (${worker ? ctx.user.id : null}::int IS NULL OR ${ctx.user.id} = ANY(v.assigned)) ORDER BY v.starts_at LIMIT 50`;
  if (worker) return { upcoming };
  const [newReq, openQuotes, unpaid, doneMonth] = await Promise.all([
    sql`SELECT id, name, service, created_at FROM requests WHERE tenant_id = ${tid} AND status = 'new' ORDER BY created_at DESC LIMIT 20`,
    sql`SELECT q.*, c.name AS customer_name FROM quotes q JOIN customers c ON c.id = q.customer_id AND c.tenant_id = q.tenant_id WHERE q.tenant_id = ${tid} AND q.status = 'sent' ORDER BY q.sent_at DESC LIMIT 30`,
    sql`SELECT i.*, c.name AS customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id AND c.tenant_id = i.tenant_id WHERE i.tenant_id = ${tid} AND i.status IN ('sent', 'partial') ORDER BY i.due_date NULLS LAST LIMIT 60`,
    sql`SELECT count(*)::int AS n FROM visits WHERE tenant_id = ${tid} AND status = 'completed' AND completed_at >= date_trunc('month', now())`]);
  const inv = unpaid.map(shapeInvoice), today = new Date().toISOString().slice(0, 10);
  const month = await sql`SELECT payments FROM invoices WHERE tenant_id = ${tid} AND payments <> '[]'::jsonb AND created_at > now() - interval '400 days'`;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  let collected = 0; month.forEach(r => r.payments.forEach(p => { if (new Date(p.at).getTime() >= monthStart) collected += Number(p.amount); }));
  return { upcoming, new_requests: newReq, open_quotes: openQuotes.map(shapeQuote), receivables: { total: r2(inv.reduce((a, i) => a + i.balance, 0)), overdue: r2(inv.filter(i => i.due_date && String(i.due_date).slice(0, 10) < today).reduce((a, i) => a + i.balance, 0)), invoices: inv.slice(0, 10) }, month: { collected: r2(collected), visits_completed: doneMonth[0].n } };
});

// Revenue and performance for a date range (admin and owner).
route('GET', '/api/reports', async ctx => {
  need(ctx, 'admin'); const tid = ctx.tid, from = new Date(ctx.query.from || Date.now() - 180 * 864e5), to = new Date(ctx.query.to || Date.now() + 864e5);
  const invs = await sql`SELECT * FROM invoices WHERE tenant_id = ${tid} AND status <> 'void' AND created_at >= ${new Date(from.getTime() - 400 * 864e5)}`;
  const byMonth = {}, byService = {}; let invoiced = 0, collected = 0;
  for (const i of invs) {
    const s = shapeInvoice(i);
    if (new Date(i.created_at) >= from && new Date(i.created_at) < to) { invoiced += s.total; for (const it of i.items) { const k = it.name || 'Other', v = Number(it.qty) * Number(it.price); byService[k] = r2((byService[k] || 0) + v); } }
    for (const p of i.payments) { const d = new Date(p.at); if (d >= from && d < to) { collected += Number(p.amount); const k = d.toISOString().slice(0, 7); byMonth[k] = r2((byMonth[k] || 0) + Number(p.amount)); } }
  }
  const [q] = await sql`SELECT count(*) FILTER (WHERE status IN ('sent','approved','declined'))::int AS sent, count(*) FILTER (WHERE status = 'approved')::int AS approved FROM quotes WHERE tenant_id = ${tid} AND created_at >= ${from} AND created_at < ${to}`;
  const [r] = await sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'converted')::int AS converted, COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (contacted_at - created_at))), 0)::float AS median_reply_secs FROM requests WHERE tenant_id = ${tid} AND created_at >= ${from} AND created_at < ${to}`;
  const [e] = await sql`SELECT COALESCE(sum(amount), 0)::float AS total FROM expenses WHERE tenant_id = ${tid} AND incurred_on >= ${from} AND incurred_on < ${to}`;
  const top = await sql`SELECT c.id, c.name, count(DISTINCT j.id)::int AS jobs FROM customers c JOIN jobs j ON j.customer_id = c.id AND j.tenant_id = c.tenant_id WHERE c.tenant_id = ${tid} GROUP BY c.id, c.name ORDER BY jobs DESC LIMIT 8`;
  return { range: { from, to }, invoiced: r2(invoiced), collected: r2(collected), expenses: r2(e.total), profit: r2(collected - e.total), by_month: Object.entries(byMonth).sort().map(([month, amount]) => ({ month, amount })),
    by_service: Object.entries(byService).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, amount]) => ({ name, amount })),
    quotes: { sent: q.sent, approved: q.approved, approval_rate: q.sent ? Math.round(q.approved / q.sent * 100) : null }, requests: { total: r.total, converted: r.converted, median_reply_minutes: r.median_reply_secs ? Math.round(r.median_reply_secs / 60) : null }, top_customers: top };
});
// CSV exports for your accountant or QuickBooks (invoices and payments)
const csv = rows => rows.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\r\n');
route('GET', '/api/export/invoices.csv', async ctx => {
  need(ctx, 'admin');
  const rows = await sql`SELECT i.*, c.name AS customer_name, c.email AS customer_email FROM invoices i JOIN customers c ON c.id = i.customer_id AND c.tenant_id = i.tenant_id WHERE i.tenant_id = ${ctx.tid} ORDER BY i.number`;
  const out = [['Invoice', 'Customer', 'Email', 'Status', 'Created', 'Due', 'Subtotal', 'Discount', 'Tax', 'Total', 'Paid', 'Balance']];
  rows.forEach(i => { const s = shapeInvoice(i); out.push(['INV-' + i.number, i.customer_name, i.customer_email, i.status, new Date(i.created_at).toISOString().slice(0, 10), i.due_date ? new Date(i.due_date).toISOString().slice(0, 10) : '', s.subtotal, s.discount, s.tax, s.total, s.paid, s.balance]); });
  return { __raw: true, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="stagr-invoices.csv"' }, body: csv(out) };
});
route('GET', '/api/export/payments.csv', async ctx => {
  need(ctx, 'admin');
  const rows = await sql`SELECT i.number, i.payments, c.name AS customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id AND c.tenant_id = i.tenant_id WHERE i.tenant_id = ${ctx.tid} AND i.payments <> '[]'::jsonb ORDER BY i.number`;
  const out = [['Date', 'Invoice', 'Customer', 'Method', 'Amount', 'Note']];
  rows.forEach(i => i.payments.forEach(p => out.push([String(p.at).slice(0, 10), 'INV-' + i.number, i.customer_name, p.method, p.amount, p.note || ''])));
  return { __raw: true, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="stagr-payments.csv"' }, body: csv(out) };
});
