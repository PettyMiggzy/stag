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
route('DELETE', '/api/devices', async ctx => {
  const token = String(ctx.body?.token || '').trim();
  if (token) await sql`DELETE FROM devices WHERE token = ${token} AND user_id = ${ctx.user.id} AND tenant_id = ${ctx.tid}`;
  return { ok: true };
});
