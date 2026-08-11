/* HashShelf shared logic: CSV import, genres, compare, wrapped card.
   Pure functions where possible so they're testable outside the browser. */
(function(root) {
  // ------------------------------------------------------- link-free policy

  // Shared shelves are link-free text, so a hashshelf.com page can never carry
  // someone else's URL. Comments reject pasteable link forms; shelf names are
  // stricter (they become the unfurl title on short links) and also reject
  // bare domains. Mirrors URL_IN_TEXT_RE / BARE_DOMAIN_RE in server.py — keep
  // in sync so anything addable stays shortenable.
  const URL_IN_TEXT_RE = /(?:https?:\/\/|ftp:\/\/|www\.)/i;
  // Keep this TLD set in sync with _BARE_TLDS in server.py.
  const BARE_DOMAIN_RE = /\b[a-z0-9-]+\.(?:com|net|org|io|co|me|us|uk|ly|gg|xyz|ru|cn|info|biz|site|online|top|club|cc|to|tv|link|click|app|dev|shop|store|zip|mov|pro|vip|icu|sbs|cfd|lol|monster|quest|rest|fun|bar|win|bid|loan|stream|download|pizza|space|website|live|world|de|fr|jp|nl|eu|ca|au|in|br|es|it|pl|se|ai|be|ws|pw|su)\b/i;

  function commentHasUrl(text) {
    return URL_IN_TEXT_RE.test(String(text || ''));
  }

  function nameHasUrl(text) {
    const s = String(text || '');
    return URL_IN_TEXT_RE.test(s) || BARE_DOMAIN_RE.test(s);
  }

  // For imported text (Goodreads reviews often contain links): drop the URLs,
  // keep the note. Erroring a 300-book import over one link would be hostile.
  function stripUrls(text) {
    return String(text || '')
      .replace(/(?:https?:\/\/|ftp:\/\/|www\.)\S+/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  // ------------------------------------------------------------------ CSV

  // RFC 4180 parser: handles quoted fields, escaped quotes, embedded newlines.
  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    const src = String(text || '').replace(/^﻿/, ''); // strip BOM
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (inQuotes) {
        if (c === '"') {
          if (src[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
        continue;
      }
      if (c === '"') { inQuotes = true; continue; }
      if (c === ',') { row.push(field); field = ''; continue; }
      if (c === '\r') continue;
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
      field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.length > 1 || (r[0] || '').trim() !== '');
  }

  // Goodreads writes ISBNs as Excel-safe formulas: ="9780140449136"
  function cleanIsbn(value) {
    const m = String(value || '').match(/[0-9Xx]{10,13}/);
    return m ? m[0].toUpperCase() : '';
  }

  const GOODREADS_STATUS = {
    'read': 'finished',
    'currently-reading': 'reading',
    'to-read': 'want',
    'did-not-finish': 'did not finish',
    'dnf': 'did not finish'
  };

  function parseGoodreadsCsv(text) {
    const rows = parseCsv(text);
    if (!rows.length) return { books: [], skipped: [], total: 0 };
    const header = rows[0].map(h => String(h || '').trim());
    const col = (name) => header.indexOf(name);
    const iTitle = col('Title'), iAuthor = col('Author');
    const iIsbn = col('ISBN'), iIsbn13 = col('ISBN13');
    const iRating = col('My Rating'), iShelf = col('Exclusive Shelf');
    const iReview = col('My Review'), iShelves = col('Bookshelves');
    if (iTitle < 0 || (iIsbn < 0 && iIsbn13 < 0)) {
      throw new Error('That does not look like a Goodreads export (missing Title/ISBN columns).');
    }

    const books = [], skipped = [];
    for (let r = 1; r < rows.length; r++) {
      const cells = rows[r];
      if (!cells || cells.length < 2) continue;
      const title = String(cells[iTitle] || '').trim();
      const author = iAuthor >= 0 ? String(cells[iAuthor] || '').trim() : '';
      if (!title) continue;

      const isbn = cleanIsbn(iIsbn13 >= 0 ? cells[iIsbn13] : '') || cleanIsbn(iIsbn >= 0 ? cells[iIsbn] : '');
      if (!isbn) { skipped.push({ title, author }); continue; }

      const shelfRaw = String((iShelf >= 0 ? cells[iShelf] : '') || '').trim().toLowerCase();
      const extraShelves = String((iShelves >= 0 ? cells[iShelves] : '') || '').toLowerCase();
      let status = GOODREADS_STATUS[shelfRaw] || 'want';
      // Goodreads has no native DNF shelf; people make a custom one
      if (/\b(did-not-finish|dnf|abandoned)\b/.test(extraShelves)) status = 'did not finish';

      const ratingNum = Number(iRating >= 0 ? cells[iRating] : 0);
      const rating = Number.isFinite(ratingNum) && ratingNum > 0 ? Math.min(5, Math.round(ratingNum)) : undefined;
      const comment = stripUrls(String((iReview >= 0 ? cells[iReview] : '') || '')).slice(0, 2000);

      books.push({
        idType: 'isbn',
        id: isbn,
        status,
        ...(rating !== undefined ? { rating } : {}),
        ...(comment ? { comment } : {})
      });
    }
    return { books, skipped, total: rows.length - 1 };
  }

  // --------------------------------------------------------------- genres

  let genreRules = null;

  // Fold punctuation so 'Science-fiction' and 'Science fiction' match alike.
  function normSubject(value) {
    return String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  async function loadGenreRules() {
    if (genreRules) return genreRules;
    try {
      const res = await fetch('/genres.json');
      if (!res.ok) throw new Error('genres unavailable');
      const data = await res.json();
      genreRules = {
        exclude: (data.exclude || []).map(normSubject),
        rules: (data.rules || []).map(r => [r.genre, (r.match || []).map(normSubject)])
      };
    } catch {
      genreRules = { exclude: [], rules: [] }; // enrichment is optional
    }
    return genreRules;
  }

  // Mirrors normalize_genres() in server.py, sharing genres.json as the
  // single source of truth. Only used on the direct-OpenLibrary path.
  // One subject contributes to at most one genre: rules run specific before
  // general, so "Science fiction" never also counts as Science.
  async function normalizeGenres(subjects, limit = 3) {
    const { exclude, rules } = await loadGenreRules();
    if (!rules.length) return [];
    const hits = new Map();
    for (const subject of subjects || []) {
      const s = normSubject(subject || '');
      if (!s || exclude.some(bad => s.includes(bad))) continue;
      for (let idx = 0; idx < rules.length; idx++) {
        const [genre, needles] = rules[idx];
        if (needles.some(n => s.includes(n))) {
          const prev = hits.get(genre);
          hits.set(genre, [(prev ? prev[0] : 0) + 1, idx]);
          break;
        }
      }
    }
    // Ties break toward the earlier (more specific) rule
    return Array.from(hits.entries())
      .sort((a, b) => b[1][0] - a[1][0] || a[1][1] - b[1][1])
      .slice(0, limit)
      .map(([g]) => g);
  }

  // ------------------------------------------------------------ affiliate

  function isbnDigits(value) {
    return String(value || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  }

  function isbn10CheckDigit(nine) {
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += (i + 1) * Number(nine[i]);
    const check = sum % 11;
    return check === 10 ? 'X' : String(check);
  }

  function isbn13CheckDigit(twelve) {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(twelve[i]) * (i % 2 === 0 ? 1 : 3);
    return String((10 - (sum % 10)) % 10);
  }

  // Amazon's ASIN for a print book is its ISBN-10. Only 978-prefixed ISBN-13s
  // convert; 979-prefixed ones have no ISBN-10 equivalent.
  function toIsbn10(value) {
    const s = isbnDigits(value);
    if (s.length === 10) return s;
    if (s.length === 13 && s.startsWith('978')) {
      const nine = s.slice(3, 12);
      return nine + isbn10CheckDigit(nine);
    }
    return null;
  }

  function toIsbn13(value) {
    const s = isbnDigits(value);
    if (s.length === 13) return s;
    if (s.length === 10) {
      const twelve = '978' + s.slice(0, 9);
      return twelve + isbn13CheckDigit(twelve);
    }
    return null;
  }

  // Returns [{label, url}] for whichever programs are configured. Empty when
  // none are, which is what keeps buy links off the page by default.
  function buyLinks(meta, config) {
    const cfg = config || {};
    const out = [];
    const isbn = meta && meta.isbn;
    const title = (meta && meta.title) || '';

    if (cfg.amazonTag) {
      const host = cfg.amazonHost || 'www.amazon.com';
      const tag = encodeURIComponent(cfg.amazonTag);
      const asin = toIsbn10(isbn);
      if (asin) {
        out.push({ label: 'Amazon', url: `https://${host}/dp/${asin}?tag=${tag}` });
      } else {
        // No ISBN-10 (979-prefixed, or no ISBN at all): a search link still
        // carries attribution.
        const q = encodeURIComponent(isbnDigits(isbn) || title);
        if (q) out.push({ label: 'Amazon', url: `https://${host}/s?k=${q}&tag=${tag}` });
      }
      // Audiobook editions are separate Audible ASINs we can't derive from an
      // ISBN, so link a tagged search constrained to the Audible catalog —
      // usually a one-result page for the exact book.
      if (title) {
        const author = ((meta && meta.authors) || [])[0] || '';
        const audioQ = encodeURIComponent(`${title} ${author}`.trim());
        out.push({ label: 'Audiobook', url: `https://${host}/s?k=${audioQ}&i=audible&tag=${tag}` });
      }
    }

    if (cfg.bookshopId) {
      const isbn13 = toIsbn13(isbn);
      const id = encodeURIComponent(cfg.bookshopId);
      if (isbn13) {
        out.push({ label: 'Bookshop', url: `https://bookshop.org/a/${id}/${isbn13}` });
      } else if (title) {
        out.push({ label: 'Bookshop', url: `https://bookshop.org/beta-search?keywords=${encodeURIComponent(title)}&affiliate=${id}` });
      }
    }

    return out;
  }

  function affiliateActive(config) {
    const cfg = config || {};
    return !!(cfg.amazonTag || cfg.bookshopId);
  }

  // -------------------------------------------------------------- compare

  // Prefer the OpenLibrary work id so an ISBN entry and a work entry for the
  // same book match; fall back to the raw id when metadata is missing.
  function identityKey(book, meta) {
    const workId = meta && meta.workId;
    if (workId) return `work:${workId}`;
    if (book.idType === 'work') return `work:${book.id}`;
    return `${book.idType}:${book.id}`;
  }

  function compareShelves(mine, theirs) {
    const index = (list) => {
      const m = new Map();
      for (const entry of list) m.set(entry.key, entry);
      return m;
    };
    const a = index(mine), b = index(theirs);
    const both = [], onlyMine = [], onlyTheirs = [], disagreements = [], agreements = [];

    for (const [key, entry] of a) {
      const other = b.get(key);
      if (!other) { onlyMine.push(entry); continue; }
      both.push({ key, mine: entry, theirs: other });
      const r1 = entry.book.rating, r2 = other.book.rating;
      if (typeof r1 === 'number' && typeof r2 === 'number') {
        const gap = Math.abs(r1 - r2);
        if (gap >= 2) disagreements.push({ key, mine: entry, theirs: other, gap });
        else if (r1 >= 4 && r2 >= 4) agreements.push({ key, mine: entry, theirs: other });
      }
    }
    for (const [key, entry] of b) if (!a.has(key)) onlyTheirs.push(entry);

    disagreements.sort((x, y) => y.gap - x.gap);
    const union = a.size + onlyTheirs.length;
    return {
      both, onlyMine, onlyTheirs, disagreements, agreements,
      overlapPct: union ? Math.round((both.length / union) * 100) : 0
    };
  }

  // -------------------------------------------------------------- wrapped

  function buildStats(hydrated) {
    const counts = { want: 0, reading: 0, finished: 0, 'did not finish': 0 };
    const authors = new Map(), genres = new Map();
    const dist = [0, 0, 0, 0, 0, 0]; // index = rating 0..5
    let rated = 0, ratingSum = 0;

    for (const entry of hydrated) {
      const b = entry.book, meta = entry.meta || {};
      if (counts[b.status] !== undefined) counts[b.status]++;
      if (typeof b.rating === 'number') { dist[b.rating]++; rated++; ratingSum += b.rating; }
      for (const a of meta.authors || []) authors.set(a, (authors.get(a) || 0) + 1);
      for (const g of meta.genres || []) genres.set(g, (genres.get(g) || 0) + 1);
    }
    const top = (map, n) => Array.from(map.entries())
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, n);

    return {
      total: hydrated.length,
      counts,
      dist,
      rated,
      avgRating: rated ? ratingSum / rated : 0,
      topAuthors: top(authors, 3),
      topGenres: top(genres, 5),
      covers: hydrated.map(e => e.meta && e.meta.coverUrl).filter(Boolean)
    };
  }

  const CARD_W = 1080, CARD_H = 1350;

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function fitText(ctx, text, maxWidth) {
    let s = String(text);
    if (ctx.measureText(s).width <= maxWidth) return s;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
    return s + '…';
  }

  async function loadImage(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous'; // covers.openlibrary.org sends ACAO:*
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  // Draws the shareable card. Returns the canvas so callers can export it.
  async function renderWrappedCard(stats, { name = '', year = new Date().getFullYear() } = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = CARD_W;
    canvas.height = CARD_H;
    const ctx = canvas.getContext('2d');
    // Card Catalog tokens: ink on index stock, stamp-red accent
    const FONT = 'Georgia, "Iowan Old Style", "Times New Roman", serif';
    const MONO = '"Cascadia Code", "Segoe UI Mono", Consolas, Menlo, monospace';
    const ACCENT = '#c23b22', TEXT = '#191817', MUTED = '#6e6b63', CARD = '#fcfbf8', BORDER = '#191817';

    ctx.fillStyle = '#fcfbf8';
    ctx.fillRect(0, 0, CARD_W, CARD_H);
    // bookplate frame: heavy outer rule, hairline inner
    ctx.strokeStyle = '#191817';
    ctx.lineWidth = 4;
    ctx.strokeRect(22, 22, CARD_W - 44, CARD_H - 44);
    ctx.lineWidth = 1;
    ctx.strokeRect(34, 34, CARD_W - 68, CARD_H - 68);

    // Header: measure so the # never collides with the title
    const heading = name || 'My books';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const hashFont = `700 60px ${MONO}`;
    let titleFont = `600 52px ${FONT}`;
    ctx.font = hashFont;
    const hashW = ctx.measureText('#').width;
    const gapW = 20;
    ctx.font = titleFont;
    // Shrink the title until the whole lockup fits the safe width
    let titleSize = 52;
    while (ctx.measureText(heading).width + hashW + gapW > CARD_W - 120 && titleSize > 30) {
      titleSize -= 2;
      titleFont = `600 ${titleSize}px ${FONT}`;
      ctx.font = titleFont;
    }
    const titleW = ctx.measureText(heading).width;
    let hx = (CARD_W - (hashW + gapW + titleW)) / 2;
    ctx.font = hashFont;
    ctx.fillStyle = ACCENT;
    ctx.fillText('#', hx, 118);
    ctx.font = titleFont;
    ctx.fillStyle = TEXT;
    ctx.fillText(heading, hx + hashW + gapW, 118);

    ctx.textAlign = 'center';
    ctx.fillStyle = MUTED;
    ctx.font = `400 26px ${MONO}`;
    ctx.fillText(`YEAR IN BOOKS · ${year}`, CARD_W / 2, 172);

    // Cover strip. Covers may fail to load (offline, CORS); the layout below
    // flows from wherever this ends so a missing strip leaves no dead space.
    let y = 200;
    const strip = stats.covers.slice(0, 6);
    const imgs = strip.length ? (await Promise.all(strip.map(loadImage))).filter(Boolean) : [];
    if (imgs.length) {
      const cw = 150, ch = 225, gap = 18;
      let x = (CARD_W - (imgs.length * cw + (imgs.length - 1) * gap)) / 2;
      for (const img of imgs) {
        ctx.save();
        roundRect(ctx, x, y, cw, ch, 3);
        ctx.clip();
        // cover-fit: crop to fill the slot without distorting the artwork
        const scale = Math.max(cw / img.width, ch / img.height);
        const dw = img.width * scale, dh = img.height * scale;
        ctx.drawImage(img, x + (cw - dw) / 2, y + (ch - dh) / 2, dw, dh);
        ctx.restore();
        ctx.strokeStyle = BORDER;
        ctx.lineWidth = 2;
        roundRect(ctx, x, y, cw, ch, 3);
        ctx.stroke();
        x += cw + gap;
      }
      y += ch + 46;
    } else {
      y += 40;
    }

    // Headline number
    const finished = stats.counts.finished;
    ctx.fillStyle = ACCENT;
    ctx.font = `800 190px ${FONT}`;
    ctx.fillText(String(finished), CARD_W / 2, y + 150);
    ctx.fillStyle = TEXT;
    ctx.font = `500 40px ${FONT}`;
    ctx.fillText(finished === 1 ? 'book finished' : 'books finished', CARD_W / 2, y + 206);
    y += 234;

    // Stat tiles
    const tiles = [
      ['On the shelf', String(stats.total)],
      ['Avg rating', stats.rated ? stats.avgRating.toFixed(1) + '★' : '—'],
      ['Reading now', String(stats.counts.reading)]
    ];
    const tw = 300, th = 130, tgap = 30;
    let tx = (CARD_W - (tiles.length * tw + (tiles.length - 1) * tgap)) / 2;
    for (const [label, value] of tiles) {
      ctx.fillStyle = CARD;
      roundRect(ctx, tx, y, tw, th, 4);
      ctx.fill();
      ctx.strokeStyle = BORDER;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = TEXT;
      ctx.font = `600 52px ${FONT}`;
      ctx.fillText(value, tx + tw / 2, y + 70);
      ctx.fillStyle = MUTED;
      ctx.font = `400 20px ${MONO}`;
      ctx.fillText(label.toUpperCase(), tx + tw / 2, y + 108);
      tx += tw + tgap;
    }
    y += th + 56;

    // Top authors / genres
    ctx.textAlign = 'left';
    const colX = [90, 580];
    const lists = [['Top authors', stats.topAuthors], ['Top genres', stats.topGenres]];
    for (let c = 0; c < lists.length; c++) {
      const [label, entries] = lists[c];
      ctx.fillStyle = MUTED;
      ctx.font = `600 22px ${MONO}`;
      ctx.fillText(label.toUpperCase(), colX[c], y);
      let ly = y + 52;
      if (!entries.length) {
        ctx.fillStyle = MUTED;
        ctx.font = `500 34px ${FONT}`;
        ctx.fillText('—', colX[c], ly);
      }
      for (const [entryLabel, count] of entries.slice(0, 3)) {
        ctx.font = `500 34px ${FONT}`;
        ctx.fillStyle = TEXT;
        ctx.fillText(fitText(ctx, entryLabel, 320), colX[c], ly);
        ctx.fillStyle = ACCENT;
        ctx.font = `600 24px ${MONO}`;
        ctx.fillText(`×${count}`, colX[c] + 336, ly);
        ly += 52;
      }
    }
    y += 52 + 3 * 52 + 26;

    // Rating distribution, pinned above the bookplate frame
    const barsTop = Math.max(y + 34, CARD_H - 176);
    ctx.fillStyle = MUTED;
    ctx.font = `600 22px ${MONO}`;
    ctx.fillText('RATINGS', 90, barsTop - 26);
    ctx.textAlign = 'right';
    ctx.font = `500 22px ${MONO}`;
    ctx.fillText('hashshelf.com', CARD_W - 90, barsTop - 26);
    ctx.textAlign = 'left';

    const maxCount = Math.max(1, ...stats.dist);
    const barW = 150, barGap = 22, barH = 74;
    let bx = 90;
    for (let r = 1; r <= 5; r++) {
      const h = Math.round((stats.dist[r] / maxCount) * barH);
      ctx.fillStyle = '#ebe8de';
      roundRect(ctx, bx, barsTop, barW, barH, 3);
      ctx.fill();
      ctx.strokeStyle = '#c9c6bc';
      ctx.lineWidth = 1;
      ctx.stroke();
      if (h > 0) {
        ctx.fillStyle = ACCENT;
        roundRect(ctx, bx, barsTop + (barH - h), barW, h, 3);
        ctx.fill();
      }
      ctx.fillStyle = MUTED;
      ctx.font = `500 20px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.fillText(`${r}★ ${stats.dist[r]}`, bx + barW / 2, barsTop + barH + 34);
      ctx.textAlign = 'left';
      bx += barW + barGap;
    }

    return canvas;
  }

  root.HashShelfLib = {
    parseCsv,
    parseGoodreadsCsv,
    cleanIsbn,
    commentHasUrl,
    nameHasUrl,
    stripUrls,
    normalizeGenres,
    toIsbn10,
    toIsbn13,
    buyLinks,
    affiliateActive,
    identityKey,
    compareShelves,
    buildStats,
    renderWrappedCard
  };
})(typeof window !== 'undefined' ? window : globalThis);
