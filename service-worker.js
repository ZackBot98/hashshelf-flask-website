const CACHE_NAME = 'hashshelf-cache-v46';
const API_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ASSETS = [
  '/',
  '/index.html',
  '/about.html',
  '/styles.css',
  '/snapshot.js',
  '/openlibrary.js',
  '/config.js',
  '/lib.js',
  '/ui.js',
  '/manifest.json',
  '/genres.json',
  '/vendor/fflate.min.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Opaque responses (no-cors image loads) report status 0 and must be assumed
// good; for everything else only cache real successes so an upstream error
// can never get pinned in cache for a week.
function cacheable(res) {
  return res && (res.ok || res.type === 'opaque');
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // no-cache: bypass the HTTP cache so a new SW version never precaches
    // stale copies of assets that were fetched under an old max-age
    await cache.addAll(ASSETS.map(u => new Request(u, { cache: 'no-cache' })));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // POST /api/* etc. go straight to network

  const url = new URL(req.url);

  // Never cache-first the API itself (besides search, handled below):
  // freshness beats offline for dynamic endpoints.
  const isSearch = url.origin === self.location.origin && url.pathname === '/api/search';
  const isOtherApi = url.origin === self.location.origin && !isSearch && url.pathname.startsWith('/api/');
  if (isOtherApi) return;

  const isOpenLibrary =
    url.hostname.endsWith('openlibrary.org') || url.hostname.endsWith('covers.openlibrary.org');

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    // Cache-first with TTL for OpenLibrary + our search proxy; stale on error
    if (isOpenLibrary || isSearch) {
      const metaKey = req.url + '::meta';
      let cached = await cache.match(req);
      // An opaque response (stored from a no-cors <img> load) cannot satisfy a
      // CORS request — the wrapped card reads cover pixels and would fail.
      // Refetch instead, which also upgrades the entry to a usable CORS copy.
      if (cached && cached.type === 'opaque' && req.mode === 'cors') cached = undefined;
      const metaRes = await cache.match(metaKey);
      let cachedAt = 0;
      if (metaRes) {
        try { const meta = await metaRes.json(); cachedAt = Number(meta.cachedAt) || 0; } catch {}
      }
      const fresh = cached && (Date.now() - cachedAt) < API_TTL_MS;
      if (fresh) return cached;
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (cacheable(res)) {
          await cache.put(req, res.clone());
          await cache.put(
            new Request(metaKey),
            new Response(JSON.stringify({ cachedAt: Date.now() }), { headers: { 'content-type': 'application/json' } })
          );
        }
        return res;
      } catch (err) {
        if (cached) return cached; // serve stale on failure
        throw err;
      }
    }

    // App shell + same-origin assets: cache-first, fill from network
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (url.origin === self.location.origin && cacheable(res) && !url.pathname.startsWith('/s/')) {
        cache.put(req, res.clone());
      }
      return res;
    } catch (err) {
      if (req.destination === 'document') {
        const shell = await cache.match('/index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
