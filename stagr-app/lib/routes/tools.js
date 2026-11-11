// Business tools: customer import and export, quick-price presets (truck loads, hourly movers) and the business logo.
import { route } from '../router.js';
import { sql } from '../db.js';
import { bad } from '../http.js';
import { need } from '../auth.js';
import { clean, email as cleanEmail, phone as cleanPhone, amt } from '../util.js';
import { logActivity } from './activity.js';

// A cell that starts with = + - @ would run as a formula when the file is opened in a spreadsheet, so it is defused.
export const csvCell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export const csvText = rows => rows.map(r => r.map(csvCell).join(',')).join('\r\n');

route('GET', '/api/export/customers.csv', async ctx => {
  need(ctx, 'admin');
  const rows = await sql`SELECT c.name, c.company, c.phone, c.email, c.notes, c.sms_opt_in, c.archived, c.created_at,
      (SELECT p.address FROM properties p WHERE p.customer_id = c.id AND p.tenant_id = c.tenant_id ORDER BY p.id LIMIT 1) AS address,
      (SELECT p.city FROM properties p WHERE p.customer_id = c.id AND p.tenant_id = c.tenant_id ORDER BY p.id LIMIT 1) AS city,
      (SELECT p.state FROM properties p WHERE p.customer_id = c.id AND p.tenant_id = c.tenant_id ORDER BY p.id LIMIT 1) AS state,
      (SELECT p.zip FROM properties p WHERE p.customer_id = c.id AND p.tenant_id = c.tenant_id ORDER BY p.id LIMIT 1) AS zip
    FROM customers c WHERE c.tenant_id = ${ctx.tid} ORDER BY c.name LIMIT 20000`;
  const out = [['Name', 'Company', 'Phone', 'Email', 'Address', 'City', 'State', 'Zip', 'Notes', 'Text consent', 'Archived', 'Added']];
  rows.forEach(c => out.push([c.name, c.company, c.phone, c.email, c.address || '', c.city || '', c.state || '', c.zip || '', c.notes, c.sms_opt_in ? 'yes' : 'no', c.archived ? 'yes' : 'no', new Date(c.created_at).toISOString().slice(0, 10)]));
  return { __raw: true, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="stagr-customers.csv"' }, body: csvText(out) };
});

// Import customers from a spreadsheet. The app reads the file on the phone or computer and sends plain rows.
// Someone already on file (same phone or same email) is skipped, so importing the same file twice adds nothing.
route('POST', '/api/import/customers', async ctx => {
  need(ctx, 'admin'); const rows = Array.isArray(ctx.body.rows) ? ctx.body.rows : null;
  if (!rows || !rows.length) throw bad('That file has no rows'); if (rows.length > 2000) throw bad('Import up to 2,000 customers at a time');
  const have = await sql`SELECT phone, email FROM customers WHERE tenant_id = ${ctx.tid}`;
  const phones = new Set(have.map(c => c.phone).filter(Boolean)), emails = new Set(have.map(c => c.email).filter(Boolean));
  let added = 0, skipped = 0, invalid = 0;
  for (const r of rows) {
    const name = clean(r && r.name, 120), ph = cleanPhone(r && r.phone), em = cleanEmail(r && r.email);
    if (!name) { invalid++; continue; }
    if ((ph && phones.has(ph)) || (em && emails.has(em))) { skipped++; continue; }
    const [c] = await sql`INSERT INTO customers (tenant_id, name, company, phone, email, notes, source) VALUES (${ctx.tid}, ${name}, ${clean(r.company, 120)}, ${ph}, ${em}, ${clean(r.notes, 2000)}, 'import') RETURNING id`;
    if (clean(r.address, 200)) await sql`INSERT INTO properties (tenant_id, customer_id, address, city, state, zip) VALUES (${ctx.tid}, ${c.id}, ${clean(r.address, 200)}, ${clean(r.city, 60)}, ${clean(r.state, 2).toUpperCase()}, ${clean(r.zip, 10)})`;
    if (ph) phones.add(ph); if (em) emails.add(em); added++;
  }
  if (added) await logActivity(ctx.tid, null, 'customer', `Imported ${added} customer${added === 1 ? '' : 's'} from a file`, ctx.user.id);
  return { added, skipped, invalid };
});

// Quick prices: named load sizes for junk hauling and an hourly rate for movers. Shown as one-tap buttons in the quote builder
// and, if the owner chooses, as a price guide on the public booking page.
export function cleanPricing(p) {
  p = p && typeof p === 'object' ? p : {};
  const loads = (Array.isArray(p.loads) ? p.loads : []).slice(0, 10).map(l => ({ label: clean(l && l.label, 40), price: amt(l && l.price) ?? 0 })).filter(l => l.label && l.price > 0);
  const h = p.hourly && typeof p.hourly === 'object' ? p.hourly : {};
  return { loads, hourly: { rate: amt(h.rate) ?? 0, min_hours: Math.max(0, Math.min(24, Number(h.min_hours) || 0)), truck_fee: amt(h.truck_fee) ?? 0 }, show_on_booking: !!p.show_on_booking };
}
route('PUT', '/api/business/pricing', async ctx => {
  need(ctx, 'admin'); const pricing = cleanPricing(ctx.body);
  const [t] = await sql`UPDATE tenants SET settings = settings || ${{ pricing }} WHERE id = ${ctx.tid} RETURNING settings`;
  return { pricing: t.settings.pricing };
});
// The logo is kept small (shrunk in the browser first) and shown on quotes, invoices and the booking page.
route('PUT', '/api/business/logo', async ctx => {
  need(ctx, 'admin'); const data = String(ctx.body.data || '');
  if (data && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(data) || data.length > 200000)) throw bad('Use a JPEG, PNG or WebP logo under 150 KB');
  const [t] = await sql`UPDATE tenants SET settings = settings || ${{ logo: data }} WHERE id = ${ctx.tid} RETURNING id, name, slug, phone, email, city, state, timezone, plan, tax_pct, brand_color, settings`;
  return { business: t };
});
