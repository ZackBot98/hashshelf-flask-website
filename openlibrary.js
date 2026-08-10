(function() {
  // v3: cached shape gained isbn (affiliate links); older entries lack it
  const CACHE_PREFIX = "bookCache3";
  const DAY_MS = 24 * 60 * 60 * 1000;
  const TTL_MS = 7 * DAY_MS;
  const API_TIMEOUT_MS = 6000;
  const API_BACKOFF_MS = 60 * 1000;
  const BATCH_DELAY_MS = 25;
  const BATCH_MAX = 50;

  // When the backend is unreachable (static hosting, cold start, outage) we
  // fall back to calling OpenLibrary directly, so the app works without it.
  let apiDownUntil = 0;

  function apiAvailable() {
    return Date.now() >= apiDownUntil;
  }
  function markApiDown() {
    apiDownUntil = Date.now() + API_BACKOFF_MS;
  }

  function fetchWithTimeout(url, options = {}, timeoutMs = API_TIMEOUT_MS) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(t));
  }

  function lsGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, value); } catch {}
  }
  function cacheKey(idType, id) {
    return `${CACHE_PREFIX}:${idType}:${id}`;
  }
  function nowMs() { return Date.now(); }
  function expired(at) { return !at || (nowMs() - at) > TTL_MS; }

  function readCached(idType, id) {
    try {
      const raw = lsGet(cacheKey(idType, id));
      if (!raw) return null;
      const rec = JSON.parse(raw);
      if (expired(rec.cachedAt)) return null;
      return rec.value;
    } catch { return null; }
  }
  function writeCached(idType, id, value) {
    lsSet(cacheKey(idType, id), JSON.stringify({ cachedAt: nowMs(), value }));
  }

  // ---------------------------------------------------------------------
  // Direct OpenLibrary fallback path (also the only path on static hosting)

  async function fetchJson(url) {
    const res = await fetch(url, { credentials: "omit", cache: "force-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function fetchAuthorNames(authorRefs) {
    if (!Array.isArray(authorRefs) || authorRefs.length === 0) return [];
    const names = [];
    for (const ref of authorRefs.slice(0, 4)) {
      const key = ref && (ref.author?.key || ref.key);
      if (!key) continue;
      try {
        const a = await fetchJson(`https://openlibrary.org${key}.json`);
        if (a && a.name) names.push(a.name);
      } catch {}
    }
    return names;
  }

  function toCoverUrl(coverId) {
    if (!coverId) return null;
    return `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`;
  }

  function isEnglishLanguageEntry(langEntry) {
    const key = langEntry?.key || '';
    return String(key).toLowerCase().includes('/languages/eng');
  }

  function findEnglishEdition(editions) {
    const list = Array.isArray(editions) ? editions : [];
    return list.find((ed) => {
      const langs = ed?.languages;
      return Array.isArray(langs) && langs.some(isEnglishLanguageEntry);
    }) || null;
  }

  // Merged OL records return {type: {key: '/type/redirect'}, location: '...'}
  function redirectTarget(data, re) {
    if (data?.type?.key === '/type/redirect' && typeof data.location === 'string') {
      const m = data.location.match(re);
      if (m) return m[1];
    }
    return null;
  }

  function editionIsbn(ed) {
    for (const field of ['isbn_13', 'isbn_10']) {
      for (const v of ed?.[field] || []) {
        const cleaned = String(v).replace(/[^0-9Xx]/g, '').toUpperCase();
        if (cleaned.length === 10 || cleaned.length === 13) return cleaned;
      }
    }
    return null;
  }

  function subjectStrings(data) {
    const out = [];
    for (const field of ['subjects', 'subject_places', 'subject_times']) {
      for (const s of data?.[field] || []) if (typeof s === 'string') out.push(s);
    }
    return out;
  }

  function genresFor(data) {
    return window.HashShelfLib ? window.HashShelfLib.normalizeGenres(subjectStrings(data)) : Promise.resolve([]);
  }

  async function hydrateWork(id, depth = 0) {
    const data = await fetchJson(`https://openlibrary.org/works/${encodeURIComponent(id)}.json`);
    const target = redirectTarget(data, /^\/works\/(OL[^/]+W)$/i);
    if (target && depth < 2) return hydrateWork(target, depth + 1);
    let title = data?.title || `Work ${id}`;
    const authors = await fetchAuthorNames(data?.authors);
    let cover = Array.isArray(data?.covers) ? data.covers[0] : null;
    let isbn = null;
    const canonical = String(data?.key || '').replace(/^\/works\//, '') || id;
    try {
      const url = `https://openlibrary.org/works/${encodeURIComponent(canonical)}/editions.json?limit=100`;
      const editions = (await fetchJson(url))?.entries;
      const engEd = findEnglishEdition(editions);
      if (engEd) {
        if (engEd.title) title = engEd.title;
        const edCovers = Array.isArray(engEd.covers) ? engEd.covers : [];
        if (edCovers.length) cover = edCovers[0];
        isbn = editionIsbn(engEd);
      }
    } catch {}
    return {
      title,
      authors,
      coverUrl: toCoverUrl(cover),
      genres: await genresFor(data),
      workId: canonical,
      isbn
    };
  }

  async function hydrateEdition(idOrIsbn, depth = 0) {
    let data;
    try {
      data = await fetchJson(`https://openlibrary.org/isbn/${encodeURIComponent(idOrIsbn)}.json`);
    } catch {
      data = await fetchJson(`https://openlibrary.org/books/${encodeURIComponent(idOrIsbn)}.json`);
    }
    const target = redirectTarget(data, /^\/books\/(OL[^/]+M)$/i);
    if (target && depth < 2) return hydrateEdition(target, depth + 1);
    const title = data?.title || `ISBN ${idOrIsbn}`;
    let authors = await fetchAuthorNames(data?.authors);
    const cover = Array.isArray(data?.covers) ? data.covers[0] : null;
    let genres = await genresFor(data);

    // Edition records frequently omit authors and subjects; borrow the work's
    const workKey = Array.isArray(data?.works) && data.works[0]?.key;
    const workId = workKey ? String(workKey).replace(/^\/works\//, '') : null;
    if (workId && (!genres.length || !authors.length)) {
      try {
        const parent = await fetchJson(`https://openlibrary.org/works/${encodeURIComponent(workId)}.json`);
        if (!genres.length) genres = await genresFor(parent);
        if (!authors.length) authors = await fetchAuthorNames(parent?.authors);
      } catch {}
    }
    const cleaned = String(idOrIsbn).replace(/[^0-9Xx]/g, '').toUpperCase();
    const isbn = (cleaned.length === 10 || cleaned.length === 13) ? cleaned : editionIsbn(data);
    return { title, authors, coverUrl: toCoverUrl(cover), genres, workId, isbn };
  }

  async function hydrateDirect(idType, id) {
    if (idType === "work") return hydrateWork(id);
    if (idType === "isbn" || idType === "edition") return hydrateEdition(id);
    return { title: `${idType}:${id}`, authors: [], coverUrl: null, genres: [], workId: null, isbn: null };
  }

  // ---------------------------------------------------------------------
  // API-first path: requests made in the same tick are coalesced into one
  // POST /api/books, so rendering a whole shelf costs a single round trip.

  let batchQueue = [];
  let batchTimer = null;

  function enqueueBatch(idType, id) {
    return new Promise((resolve) => {
      batchQueue.push({ idType, id, resolve });
      if (!batchTimer) batchTimer = setTimeout(flushBatch, BATCH_DELAY_MS);
    });
  }

  async function flushBatch() {
    batchTimer = null;
    const queue = batchQueue;
    batchQueue = [];
    for (let i = 0; i < queue.length; i += BATCH_MAX) {
      const chunk = queue.slice(i, i + BATCH_MAX);
      resolveChunkViaApi(chunk);
    }
  }

  async function resolveChunkViaApi(chunk) {
    let byKey = null;
    try {
      const res = await fetchWithTimeout('/api/books', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ books: chunk.map(({ idType, id }) => ({ idType, id })) })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      byKey = (await res.json())?.books || {};
    } catch {
      markApiDown();
    }
    for (const item of chunk) {
      const hit = byKey && byKey[`${item.idType}:${item.id}`];
      if (hit && hit.ok) {
        const value = {
          title: hit.title,
          authors: hit.authors || [],
          coverUrl: hit.coverUrl || null,
          genres: hit.genres || [],
          workId: hit.workId || null,
          isbn: hit.isbn || null
        };
        writeCached(item.idType, item.id, value);
        item.resolve(value);
      } else {
        item.resolve(null); // caller falls back to direct
      }
    }
  }

  const inflight = new Map();

  async function fetchBookMeta(idType, id) {
    const cached = readCached(idType, id);
    if (cached) return cached;

    const key = `${idType}:${id}`;
    if (inflight.has(key)) return inflight.get(key);

    const p = (async () => {
      if (apiAvailable()) {
        const viaApi = await enqueueBatch(idType, id);
        if (viaApi) return viaApi;
      }
      try {
        const value = await hydrateDirect(idType, id);
        writeCached(idType, id, value); // only successes are cached
        return value;
      } catch {
        return { title: `${idType.toUpperCase()}: ${id}`, authors: [], coverUrl: null, genres: [], workId: null, isbn: null };
      }
    })().finally(() => inflight.delete(key));

    inflight.set(key, p);
    return p;
  }

  async function hydrateAll(books) {
    // Parallel; the batcher coalesces these into bulk API calls.
    const results = await Promise.all(
      books.map(async (b) => ({ ...b, meta: await fetchBookMeta(b.idType, b.id) }))
    );
    return results;
  }

  // ---------------------------------------------------------------------
  // Search: API proxy first (cached + English-edition-enriched server-side),
  // direct OpenLibrary as fallback.

  async function search(query, { limit = 10 } = {}) {
    const q = String(query || '').trim();
    if (!q) return { docs: [], enriched: false };

    if (apiAvailable()) {
      try {
        const res = await fetchWithTimeout(`/api/search?q=${encodeURIComponent(q)}`);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.docs)) return { docs: data.docs.slice(0, limit), enriched: !!data.enriched };
        } else {
          throw new Error(`HTTP ${res.status}`);
        }
      } catch {
        markApiDown();
      }
    }

    const params = new URLSearchParams();
    params.set('q', q);
    params.set('limit', String(limit));
    params.set('fields', 'key,title,author_name,cover_i,isbn');
    const res = await fetch(`https://openlibrary.org/search.json?${params.toString()}`, { credentials: 'omit' });
    if (!res.ok) throw new Error('search failed');
    const data = await res.json();
    const docs = (Array.isArray(data?.docs) ? data.docs : [])
      .filter(d => d && d.key && d.title)
      .slice(0, limit);
    return { docs, enriched: false };
  }

  // Used by the fallback search path to upgrade titles/covers to the English
  // edition, mirroring what the API does server-side.
  async function fetchWorkEditions(workKey, { limit = 100 } = {}) {
    const key = String(workKey || '').replace(/^\/works\//, '');
    const url = `https://openlibrary.org/works/${encodeURIComponent(key)}/editions.json?limit=${limit}`;
    const data = await fetchJson(url);
    return Array.isArray(data?.entries) ? data.entries : [];
  }

  window.OpenLibrary = {
    fetchBookMeta,
    hydrateAll,
    search,
    fetchWorkEditions,
    findEnglishEdition
  };
})();
