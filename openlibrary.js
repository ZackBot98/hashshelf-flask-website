(function() {
  const CACHE_PREFIX = "bookCache";
  const DAY_MS = 24 * 60 * 60 * 1000;
  const TTL_MS = 7 * DAY_MS;

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

  async function fetchJson(url) {
    const res = await fetch(url, { credentials: "omit", cache: "force-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function fetchAuthorNames(authorRefs) {
    if (!Array.isArray(authorRefs) || authorRefs.length === 0) return [];
    const names = [];
    for (const ref of authorRefs) {
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

  async function hydrateWork(id) {
    const data = await fetchJson(`https://openlibrary.org/works/${encodeURIComponent(id)}.json`);
    const title = data?.title || `Work ${id}`;
    const authors = await fetchAuthorNames(data?.authors);
    const cover = Array.isArray(data?.covers) ? data.covers[0] : null;
    return { title, authors, coverUrl: toCoverUrl(cover) };
  }

  async function hydrateEdition(idOrIsbn) {
    // Try ISBN endpoint first, fallback to books (edition key) if not found
    let data;
    try {
      data = await fetchJson(`https://openlibrary.org/isbn/${encodeURIComponent(idOrIsbn)}.json`);
    } catch {
      data = await fetchJson(`https://openlibrary.org/books/${encodeURIComponent(idOrIsbn)}.json`);
    }
    const title = data?.title || `ISBN ${idOrIsbn}`;
    const authors = await fetchAuthorNames(data?.authors);
    const cover = Array.isArray(data?.covers) ? data.covers[0] : null;
    return { title, authors, coverUrl: toCoverUrl(cover) };
  }

  async function fetchBookMeta(idType, id) {
    const key = cacheKey(idType, id);
    try {
      const raw = lsGet(key);
      if (raw) {
        const rec = JSON.parse(raw);
        if (!expired(rec.cachedAt)) return rec.value;
      }
    } catch {}

    let value;
    try {
      if (idType === "work") value = await hydrateWork(id);
      else if (idType === "isbn" || idType === "edition") value = await hydrateEdition(id);
      else value = { title: `${idType}:${id}`, authors: [], coverUrl: null };
    } catch {
      value = { title: `${idType.toUpperCase()}: ${id}`, authors: [], coverUrl: null };
    }

    lsSet(key, JSON.stringify({ cachedAt: nowMs(), value }));
    return value;
  }

  async function hydrateAll(books, { privacyMode = false } = {}) {
    const results = [];
    for (const b of books) {
      const meta = await fetchBookMeta(b.idType, b.id, { privacyMode });
      results.push({ ...b, meta });
    }
    return results;
  }

  window.OpenLibrary = {
    fetchBookMeta,
    hydrateAll
  };
})();


