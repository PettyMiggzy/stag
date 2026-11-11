import { route } from '../router.js';
import { sql } from '../db.js';
import { bad } from '../http.js';

// Phones that have the STAGR app installed and allowed notifications. The app registers its push token here.
// (Sending pushes needs your Apple and Firebase keys; see mobile/README.md. Until those are set, tokens are just stored.)
route('POST', '/api/devices', async ctx => {
  const platform = ['ios', 'android'].includes(ctx.body.platform) ? ctx.body.platform : '', token = String(ctx.body.token || '').trim();
  if (!platform || token.length < 20 || token.length > 4096) throw bad('A platform and a valid token are required');
  await sql`INSERT INTO devices (tenant_id, user_id, platform, token) VALUES (${ctx.tid}, ${ctx.user.id}, ${platform}, ${token})
    ON CONFLICT (token) DO UPDATE SET tenant_id = ${ctx.tid}, user_id = ${ctx.user.id}, platform = ${platform}, last_seen = now()`;
  return { ok: true };
});
// Tell the managers of a business that something happened (new request, quote approved, invoice paid).
// Sends through Firebase Cloud Messaging when FCM_SERVICE_ACCOUNT is set; otherwise it quietly does nothing.
import { sendPush } from '../push.js';
export async function notify(tid, { title, body, path = '/', userIds = null }) {
  try {
    const rows = userIds ? await sql`SELECT d.token, d.platform FROM devices d WHERE d.tenant_id = ${tid} AND d.user_id = ANY(${userIds})`
      : await sql`SELECT d.token, d.platform FROM devices d JOIN users u ON u.id = d.user_id AND u.tenant_id = d.tenant_id WHERE d.tenant_id = ${tid} AND u.active AND u.role IN ('owner', 'admin')`;
    if (!rows.length) return 0;
    const dead = await sendPush(rows.map(r => r.token), { title: String(title).slice(0, 80), body: String(body).slice(0, 160), path });
    for (const t of dead) await sql`DELETE FROM devices WHERE token = ${t} AND tenant_id = ${tid}`;
    return rows.length - dead.length;
  } catch (e) { console.error('push failed', e && e.message); return 0; }
}
route('DELETE', '/api/devices', async ctx => {
  const token = String(ctx.body?.token || '').trim();
  if (token) await sql`DELETE FROM devices WHERE token = ${token} AND user_id = ${ctx.user.id} AND tenant_id = ${ctx.tid}`;
  return { ok: true };
});
