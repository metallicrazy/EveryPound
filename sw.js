// Offline app shell.
// The app's own files: always ask the server first (so updates show straight away), cached copy when offline.
// Firebase scripts and fonts (versioned, never change): cached copy first.
// Firestore and sign-in traffic is never touched here (Firestore keeps its own offline copy).
const CACHE = 'everypound-v20';
const SHELL = ['./', 'index.html', 'app.js', 'firebase-config.js', 'manifest.webmanifest', 'icons/icon-192-v2.png'];
const CDN = ['www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'no-cache' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    const key = req.mode === 'navigate' ? 'index.html' : req;
    // newest version when the connection is decent; on a slow or patchy signal, open from the saved copy
    // after 3 seconds (the newer one is still saved for next time)
    const net = fetch(req, { cache: 'no-cache' })
      .then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); } return r; });
    const saved = () => caches.match(key, { ignoreSearch: true });
    e.respondWith(new Promise(resolve => {
      let done = false; const finish = r => { if (!done && r) { done = true; resolve(r); } };
      const timer = setTimeout(() => saved().then(finish), 3000);
      net.then(r => { clearTimeout(timer); finish(r); }).catch(() => saved().then(r => finish(r || Response.error())));
    }));
    e.waitUntil(net.catch(() => {}));
    return;
  }
  if (!CDN.includes(url.hostname)) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(req);
    if (hit) return hit;
    const r = await fetch(req); if (r.ok) c.put(req, r.clone()); return r;
  }));
});
