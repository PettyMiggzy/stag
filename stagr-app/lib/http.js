export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const bad = m => new HttpError(400, m);
export const denied = (m = 'Not allowed') => new HttpError(403, m);
export const missing = (m = 'Not found') => new HttpError(404, m);
export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}
export function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
export async function readBody(req) {
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string' && req.body) { try { return JSON.parse(req.body); } catch { throw bad('Invalid JSON'); } }
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 6e6) throw bad('Request too large'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw bad('Invalid JSON'); }
}
// Behind one proxy (ours), the address it appended is the last entry; earlier entries are whatever the caller sent and cannot be trusted.
// TRUST_PROXY_HOPS says how many proxies of ours sit in front (default 1).
export const clientIp = req => { const list = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean), hops = Math.max(1, Number(process.env.TRUST_PROXY_HOPS) || 1); return list.length ? list[Math.max(0, list.length - hops)] : String(req.socket?.remoteAddress || ''); };
