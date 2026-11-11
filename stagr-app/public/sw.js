// STAGR service worker: the app shell still opens with no signal.
// It never stores anything from /api (customer data stays on the server) and never touches other sites.
const V = 'stagr-shell-v2';
const SHELL = ['/app', '/app.css', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/logo.webp', '/logo-full.webp',
  '/js/app.js', '/js/core.js', '/js/home.js', '/js/people.js', '/js/sales.js', '/js/work.js', '/js/more.js', '/js/native.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
// The network answer wins, so people always run the newest code. The saved copy is used when the network fails or takes over 4 seconds.
const fresh = (req, key) => new Promise(resolve => {
  let done = false; const finish = r => { if (!done && r) { done = true; resolve(r); } };
  const timer = setTimeout(() => caches.match(key).then(finish), 4000);
  fetch(req).then(res => { clearTimeout(timer); if (res.ok) { const cp = res.clone(); caches.open(V).then(c => c.put(key, cp)); } finish(res); })
    .catch(() => { clearTimeout(timer); caches.match(key).then(hit => finish(hit || Response.error())); });
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;       // network only
  if (r.mode === 'navigate') { if (u.pathname === '/app' || u.pathname === '/app/') e.respondWith(fresh(r, '/app')); return; }
  if (/\.(js|css|webmanifest)$/.test(u.pathname)) { e.respondWith(fresh(r, r)); return; }                  // code: newest first
  e.respondWith(caches.match(r).then(hit => {                                                             // images: instant from cache, refreshed in the background
    const net = fetch(r).then(res => { if (res.ok) { const cp = res.clone(); caches.open(V).then(c => c.put(r, cp)); } return res; }).catch(() => hit);
    return hit || net;
  }));
});
