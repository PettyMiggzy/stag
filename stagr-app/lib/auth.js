import crypto from 'node:crypto';
import { sql } from './db.js';
import { HttpError, parseCookies } from './http.js';

const COOKIE = 'stagr_session';
const secret = () => {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 24) return s;
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) throw new Error('SESSION_SECRET must be set (24+ characters)');
  return (globalThis.__devSecret ||= crypto.randomBytes(32).toString('hex'));
};
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return 's1$' + salt.toString('base64url') + '$' + h.toString('base64url');
}
export function verifyPassword(pw, stored) {
  try {
    const [v, s, h] = String(stored).split('$'); if (v !== 's1') return false;
    const calc = crypto.scryptSync(String(pw), Buffer.from(s, 'base64url'), 64, { N: 16384, r: 8, p: 1 });
    const want = Buffer.from(h, 'base64url');
    return calc.length === want.length && crypto.timingSafeEqual(calc, want);
  } catch { return false; }
}
const sign = payload => { const b = Buffer.from(JSON.stringify(payload)).toString('base64url'); return b + '.' + crypto.createHmac('sha256', secret()).update(b).digest('base64url'); };
function unsign(tok) {
  const [b, sig] = String(tok || '').split('.'); if (!b || !sig) return null;
  const want = crypto.createHmac('sha256', secret()).update(b).digest('base64url');
  const a = Buffer.from(sig), c = Buffer.from(want);
  if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) return null;
  try { const p = JSON.parse(Buffer.from(b, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
export function setSession(res, user) {
  const tok = sign({ uid: user.id, tid: user.tenant_id, exp: Date.now() + 14 * 864e5 });
  const secure = (process.env.NODE_ENV === 'production' || process.env.VERCEL) ? '; Secure' : '';
  res.setHeader('set-cookie', `${COOKIE}=${encodeURIComponent(tok)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${14 * 86400}${secure}`);
}
export function clearSession(res) { res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`); }
// Resolve the signed-in user from the cookie. The tenant always comes from the database row, never from the client.
export async function currentUser(req) {
  const p = unsign(parseCookies(req)[COOKIE]); if (!p) return null;
  const [u] = await sql`SELECT id, tenant_id, email, name, role, phone, active FROM users WHERE id = ${p.uid} AND tenant_id = ${p.tid}`;
  return u && u.active ? u : null;
}
export const ROLE_RANK = { worker: 1, admin: 2, owner: 3 };
export function need(ctx, role) {
  if (!ctx.user) throw new HttpError(401, 'Please sign in');
  if (ROLE_RANK[ctx.user.role] < ROLE_RANK[role]) throw new HttpError(403, 'Your role cannot do this');
}
// Lockout: 10 failed sign-ins per email in 15 minutes. Per IP the limit is higher (30) because an office or a
// phone carrier can put many real users behind one address.
export async function checkLockout(keys) {
  for (const k of keys) {
    const limit = /^(login-ip|signup):/.test(k) ? 30 : 10;
    const [r] = await sql`SELECT count(*)::int AS n FROM login_fails WHERE key = ${k} AND at > now() - interval '15 minutes'`;
    if (r.n >= limit) throw new HttpError(429, 'Too many tries. Wait 15 minutes and try again.');
  }
}
export const recordFail = async keys => { for (const k of keys) await sql`INSERT INTO login_fails(key) VALUES (${k})`; };
export const clearFails = async keys => { for (const k of keys) await sql`DELETE FROM login_fails WHERE key = ${k}`; };
