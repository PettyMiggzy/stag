import { route } from '../router.js';
import { sql } from '../db.js';
import { bad, HttpError } from '../http.js';
import { hashPassword, verifyPassword, setSession, clearSession, checkLockout, recordFail, clearFails, need } from '../auth.js';
import { clean, email as cleanEmail, phone as cleanPhone, slugify, amt } from '../util.js';
import { DEFAULT_AUTOMATIONS } from './comms.js';

const DEFAULT_SERVICES = [['Service call', 'Standard visit', 95], ['Hourly labor', 'Per hour, per person', 65], ['Materials', 'Materials at cost', 0]];

route('POST', '/api/auth/signup', { public: true }, async ctx => {
  const b = ctx.body, business = clean(b.business, 80), name = clean(b.name, 80), em = cleanEmail(b.email), pw = String(b.password || '');
  if (!business) throw bad('Enter your business name');
  if (!name) throw bad('Enter your name');
  if (!em) throw bad('Enter a valid email');
  if (pw.length < 8) throw bad('Password must be at least 8 characters');
  await checkLockout(['signup:' + ctx.ip]);
  const [dup] = await sql`SELECT 1 FROM users WHERE email = ${em}`;
  if (dup) throw new HttpError(409, 'That email already has an account. Sign in instead.');
  await recordFail(['signup:' + ctx.ip]); // signups share the same 10-per-15-minutes throttle per IP
  let slug = slugify(business);
  const [taken] = await sql`SELECT 1 FROM tenants WHERE slug = ${slug}`;
  if (taken) slug = slug + '-' + Math.random().toString(36).slice(2, 6);
  const [t] = await sql`INSERT INTO tenants (name, slug, phone, email, city, state) VALUES (${business}, ${slug}, ${cleanPhone(b.phone)}, ${em}, ${clean(b.city, 60)}, ${clean(b.state, 2).toUpperCase()}) RETURNING id, name, slug`;
  const [u] = await sql`INSERT INTO users (tenant_id, email, name, role, phone, password_hash) VALUES (${t.id}, ${em}, ${name}, 'owner', ${cleanPhone(b.phone)}, ${hashPassword(pw)}) RETURNING id, tenant_id, email, name, role`;
  for (const [n, d, p] of DEFAULT_SERVICES) await sql`INSERT INTO services (tenant_id, name, description, unit_price) VALUES (${t.id}, ${n}, ${d}, ${p})`;
  for (const [kind, enabled, config] of DEFAULT_AUTOMATIONS) await sql`INSERT INTO automations (tenant_id, kind, enabled, config) VALUES (${t.id}, ${kind}, ${enabled}, ${config})`;
  setSession(ctx.res, u);
  return { user: u, business: t };
});

route('POST', '/api/auth/login', { public: true }, async ctx => {
  const em = cleanEmail(ctx.body.email), pw = String(ctx.body.password || '');
  const keys = ['login:' + em, 'login-ip:' + ctx.ip];
  await checkLockout(keys);
  const [u] = em ? await sql`SELECT id, tenant_id, email, name, role, password_hash, active FROM users WHERE email = ${em}` : [];
  // always run a hash so response time does not reveal whether the email exists
  const ok = verifyPassword(pw, u ? u.password_hash : 's1$AAAAAAAAAAAAAAAAAAAAAA$AAAA') && u && u.active;
  if (!ok) { await recordFail(keys); throw new HttpError(401, 'Wrong email or password'); }
  await clearFails(['login:' + em]);
  setSession(ctx.res, u);
  return { user: { id: u.id, tenant_id: u.tenant_id, email: u.email, name: u.name, role: u.role } };
});

route('POST', '/api/auth/logout', { public: true }, async ctx => { clearSession(ctx.res); return { ok: true }; });

route('GET', '/api/auth/me', async ctx => {
  const [t] = await sql`SELECT id, name, slug, phone, email, city, state, timezone, plan, tax_pct, brand_color, settings FROM tenants WHERE id = ${ctx.tid}`;
  return { user: ctx.user, business: t };
});

route('POST', '/api/auth/password', async ctx => {
  const cur = String(ctx.body.current || ''), nw = String(ctx.body.password || '');
  if (nw.length < 8) throw bad('New password must be at least 8 characters');
  const [u] = await sql`SELECT password_hash FROM users WHERE id = ${ctx.user.id} AND tenant_id = ${ctx.tid}`;
  if (!verifyPassword(cur, u.password_hash)) throw new HttpError(401, 'Current password is wrong');
  await sql`UPDATE users SET password_hash = ${hashPassword(nw)} WHERE id = ${ctx.user.id} AND tenant_id = ${ctx.tid}`;
  return { ok: true };
});

// ---- business profile and team ----
route('PUT', '/api/business', async ctx => {
  need(ctx, 'admin'); const b = ctx.body;
  const [c] = await sql`SELECT * FROM tenants WHERE id = ${ctx.tid}`;
  const settings = { ...(c.settings || {}), ...(b.settings && typeof b.settings === 'object' ? {
    booking_enabled: b.settings.booking_enabled !== false, booking_intro: clean(b.settings.booking_intro, 300),
    review_link: clean(b.settings.review_link, 300), payment_note: clean(b.settings.payment_note, 300) } : {}) };
  const [t] = await sql`UPDATE tenants SET name = ${clean(b.name ?? c.name, 80) || c.name}, phone = ${b.phone !== undefined ? cleanPhone(b.phone) : c.phone}, email = ${b.email !== undefined ? cleanEmail(b.email) : c.email},
    city = ${clean(b.city ?? c.city, 60)}, state = ${clean(b.state ?? c.state, 2).toUpperCase()}, timezone = ${clean(b.timezone ?? c.timezone, 60) || c.timezone},
    tax_pct = ${b.tax_pct !== undefined ? Math.min(30, amt(b.tax_pct) ?? 0) : c.tax_pct}, brand_color = ${/^#[0-9a-f]{6}$/i.test(b.brand_color || '') ? b.brand_color : c.brand_color}, settings = ${settings}
    WHERE id = ${ctx.tid} RETURNING id, name, slug, phone, email, city, state, timezone, plan, tax_pct, brand_color, settings`;
  return { business: t };
});

route('GET', '/api/team', async ctx => ({ team: await sql`SELECT id, email, name, role, phone, active, created_at FROM users WHERE tenant_id = ${ctx.tid} ORDER BY id` }));
route('POST', '/api/team', async ctx => {
  need(ctx, 'admin'); const b = ctx.body, em = cleanEmail(b.email), role = ['admin', 'worker'].includes(b.role) ? b.role : 'worker';
  if (role === 'admin' && ctx.user.role !== 'owner') throw new HttpError(403, 'Only the owner can add an admin');
  if (!em || !clean(b.name, 80)) throw bad('Enter a name and a valid email');
  if (String(b.password || '').length < 8) throw bad('Temporary password must be at least 8 characters');
  const [dup] = await sql`SELECT 1 FROM users WHERE email = ${em}`; if (dup) throw new HttpError(409, 'That email is already in use');
  const [u] = await sql`INSERT INTO users (tenant_id, email, name, role, phone, password_hash) VALUES (${ctx.tid}, ${em}, ${clean(b.name, 80)}, ${role}, ${cleanPhone(b.phone)}, ${hashPassword(b.password)}) RETURNING id, email, name, role, phone, active`;
  return { member: u };
});
route('PUT', '/api/team/:id', async ctx => {
  need(ctx, 'admin'); const id = Number(ctx.params.id), b = ctx.body;
  const [m] = await sql`SELECT * FROM users WHERE id = ${id} AND tenant_id = ${ctx.tid}`; if (!m) throw new HttpError(404, 'Not found');
  if (m.role === 'owner' && ctx.user.role !== 'owner') throw new HttpError(403, 'Only the owner can change the owner');
  const role = b.role && ['admin', 'worker'].includes(b.role) && m.role !== 'owner' ? b.role : m.role;
  if (role !== m.role && role === 'admin' && ctx.user.role !== 'owner') throw new HttpError(403, 'Only the owner can make an admin');
  const active = b.active === undefined ? m.active : !!b.active;
  if (m.role === 'owner' && !active) throw new HttpError(400, 'The owner cannot be turned off');
  const hash = b.password ? (String(b.password).length >= 8 ? hashPassword(b.password) : (() => { throw bad('Password must be at least 8 characters'); })()) : m.password_hash;
  const [u] = await sql`UPDATE users SET name = ${clean(b.name ?? m.name, 80)}, phone = ${b.phone !== undefined ? cleanPhone(b.phone) : m.phone}, role = ${role}, active = ${active}, password_hash = ${hash} WHERE id = ${id} AND tenant_id = ${ctx.tid} RETURNING id, email, name, role, phone, active`;
  return { member: u };
});
