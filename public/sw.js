// Tickmark service worker.
// - App files are cached when it installs (the server fills in SHELL with every file under public/),
//   and the cache is named after the build, so a new version replaces it.
// - Files the page asks for as …?v=<build> never change for that build: served from the cache first.
// - Everything else is network-first, falling back to the cache when offline; a page load waits at
//   most a few seconds for a slow network before showing the cached app.
const CACHE = 'tickmark-v34';
const SHELL = ['/', '/index.html', '/style.css', '/theme.js', '/app.js', '/vendor/marked.esm.js', '/manifest.webmanifest', '/icons/icon.svg'];
// API reads worth keeping for offline viewing; everything else under /api is network-only.
const CACHEABLE_API = /^\/api\/(tree|file|config|backlinks|branding)$/;
const NAV_TIMEOUT = 4000;
const BUILD = CACHE.replace(/^tickmark-/, '');

self.addEventListener('install', (e) => {
  // One missing file shouldn't stop the worker from installing: cache what's there.
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => {});
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

const timeout = (ms) => new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') && !CACHEABLE_API.test(url.pathname)) return;
  if (url.pathname.startsWith('/p/') || url.pathname === '/sw.js') return; // public pages and this file: always fresh

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Only this build's files: after an update, the old worker (still in charge until the page
    // reloads) must not answer a request for the new build with what it cached for the old one.
    const versioned = url.searchParams.get('v') === BUILD && !url.pathname.startsWith('/api/');
    if (versioned) {
      const hit = await cache.match(req) || await cache.match(url.pathname);
      if (hit) return hit;
    }
    try {
      const net = (async () => (req.mode === 'navigate' && await e.preloadResponse) || fetch(req))();
      const res = await (req.mode === 'navigate' ? Promise.race([net, timeout(NAV_TIMEOUT)]) : net);
      if (res.ok) {
        const copy = res.clone();
        e.waitUntil(cache.put(req, copy).catch(() => {}));
      }
      return res;
    } catch (err) {
      // App files are requested as /app.js?v=<build>; offline, any cached copy of them will do.
      const hit = await cache.match(req) || (!url.pathname.startsWith('/api/') ? await cache.match(req, { ignoreSearch: true }) : null) ||
        (req.mode === 'navigate' ? await cache.match('/index.html') || await cache.match('/') : null);
      if (hit) return hit;
      throw err;
    }
  })());
});
