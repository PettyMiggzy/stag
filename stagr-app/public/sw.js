// STAGR service worker: the app shell opens instantly and still opens with no signal.
// It never stores anything from /api (customer data stays on the server) and never touches other sites.
const V = 'stagr-shell-v1';
const SHELL = ['/app', '/app.css', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/logo.webp', '/logo-full.webp',
  '/js/app.js', '/js/core.js', '/js/home.js', '/js/people.js', '/js/sales.js', '/js/work.js', '/js/more.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;       // network only
  if (r.mode === 'navigate') {                                                                            // pages: network first, shell when offline
    if (u.pathname === '/app' || u.pathname === '/app/') {
      e.respondWith(fetch(r).then(res => { const cp = res.clone(); caches.open(V).then(c => c.put('/app', cp)); return res; }).catch(() => caches.match('/app')));
    }
    return;
  }
  e.respondWith(caches.match(r).then(hit => {                                                             // assets: instant from cache, refreshed in the background
    const net = fetch(r).then(res => { if (res.ok) { const cp = res.clone(); caches.open(V).then(c => c.put(r, cp)); } return res; }).catch(() => hit);
    return hit || net;
  }));
});
