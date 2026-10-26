// Local development server: API plus the static files in /public.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import handle from '../api/index.js';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json' };
export function start(port = Number(process.env.PORT) || 8790) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    // same headers vercel.json sets, so the app is protected the same way when it runs on our own server
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('X-Frame-Options', 'DENY');
    if (u.pathname === '/sw.js') { res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Service-Worker-Allowed', '/'); }
    const lg = u.pathname.match(/^\/(privacy|sms-terms)\/([^/]+)$/); if (lg) { return handle(req, res); }
    if (u.pathname.startsWith('/api/')) return handle(req, res);
    const route = [[/^\/q\/[^/]+$/, 'q.html'], [/^\/i\/[^/]+$/, 'i.html'], [/^\/b\/[^/]+$/, 'b.html'], [/^\/app\/?$/, 'app.html']].find(([re]) => re.test(u.pathname));
    let f = path.join(ROOT, route ? route[1] : u.pathname === '/' ? 'index.html' : u.pathname);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('content-type', MIME[path.extname(f)] || 'application/octet-stream'); res.end(fs.readFileSync(f));
  });
  return new Promise(r => srv.listen(port, () => r(srv)));
}
if (import.meta.url === `file://${process.argv[1]}`) {
  start().then(() => {
    const port = process.env.PORT || 8790; console.log('STAGR server on http://localhost:' + port);
    // Vercel Cron used to call /api/cron/run every 15 minutes (due reminders and review requests). Do the same here.
    if (process.env.CRON_SECRET) setInterval(() => { fetch(`http://127.0.0.1:${port}/api/cron/run`, { headers: { authorization: 'Bearer ' + process.env.CRON_SECRET } }).catch(() => {}); }, 15 * 60 * 1000).unref?.();
  });
}
