import { HttpError, json, readBody, clientIp } from './http.js';
import { currentUser } from './auth.js';
import { ensureSchema } from './schema.js';
const routes = [];
// route('GET', '/api/customers/:id', { auth: true }, async ctx => ({...}))
export function route(method, pattern, opts, handler) {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z_]+)/gi, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, opts, handler });
}
export async function handle(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/api/health') return json(res, 200, { ok: true });
    await ensureSchema();
    let match = null, params = {}, pathKnown = false;
    for (const r of routes) {
      const m = r.re.exec(path); if (!m) continue; pathKnown = true;
      if (r.method !== req.method) continue;
      match = r; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); break;
    }
    if (!match) throw new HttpError(pathKnown ? 405 : 404, pathKnown ? 'Method not allowed' : 'Not found');
    const ctx = { req, res, params, query: Object.fromEntries(url.searchParams), ip: clientIp(req), user: null, tid: null, body: {} };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Mutations must come from our own pages: JSON content type blocks cross-site form posts.
      const ct = String(req.headers['content-type'] || '');
      if (!match.opts.raw && !/application\/json/i.test(ct) && Number(req.headers['content-length'] || 0) > 0) throw new HttpError(415, 'Send JSON');
      ctx.body = match.opts.raw ? {} : await readBody(req);
    }
    if (!match.opts.public) {
      ctx.user = await currentUser(req);
      if (!ctx.user) throw new HttpError(401, 'Please sign in');
      ctx.tid = ctx.user.tenant_id;
    }
    const out = await match.handler(ctx);
    if (out === undefined || res.writableEnded) return;
    if (out && out.__raw) { res.statusCode = out.status || 200; for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v); return res.end(out.body); }
    json(res, 200, out);
  } catch (e) {
    if (e instanceof HttpError) return json(res, e.status, { error: e.message, ...(e.recent ? { recent: e.recent } : {}) });
    console.error('stagr error', e && e.stack || e);
    json(res, 500, { error: 'Something went wrong. Please try again.' });
  }
}
