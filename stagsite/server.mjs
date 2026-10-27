// Small static file server for the Stag House Records site: correct audio types and byte-range support (needed for iPhones and for seeking).
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HIDE = new Set(['build.py', '_base.css', 'server.mjs', 'Dockerfile', '.dockerignore', 'README.txt']);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8' };
const send = (res, code, body, type = 'text/plain; charset=utf-8', extra = {}) => { res.writeHead(code, { 'content-type': type, 'x-content-type-options': 'nosniff', ...extra }); res.end(body); };
http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain', { allow: 'GET, HEAD' });
  let rel; try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return send(res, 400, 'Bad request'); }
  if (!rel.endsWith('/') && !path.extname(rel)) return send(res, 301, '', 'text/plain', { location: rel + '/' });
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep) || HIDE.has(path.basename(file)) || file.split(path.sep).some(p => p.startsWith('.'))) return send(res, 404, 'Not found');
  fs.stat(file, (e, st) => {
    if (e || !st.isFile()) return send(res, 404, '<!doctype html><meta charset=utf-8><title>Not found</title><body style="background:#050806;color:#e9f2e5;font:20px system-ui;display:grid;place-items:center;height:100vh;margin:0">Not found. <a style="color:#39ff14;margin-left:10px" href="/">Back to Stag House Records</a>', 'text/html; charset=utf-8');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const isHtml = type.startsWith('text/html');
    const base = { 'content-type': type, 'accept-ranges': 'bytes', 'last-modified': st.mtime.toUTCString(), 'cache-control': isHtml ? 'no-cache' : 'public, max-age=86400', 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'SAMEORIGIN' };
    const ims = req.headers['if-modified-since']; if (ims && new Date(ims) >= new Date(Math.floor(st.mtimeMs / 1000) * 1000)) { res.writeHead(304, base); return res.end(); }
    const range = req.headers.range; let start = 0, end = st.size - 1, code = 200;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m || (m[1] === '' && m[2] === '')) { res.writeHead(416, { ...base, 'content-range': `bytes */${st.size}` }); return res.end(); }
      if (m[1] === '') { start = Math.max(0, st.size - Number(m[2])); } else { start = Number(m[1]); if (m[2] !== '') end = Math.min(end, Number(m[2])); }
      if (start > end || start >= st.size) { res.writeHead(416, { ...base, 'content-range': `bytes */${st.size}` }); return res.end(); }
      code = 206; base['content-range'] = `bytes ${start}-${end}/${st.size}`;
    }
    base['content-length'] = end - start + 1; res.writeHead(code, base);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  });
}).listen(PORT, () => console.log('Stag House Records on http://localhost:' + PORT));
