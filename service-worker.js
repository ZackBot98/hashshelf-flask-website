const CACHE_NAME = 'hashshelf-cache-v39';
const API_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './snapshot.js',
  './openlibrary.js',
  './ui.js',
  'https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(ASSETS);
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
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const url = new URL(req.url);

    // Cache-first with TTL for OpenLibrary APIs and covers
    const isOpenLibrary = req.method === 'GET' && (
      url.hostname.endsWith('openlibrary.org') || url.hostname.endsWith('covers.openlibrary.org')
    );
    if (isOpenLibrary) {
      const metaKey = req.url + '::meta';
      const cached = await cache.match(req);
      const metaRes = await cache.match(metaKey);
      let cachedAt = 0;
      if (metaRes) {
        try { const meta = await metaRes.json(); cachedAt = Number(meta.cachedAt) || 0; } catch {}
      }
      const fresh = cached && (Date.now() - cachedAt) < API_TTL_MS;
      if (fresh) return cached;
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        await cache.put(req, res.clone());
        await cache.put(new Request(metaKey), new Response(JSON.stringify({ cachedAt: Date.now() }), { headers: { 'content-type': 'application/json' } }));
        return res;
      } catch (err) {
        if (cached) return cached; // serve stale on failure
        throw err;
      }
    }
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (req.method === 'GET' && (req.url.startsWith(self.location.origin) || req.url.includes('cdn.jsdelivr.net'))) {
        cache.put(req, res.clone());
      }
      return res;
    } catch (err) {
      if (req.destination === 'document') {
        return cache.match('./index.html');
      }
      throw err;
    }
  })());
});


