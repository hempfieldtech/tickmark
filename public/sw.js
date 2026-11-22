// Tickmark service worker: network-first everywhere, falling back to cache when offline.
const CACHE = 'tickmark-v32';
const SHELL = ['/', '/index.html', '/style.css', '/theme.js', '/app.js', '/shared/tasks.js', '/shared/recur.js', '/shared/words.js', '/vendor/marked.esm.js',
  '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png'];
// API reads worth keeping for offline viewing; everything else under /api is network-only.
const CACHEABLE_API = /^\/api\/(tree|file|config|backlinks)$/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') && !CACHEABLE_API.test(url.pathname)) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req) || (req.mode === 'navigate' ? await cache.match('/index.html') : null);
      if (hit) return hit;
      throw err;
    }
  })());
});
