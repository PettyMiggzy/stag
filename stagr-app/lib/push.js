// Push notifications through Firebase Cloud Messaging (it delivers to both Android and iPhone once the Apple key is
// uploaded in Firebase). Set FCM_SERVICE_ACCOUNT to the service-account JSON from Firebase; without it nothing is sent.
import crypto from 'node:crypto';
let cached = null, account = undefined;
function serviceAccount() {
  if (account !== undefined) return account;
  try { const raw = process.env.FCM_SERVICE_ACCOUNT || ''; const j = raw ? JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')) : null; account = j && j.client_email && j.private_key && j.project_id ? j : null; }
  catch { account = null; }
  return account;
}
export const pushReady = () => !!serviceAccount();
async function accessToken() {
  if (cached && cached.exp > Date.now() + 60e3) return cached.token;
  const sa = serviceAccount(), now = Math.floor(Date.now() / 1000), b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const jwt = unsigned + '.' + crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  const r = await fetch(process.env.FCM_TOKEN_URL || 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) });
  const j = await r.json().catch(() => ({})); if (!r.ok || !j.access_token) throw new Error('FCM auth failed: ' + (j.error_description || j.error || r.status));
  cached = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 }; return cached.token;
}
// Sends one notification to each token. Returns the tokens Firebase says are no longer valid, so the caller can forget them.
export async function sendPush(tokens, { title, body, path = '/' }) {
  const sa = serviceAccount(); if (!sa || !tokens.length) return [];
  const at = await accessToken(), url = (process.env.FCM_API_BASE || 'https://fcm.googleapis.com') + `/v1/projects/${sa.project_id}/messages:send`, dead = [];
  await Promise.all(tokens.slice(0, 200).map(async t => {
    try {
      const r = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + at, 'content-type': 'application/json' }, body: JSON.stringify({ message: { token: t, notification: { title, body }, data: { path: String(path) }, android: { priority: 'HIGH' }, apns: { payload: { aps: { sound: 'default' } } } } }), signal: AbortSignal.timeout(10000) });
      if (r.status === 404 || r.status === 400) { const j = await r.json().catch(() => ({})); const code = JSON.stringify(j); if (/UNREGISTERED|NOT_FOUND|INVALID_ARGUMENT/.test(code)) dead.push(t); }
    } catch { /* a slow or failed send never blocks the action that caused it */ }
  }));
  return dead;
}
