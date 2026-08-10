(function() {
  const $ = (sel) => document.querySelector(sel);

  const editorView = $('#editorView');
  const viewerView = $('#viewerView');
  const compareView = $('#compareView');
  const noticeEl = $('#notice');

  const idTypeEl = $('#idType');
  const bookIdEl = $('#bookId');
  const titleSearchEl = $('#titleSearch');
  const titleSuggestionsEl = $('#titleSuggestions');
  const ratingEl = $('#rating');
  const statusEl = $('#status');
  const commentEl = $('#comment');
  const addBookBtn = $('#addBookBtn');
  const clearFormBtn = $('#clearFormBtn');
  const formCoverPreview = $('#formCoverPreview');

  const editorList = $('#editorList');
  const viewerList = $('#viewerList');
  const viewerTitle = $('#viewerTitle');

  const createSnapshotBtn = $('#createSnapshotBtn');
  const snapshotOutput = $('#snapshotOutput');
  const snapshotLinkInput = $('#snapshotLink');
  const copyLinkBtn = $('#copyLinkBtn');

  const backToEditor = $('#backToEditor');
  const importShelfBtn = $('#importShelfBtn');
  const compareWithMineBtn = $('#compareWithMineBtn');
  const editorFilterSelect = $('#editorFilterSelect');
  const editorGenreSelect = $('#editorGenreSelect');
  const viewerFilterSelect = $('#viewerFilterSelect');
  const listTitle = $('#listTitle');

  const shelfSelect = $('#shelfSelect');
  const newShelfBtn = $('#newShelfBtn');
  const renameShelfBtn = $('#renameShelfBtn');
  const deleteShelfBtn = $('#deleteShelfBtn');

  const importCsvBtn = $('#importCsvBtn');
  const csvFileInput = $('#csvFileInput');
  const compareBtn = $('#compareBtn');
  const wrappedBtn = $('#wrappedBtn');

  const compareLinkInput = $('#compareLink');
  const compareRunBtn = $('#compareRunBtn');
  const compareResults = $('#compareResults');
  const compareBack = $('#compareBack');

  const wrappedModal = $('#wrappedModal');
  const wrappedCanvasWrap = $('#wrappedCanvasWrap');
  const wrappedClose = $('#wrappedClose');
  const wrappedDownload = $('#wrappedDownload');
  const wrappedShare = $('#wrappedShare');

  const LS_BOOKS = 'booksDraft';          // pre-v1.3 single shelf; migrated on load
  const LS_SHELVES = 'shelves:v1';
  const LS_OWN_HASHES = 'ownHashes:v1';
  const APP_TITLE = 'HashShelf — Link-based book tracker';
  const LONG_LINK_WARN = 8000;

  // When loaded via a short link the pathname is /s/<slug>; live-hash URLs for
  // the user's own draft must be written against the app root instead.
  const APP_PATH = location.pathname.replace(/s\/[0-9a-f]{12,64}\/?$/i, '') || '/';

  let store = loadShelves();
  let books = activeShelf().books;
  let editIndex = null;
  let suggestions = [];
  let activeSuggestion = -1;
  let searchDebounce = null;
  let searchGen = 0;   // invalidates in-flight search + enrichment responses
  let viewerGen = 0;   // invalidates in-flight viewer hydration
  let editorGen = 0;   // invalidates in-flight editor hydration
  let lastViewerBooks = null; // decoded books currently shown in the viewer
  let wrappedCanvas = null;

  // ----------------------------------------------------------- shelf store

  function newId() {
    return 'sh_' + Math.random().toString(36).slice(2, 9);
  }

  function loadShelves() {
    try {
      const raw = localStorage.getItem(LS_SHELVES);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.shelves) && parsed.shelves.length) {
          for (const s of parsed.shelves) if (!Array.isArray(s.books)) s.books = [];
          return parsed;
        }
      }
    } catch {}
    // Migrate the pre-v1.3 single draft, or start fresh
    let legacy = [];
    try {
      const raw = localStorage.getItem(LS_BOOKS);
      const arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr)) legacy = arr.filter(b => b && typeof b.id === 'string' && typeof b.idType === 'string');
    } catch {}
    const id = newId();
    return { activeId: id, shelves: [{ id, name: 'My shelf', books: legacy }] };
  }

  function saveShelves() {
    try { localStorage.setItem(LS_SHELVES, JSON.stringify(store)); } catch {}
  }

  function activeShelf() {
    return store.shelves.find(s => s.id === store.activeId) || store.shelves[0];
  }

  // Persists the working array back into the active shelf.
  function saveBooks() {
    activeShelf().books = books;
    saveShelves();
  }

  function renderShelfSelect() {
    shelfSelect.innerHTML = '';
    for (const s of store.shelves) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.name} (${s.books.length})`;
      if (s.id === store.activeId) opt.selected = true;
      shelfSelect.appendChild(opt);
    }
    deleteShelfBtn.disabled = store.shelves.length <= 1;
  }

  function switchShelf(id) {
    if (!store.shelves.some(s => s.id === id)) return;
    store.activeId = id;
    books = activeShelf().books;
    saveShelves();
    clearForm();
    renderShelfSelect();
    renderEditorList();
    updateLiveHash();
  }

  // ------------------------------------------------------------- own links

  // A snapshot hash we generated ourselves opens the editor; anything else is
  // someone's shared link and opens the viewer. Multiple shelves means
  // several hashes can be "ours", so keep a small rolling set.
  function ownHashes() {
    try {
      const arr = JSON.parse(localStorage.getItem(LS_OWN_HASHES) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function rememberOwnHash(hash) {
    if (!hash) return;
    const arr = ownHashes().filter(h => h !== hash);
    arr.unshift(hash);
    try { localStorage.setItem(LS_OWN_HASHES, JSON.stringify(arr.slice(0, 30))); } catch {}
  }
  function isOwnHash(hash) {
    return !!hash && ownHashes().includes(hash);
  }

  function fetchWithTimeout(url, options = {}, timeoutMs = 3500) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(t));
  }

  async function updateLiveHash() {
    try {
      if (!books.length) {
        history.replaceState(null, '', `${location.origin}${APP_PATH}`);
        snapshotOutput.classList.add('is-hidden');
        return;
      }
      const hash = await HashShelfSnapshot.encodeSnapshot(books, activeShelf().name);
      const url = `${location.origin}${APP_PATH}${hash}`;
      history.replaceState(null, '', url);
      rememberOwnHash(hash);
      if (snapshotLinkInput && books.length) {
        snapshotLinkInput.value = url;
        snapshotOutput.classList.remove('is-hidden');
      }
    } catch {}
  }

  // ------------------------------------------------------------- clipboard

  async function legacyCopyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, 99999);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
    return ok;
  }

  async function copyTextRobust(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    const ok = await legacyCopyText(text);
    if (ok) return true;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'HashShelf Snapshot', url: text, text });
        return true;
      }
    } catch {}
    return false;
  }

  function showNotice(msg, kind, ms) {
    if (!msg) { noticeEl.textContent = ''; noticeEl.classList.add('is-hidden'); return; }
    noticeEl.textContent = msg;
    noticeEl.className = 'notice ' + (kind || '');
    if (ms) setTimeout(() => { if (noticeEl.textContent === msg) showNotice('', ''); }, ms);
  }

  function ratingText(r) {
    if (r === undefined || r === null || r === '') return 'No rating';
    const n = Math.max(0, Math.min(5, Math.round(Number(r))));
    if (!Number.isFinite(n)) return 'No rating';
    return n > 0 ? '★'.repeat(n) : '0 ★';
  }

  // Builds the shared shell of a list row; caller appends its own last column.
  function createBookItem(b) {
    const item = document.createElement('div');
    item.className = 'book-item';
    const cover = document.createElement('img');
    cover.className = 'cover';
    cover.alt = 'cover';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = `${b.idType.toUpperCase()}: ${b.id}`;
    const authors = document.createElement('div');
    authors.className = 'authors';
    const tags = document.createElement('div');
    tags.className = 'tags';
    const rating = document.createElement('span');
    rating.className = 'tag rating';
    rating.textContent = ratingText(b.rating);
    const status = document.createElement('span');
    status.className = 'tag';
    status.textContent = b.status;
    const genres = document.createElement('span');
    genres.className = 'genre-tags';
    const comment = document.createElement('div');
    comment.className = 'authors';
    comment.textContent = b.comment || '';
    const buy = document.createElement('div');
    buy.className = 'buy-links';
    tags.append(rating, status, genres);
    meta.append(title, authors, tags, comment, buy);
    item.append(cover, meta);
    return { item, coverEl: cover, titleEl: title, authorsEl: authors, genresEl: genres, buyEl: buy };
  }

  function paintMeta(slot, m) {
    if (m.title) slot.titleEl.textContent = m.title;
    slot.authorsEl.textContent = (m.authors && m.authors.join(', ')) || '';
    if (m.coverUrl) slot.coverEl.src = m.coverUrl;
    if (slot.genresEl) {
      slot.genresEl.innerHTML = '';
      for (const g of (m.genres || []).slice(0, 2)) {
        const chip = document.createElement('span');
        chip.className = 'tag genre';
        chip.textContent = g;
        slot.genresEl.appendChild(chip);
      }
    }
    if (slot.buyEl) {
      slot.buyEl.innerHTML = '';
      for (const link of HashShelfLib.buyLinks(m, window.HashShelfConfig)) {
        const a = document.createElement('a');
        a.className = 'buy-link';
        a.href = link.url;
        a.target = '_blank';
        // sponsored+nofollow is required by the affiliate programs; noopener
        // keeps the new tab from touching this page
        a.rel = 'sponsored nofollow noopener noreferrer';
        a.textContent = link.label;
        slot.buyEl.appendChild(a);
      }
    }
  }

  // ---------------------------------------------------------- editor list

  const knownGenres = new Set();

  function refreshGenreOptions() {
    if (!editorGenreSelect) return;
    const current = editorGenreSelect.value;
    const sorted = Array.from(knownGenres).sort();
    editorGenreSelect.innerHTML = '';
    const all = document.createElement('option');
    all.value = 'all';
    all.textContent = 'all';
    editorGenreSelect.appendChild(all);
    for (const g of sorted) {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g;
      editorGenreSelect.appendChild(opt);
    }
    editorGenreSelect.value = sorted.includes(current) || current === 'all' ? current : 'all';
  }

  async function renderEditorList() {
    const gen = ++editorGen;
    editorList.innerHTML = '';
    if (listTitle) listTitle.textContent = activeShelf().name;
    renderShelfSelect();

    if (!books.length) {
      const empty = document.createElement('div');
      empty.className = 'card';
      empty.textContent = 'No books yet. Add one above, or import a Goodreads CSV.';
      editorList.appendChild(empty);
      return;
    }

    const statusVal = editorFilterSelect?.value || 'all';
    const genreVal = editorGenreSelect?.value || 'all';
    let candidates = books
      .map((b, index) => ({ b, index }))
      .filter(({ b }) => statusVal === 'all' || b.status === statusVal);

    // Genre lives in hydration metadata, so filtering by it needs metadata first
    if (genreVal !== 'all') {
      const hydrated = await OpenLibrary.hydrateAll(candidates.map(c => c.b));
      if (gen !== editorGen) return;
      candidates = candidates.filter((c, i) => (hydrated[i].meta.genres || []).includes(genreVal));
      if (!candidates.length) {
        const empty = document.createElement('div');
        empty.className = 'card';
        empty.textContent = 'No books match this filter.';
        editorList.appendChild(empty);
        return;
      }
    }

    for (const { b, index } of candidates) {
      const slot = createBookItem(b);
      const actions = document.createElement('div');
      actions.className = 'actions';
      const editBtn = document.createElement('button');
      editBtn.className = 'secondary';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => beginEdit(index));
      const delBtn = document.createElement('button');
      delBtn.className = 'secondary';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => {
        books.splice(index, 1);
        saveBooks();
        renderEditorList();
        updateLiveHash();
      });
      actions.append(editBtn, delBtn);
      slot.item.append(actions);
      editorList.appendChild(slot.item);

      OpenLibrary.fetchBookMeta(b.idType, b.id).then((m) => {
        if (gen !== editorGen) return;
        paintMeta(slot, m);
        let added = false;
        for (const g of m.genres || []) if (!knownGenres.has(g)) { knownGenres.add(g); added = true; }
        if (added) refreshGenreOptions();
      }).catch(() => {});
    }
  }

  // ------------------------------------------------------------- suggestions

  function clearSuggestions() {
    searchGen++;
    suggestions = [];
    activeSuggestion = -1;
    titleSuggestionsEl.innerHTML = '';
    titleSuggestionsEl.classList.add('is-hidden');
  }

  // Status row inside the dropdown: "searching", "no matches", "failed".
  // Without it, slow or empty searches look identical to a dead input.
  function setSearchStatus(text, busy) {
    suggestions = [];
    activeSuggestion = -1;
    titleSuggestionsEl.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'suggestion-status' + (busy ? ' busy' : '');
    row.textContent = text;
    titleSuggestionsEl.appendChild(row);
    titleSuggestionsEl.classList.remove('is-hidden');
  }

  function suggestionItemTemplate(s, idx) {
    const item = document.createElement('div');
    item.className = 'suggestion-item' + (idx === activeSuggestion ? ' active' : '');
    const img = document.createElement('img');
    img.className = 'suggestion-cover';
    img.alt = '';
    const coverId = s.en_cover_i || s.cover_i;
    if (coverId) img.src = `https://covers.openlibrary.org/b/id/${coverId}-S.jpg`;
    const meta = document.createElement('div');
    const t = document.createElement('div');
    t.className = 'suggestion-title';
    t.textContent = s.en_title || s.title || 'Untitled';
    const a = document.createElement('div');
    a.className = 'suggestion-authors';
    a.textContent = Array.isArray(s.author_name) ? s.author_name.join(', ') : '';
    meta.append(t, a);
    const pill = document.createElement('div');
    pill.className = 'suggestion-pill';
    pill.textContent = 'work';
    item.append(img, meta, pill);
    item.addEventListener('click', () => { selectSuggestion(idx); });
    return item;
  }

  function renderSuggestions(enriched) {
    titleSuggestionsEl.innerHTML = '';
    if (!suggestions.length) { titleSuggestionsEl.classList.add('is-hidden'); return; }
    for (let i = 0; i < suggestions.length; i++) {
      titleSuggestionsEl.appendChild(suggestionItemTemplate(suggestions[i], i));
    }
    titleSuggestionsEl.classList.remove('is-hidden');
    if (!enriched) enrichSuggestionTitles(searchGen);
  }

  // Fallback-path enrichment (the API does this server-side). Holds direct
  // element references and checks the generation so late responses can never
  // patch a different query's list.
  function enrichSuggestionTitles(gen) {
    const maxProbe = Math.min(5, suggestions.length);
    for (let i = 0; i < maxProbe; i++) {
      const s = suggestions[i];
      if (!s || !s.key || s.en_title) continue;
      const item = titleSuggestionsEl.children[i];
      if (!item) continue;
      const tEl = item.querySelector('.suggestion-title');
      const imgEl = item.querySelector('.suggestion-cover');
      OpenLibrary.fetchWorkEditions(s.key).then((eds) => {
        if (gen !== searchGen) return;
        const eng = OpenLibrary.findEnglishEdition(eds);
        if (!eng) return;
        if (eng.title) {
          s.en_title = eng.title;
          if (tEl) tEl.textContent = eng.title;
        }
        const covers = Array.isArray(eng.covers) ? eng.covers : [];
        if (covers.length) {
          s.en_cover_i = covers[0];
          if (imgEl) imgEl.src = `https://covers.openlibrary.org/b/id/${covers[0]}-S.jpg`;
        }
      }).catch(() => {});
    }
  }

  function extractWorkIdFromKey(key) {
    if (!key) return '';
    const m = String(key).match(/\/works\/(OL[^/]+W)/i);
    return m ? m[1] : '';
  }

  function chooseBestIsbn(doc) {
    const list = Array.isArray(doc?.isbn) ? doc.isbn : [];
    if (!list.length) return '';
    const isbn10 = list.find(x => x && x.replace(/[^0-9Xx]/g, '').length === 10);
    if (isbn10) return isbn10.replace(/[^0-9Xx]/g, '');
    const isbn13 = list.find(x => x && x.replace(/[^0-9Xx]/g, '').length === 13);
    if (isbn13) return isbn13.replace(/[^0-9Xx]/g, '');
    return String(list[0]).replace(/[^0-9Xx]/g, '');
  }

  async function selectSuggestion(idx) {
    const s = suggestions[idx];
    if (!s) return;
    let workId = extractWorkIdFromKey(s.key);
    if (!workId) {
      const isbn = chooseBestIsbn(s);
      if (isbn) {
        // Goes through the cached/batched hydration path (API-first with
        // OpenLibrary fallback) instead of a direct upstream call.
        try {
          const meta = await OpenLibrary.fetchBookMeta('isbn', isbn);
          if (meta?.workId) workId = meta.workId;
        } catch {}
      }
    }
    if (!workId) {
      showNotice('Could not resolve that result to an OpenLibrary work. Try another result or enter an ID manually.', 'error');
      return;
    }
    idTypeEl.value = 'work';
    bookIdEl.value = workId;
    bookIdEl.title = workId;
    if (formCoverPreview) {
      const show = (url) => {
        if (url) {
          formCoverPreview.src = url;
          formCoverPreview.classList.remove('is-hidden');
        } else {
          formCoverPreview.src = '';
          formCoverPreview.classList.add('is-hidden');
        }
      };
      const coverId = s.en_cover_i || s.cover_i;
      if (coverId) show(`https://covers.openlibrary.org/b/id/${coverId}-M.jpg`);
      else OpenLibrary.fetchBookMeta('work', workId).then(m => show(m.coverUrl)).catch(() => show(''));
    }
    const chosenTitle = s.en_title || s.title || '';
    clearSuggestions();
    if (chosenTitle) titleSearchEl.value = chosenTitle;
    showNotice('Filled form from search. Adjust fields, then Add book.', 'ok', 3000);
  }

  function onSearchInput() {
    const q = titleSearchEl.value.trim();
    if (!q) { clearSuggestions(); return; }
    setSearchStatus('Searching the catalog', true); // immediate feedback, before the debounce
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(async () => {
      const gen = ++searchGen;
      try {
        const { docs, enriched } = await OpenLibrary.search(q, { limit: 10 });
        if (gen !== searchGen) return;
        if (!docs.length) {
          setSearchStatus(`No matches for “${q}” — try the exact title, or add by ISBN below`);
          return;
        }
        suggestions = docs;
        activeSuggestion = -1;
        renderSuggestions(enriched);
      } catch {
        if (gen === searchGen) setSearchStatus('Search unavailable — it will retry as you type');
      }
    }, 250);
  }

  function onSearchKeydown(e) {
    if (e.key === 'Escape') { clearSuggestions(); return; }
    if (!suggestions.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeSuggestion = (activeSuggestion + 1) % suggestions.length;
      renderSuggestions(true);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeSuggestion = (activeSuggestion - 1 + suggestions.length) % suggestions.length;
      renderSuggestions(true);
    } else if (e.key === 'Enter') {
      if (activeSuggestion >= 0) { e.preventDefault(); selectSuggestion(activeSuggestion); }
    } else if (e.key === 'Escape') {
      clearSuggestions();
    }
  }

  // ------------------------------------------------------------ book form

  function beginEdit(idx) {
    const b = books[idx];
    if (!b) return;
    editIndex = idx;
    idTypeEl.value = b.idType;
    bookIdEl.value = b.id;
    bookIdEl.title = b.id;
    ratingEl.value = b.rating ?? '';
    statusEl.value = b.status;
    commentEl.value = b.comment || '';
    addBookBtn.textContent = 'Update book';
    OpenLibrary.fetchBookMeta(b.idType, b.id).then((m) => {
      if (titleSearchEl && (m?.title || titleSearchEl.value === '')) {
        titleSearchEl.value = m?.title || titleSearchEl.value;
      }
      if (formCoverPreview) {
        if (m?.coverUrl) {
          formCoverPreview.src = m.coverUrl;
          formCoverPreview.classList.remove('is-hidden');
        } else {
          formCoverPreview.src = '';
          formCoverPreview.classList.add('is-hidden');
        }
      }
    }).catch(() => {});
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch {}
  }

  function clearForm() {
    editIndex = null;
    idTypeEl.value = 'work';
    bookIdEl.value = '';
    bookIdEl.title = '';
    ratingEl.value = '';
    statusEl.value = 'want';
    commentEl.value = '';
    addBookBtn.textContent = 'Add book';
    if (titleSearchEl) titleSearchEl.value = '';
    if (formCoverPreview) {
      formCoverPreview.src = '';
      formCoverPreview.classList.add('is-hidden');
    }
    clearSuggestions();
  }

  // Must match the server's snapshot validator (ID_RE, comment cap) so a book
  // that's addable is also always shortenable — otherwise the shelf works as a
  // long link but silently can't become a short link, and won't hydrate either.
  const ID_RE = /^[A-Za-z0-9 ._:-]{1,64}$/;
  const MAX_COMMENT = 2000;

  function addOrUpdateBook(e) {
    e.preventDefault();
    const idType = idTypeEl.value.trim();
    const id = bookIdEl.value.trim();
    const ratingVal = ratingEl.value;
    const status = statusEl.value.trim();
    const comment = commentEl.value.trim().slice(0, MAX_COMMENT);
    const rating = ratingVal === '' ? undefined : Number(ratingVal);
    if (!id) return;
    if (!ID_RE.test(id)) {
      showNotice('That ID has characters HashShelf can’t use. Use an OpenLibrary Work ID (e.g. OL45804W) or an ISBN, or pick a search result.', 'error');
      return;
    }
    const entry = { idType, id, status, ...(rating !== undefined ? { rating } : {}), ...(comment ? { comment } : {}) };
    if (editIndex !== null) {
      books[editIndex] = entry;
      for (let i = books.length - 1; i >= 0; i--) {
        if (i !== editIndex && books[i].idType === idType && books[i].id === id) books.splice(i, 1);
      }
    } else {
      const existing = books.findIndex(b => b.idType === idType && b.id === id);
      if (existing >= 0) {
        books[existing] = entry;
        showNotice('That book was already in your list — updated it.', 'ok', 3000);
      } else {
        books.push(entry);
      }
    }
    saveBooks();
    clearForm();
    renderEditorList();
    updateLiveHash();
  }

  // -------------------------------------------------------------- snapshot

  async function createSnapshot() {
    try {
      const hash = await HashShelfSnapshot.encodeSnapshot(books, activeShelf().name);
      const longLink = `${location.origin}${APP_PATH}${hash}`;
      history.replaceState(null, '', longLink);
      rememberOwnHash(hash);

      // Try to mint a short link (nicer to share, unfurls with a preview).
      // The long link is always a full copy of the data and works without it.
      let link = longLink;
      let labelled = 'link';
      try {
        const res = await fetchWithTimeout('/api/snapshot', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ payload: hash.slice(1) })
        }, 6000);
        if (res.ok) {
          const data = await res.json();
          if (data && data.slug) {
            link = `${location.origin}/s/${data.slug}`;
            labelled = 'short link';
          }
        }
      } catch {}

      const copied = await copyTextRobust(link);
      snapshotLinkInput.value = link;
      snapshotOutput.classList.remove('is-hidden');
      if (labelled === 'link' && longLink.length > LONG_LINK_WARN) {
        showNotice(`Link copied, but it is ${longLink.length} characters — some apps truncate links this long. Short links need the HashShelf backend, which is currently unreachable.`, 'error');
      } else if (copied) {
        showNotice(`Copied ${labelled} to clipboard.`, 'ok', 2500);
      } else {
        showNotice('Copy failed. Link shown below.', 'error');
      }
    } catch (err) {
      console.error(err);
      showNotice('Failed to create snapshot.', 'error');
    }
  }

  function copyLink() {
    const text = snapshotLinkInput.value;
    if (!text) return;
    copyTextRobust(text).then((ok) => {
      if (ok) showNotice('Link copied to clipboard.', 'ok', 1500);
    });
  }

  // ---------------------------------------------------------------- views

  function switchToEditor() {
    viewerView.classList.add('is-hidden');
    compareView.classList.add('is-hidden');
    editorView.classList.remove('is-hidden');
    document.title = APP_TITLE;
  }

  function switchToViewer() {
    editorView.classList.add('is-hidden');
    compareView.classList.add('is-hidden');
    viewerView.classList.remove('is-hidden');
  }

  function switchToCompare() {
    editorView.classList.add('is-hidden');
    viewerView.classList.add('is-hidden');
    compareView.classList.remove('is-hidden');
  }

  async function loadSnapshotHash(hashStr) {
    try {
      const data = await HashShelfSnapshot.decodeFromHash(hashStr);
      if (viewerTitle) viewerTitle.textContent = data?.name || 'A shared shelf';
      lastViewerBooks = data.books;
      switchToViewer();
      await renderViewer(data.books);
    } catch (err) {
      console.error(err);
      showNotice('Link corrupted or outdated. Returning to editor.', 'error');
      switchToEditor();
      updateLiveHash();
    }
  }

  // Progressive render: rows appear immediately with placeholder titles and
  // fill in as metadata arrives (one bulk API call via the batcher, or
  // per-book OpenLibrary fetches on the fallback path).
  async function renderViewer(booksList) {
    const gen = ++viewerGen;
    viewerList.innerHTML = '';
    const selectedVal = viewerFilterSelect?.value || 'all';
    const filtered = selectedVal === 'all' ? booksList : booksList.filter(b => b.status === selectedVal);
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'card';
      empty.textContent = 'No books match this filter.';
      viewerList.appendChild(empty);
      return;
    }
    const slots = filtered.map((b) => {
      const slot = createBookItem(b);
      slot.item.append(document.createElement('div'));
      viewerList.appendChild(slot.item);
      return { b, slot };
    });
    await Promise.all(slots.map(async ({ b, slot }) => {
      try {
        const m = await OpenLibrary.fetchBookMeta(b.idType, b.id);
        if (gen !== viewerGen) return;
        paintMeta(slot, m);
      } catch {}
    }));
  }

  function mergeIntoActiveShelf(incoming) {
    const byKey = new Map(books.map(b => [`${b.idType}:${b.id}`, b]));
    let added = 0, updated = 0;
    for (const b of incoming) {
      const key = `${b.idType}:${b.id}`;
      if (byKey.has(key)) updated++; else added++;
      byKey.set(key, { ...b });
    }
    books = Array.from(byKey.values());
    saveBooks();
    return { added, updated };
  }

  function importViewerBooks() {
    if (!lastViewerBooks || !lastViewerBooks.length) return;
    const { added, updated } = mergeIntoActiveShelf(lastViewerBooks);
    renderEditorList();
    switchToEditor();
    updateLiveHash();
    const parts = [`Imported ${added} book${added === 1 ? '' : 's'} into "${activeShelf().name}"`];
    if (updated) parts.push(`updated ${updated} you already had`);
    showNotice(parts.join(', ') + '.', 'ok', 5000);
  }

  // ----------------------------------------------------------- CSV import

  async function handleCsvFile(file) {
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) {
      showNotice('That file is larger than 12 MB — is it really a Goodreads export?', 'error');
      return;
    }
    showNotice('Reading export…', 'ok');
    let parsed;
    try {
      const text = await file.text();
      parsed = HashShelfLib.parseGoodreadsCsv(text);
    } catch (err) {
      showNotice(err.message || 'Could not read that CSV.', 'error');
      return;
    }
    if (!parsed.books.length) {
      showNotice(`No importable books found (${parsed.skipped.length} rows had no ISBN).`, 'error');
      return;
    }
    const { added, updated } = mergeIntoActiveShelf(parsed.books);
    renderEditorList();
    updateLiveHash();

    const bits = [`Imported ${added} book${added === 1 ? '' : 's'} into "${activeShelf().name}"`];
    if (updated) bits.push(`updated ${updated} already on the shelf`);
    if (parsed.skipped.length) {
      const names = parsed.skipped.slice(0, 3).map(s => s.title).join(', ');
      bits.push(`skipped ${parsed.skipped.length} without an ISBN (${names}${parsed.skipped.length > 3 ? '…' : ''}) — add those by title search`);
    }
    showNotice(bits.join('; ') + '.', 'ok');
  }

  // -------------------------------------------------------------- compare

  // Accepts a full URL or bare hash/slug and returns the snapshot hash string.
  async function resolveLinkToHash(input) {
    const raw = String(input || '').trim();
    if (!raw) throw new Error('Paste a HashShelf link first.');
    const hashIdx = raw.indexOf('#');
    if (hashIdx >= 0 && raw.length > hashIdx + 1) return raw.slice(hashIdx);
    const slugMatch = raw.match(/\/s\/([0-9a-f]{12,64})/i) || raw.match(/^([0-9a-f]{12,64})$/i);
    if (slugMatch) {
      const res = await fetchWithTimeout(`/api/snapshot/${slugMatch[1]}`, {}, 8000);
      if (!res.ok) throw new Error('That short link could not be found on this server.');
      const data = await res.json();
      if (!data?.payload) throw new Error('That short link returned nothing.');
      return `#${data.payload}`;
    }
    throw new Error('That does not look like a HashShelf link.');
  }

  async function toEntries(bookList) {
    const hydrated = await OpenLibrary.hydrateAll(bookList);
    return hydrated.map(h => ({
      key: HashShelfLib.identityKey(h, h.meta),
      book: h,
      meta: h.meta
    }));
  }

  function compareRow(entry, extra) {
    const row = document.createElement('div');
    row.className = 'compare-row';
    const cover = document.createElement('img');
    cover.className = 'cover-sm';
    cover.alt = '';
    if (entry.meta?.coverUrl) cover.src = entry.meta.coverUrl;
    const text = document.createElement('div');
    const t = document.createElement('div');
    t.className = 'title';
    t.textContent = entry.meta?.title || `${entry.book.idType.toUpperCase()}: ${entry.book.id}`;
    const sub = document.createElement('div');
    sub.className = 'authors';
    sub.textContent = extra || (entry.meta?.authors || []).join(', ');
    text.append(t, sub);
    row.append(cover, text);
    return row;
  }

  function compareSection(title, rows) {
    const wrap = document.createElement('div');
    wrap.className = 'card compare-section';
    const h = document.createElement('h3');
    h.textContent = `${title} (${rows.length})`;
    wrap.appendChild(h);
    if (!rows.length) {
      const none = document.createElement('div');
      none.className = 'authors';
      none.textContent = 'Nothing here.';
      wrap.appendChild(none);
    }
    for (const r of rows.slice(0, 50)) wrap.appendChild(r);
    if (rows.length > 50) {
      const more = document.createElement('div');
      more.className = 'authors';
      more.textContent = `…and ${rows.length - 50} more`;
      wrap.appendChild(more);
    }
    return wrap;
  }

  async function runCompare() {
    compareResults.innerHTML = '';
    compareRunBtn.disabled = true;
    showNotice('Comparing…', 'ok');
    try {
      const hash = await resolveLinkToHash(compareLinkInput.value);
      const theirData = await HashShelfSnapshot.decodeFromHash(hash);
      if (!books.length) throw new Error('Your shelf is empty — add books before comparing.');

      const [mine, theirs] = await Promise.all([toEntries(books), toEntries(theirData.books)]);
      const result = HashShelfLib.compareShelves(mine, theirs);
      const theirLabel = theirData.name || 'their shelf';
      showNotice('', '');

      const summary = document.createElement('div');
      summary.className = 'compare-summary';
      const tiles = [
        [`${result.overlapPct}%`, 'shelf overlap'],
        [String(result.both.length), 'books in common'],
        [String(result.onlyTheirs.length), `only on ${theirLabel}`],
        [String(result.onlyMine.length), 'only on yours']
      ];
      for (const [value, label] of tiles) {
        const tile = document.createElement('div');
        tile.className = 'card stat-tile';
        const v = document.createElement('div');
        v.className = 'stat-value';
        v.textContent = value;
        const l = document.createElement('div');
        l.className = 'stat-label';
        l.textContent = label;
        tile.append(v, l);
        summary.appendChild(tile);
      }
      compareResults.appendChild(summary);

      compareResults.appendChild(compareSection(
        `Both loved these`,
        result.agreements.map(a => compareRow(a.mine, `you ${ratingText(a.mine.book.rating)} · them ${ratingText(a.theirs.book.rating)}`))
      ));
      compareResults.appendChild(compareSection(
        `You disagree most on`,
        result.disagreements.map(d => compareRow(d.mine, `you ${ratingText(d.mine.book.rating)} · them ${ratingText(d.theirs.book.rating)}`))
      ));
      compareResults.appendChild(compareSection(
        `On ${theirLabel}, not yours`,
        result.onlyTheirs.map(e => compareRow(e))
      ));
      compareResults.appendChild(compareSection(
        `On your shelf, not theirs`,
        result.onlyMine.map(e => compareRow(e))
      ));

      if (result.onlyTheirs.length) {
        const actions = document.createElement('div');
        actions.className = 'row';
        const btn = document.createElement('button');
        btn.className = 'secondary';
        btn.textContent = `Add their ${result.onlyTheirs.length} book${result.onlyTheirs.length === 1 ? '' : 's'} to my want list`;
        btn.addEventListener('click', () => {
          const toAdd = result.onlyTheirs.map(e => ({ idType: e.book.idType, id: e.book.id, status: 'want' }));
          const { added } = mergeIntoActiveShelf(toAdd);
          renderEditorList();
          updateLiveHash();
          showNotice(`Added ${added} book${added === 1 ? '' : 's'} to "${activeShelf().name}" as want-to-read.`, 'ok', 4000);
        });
        actions.appendChild(btn);
        compareResults.appendChild(actions);
      }
    } catch (err) {
      showNotice(err.message || 'Compare failed.', 'error');
    } finally {
      compareRunBtn.disabled = false;
    }
  }

  // -------------------------------------------------------------- wrapped

  async function showWrapped() {
    if (!books.length) {
      showNotice('Add some books first — there is nothing to review yet.', 'error');
      return;
    }
    showNotice('Building your card…', 'ok');
    try {
      const hydrated = await OpenLibrary.hydrateAll(books);
      const stats = HashShelfLib.buildStats(hydrated.map(h => ({ book: h, meta: h.meta })));
      wrappedCanvas = await HashShelfLib.renderWrappedCard(stats, {
        name: activeShelf().name
      });
      wrappedCanvasWrap.innerHTML = '';
      wrappedCanvas.classList.add('wrapped-img');
      wrappedCanvasWrap.appendChild(wrappedCanvas);
      wrappedModal.classList.remove('is-hidden');
      wrappedShare.classList.toggle('is-hidden', !(navigator.canShare && navigator.share));
      showNotice('', '');
    } catch (err) {
      console.error(err);
      showNotice('Could not build the card.', 'error');
    }
  }

  function wrappedBlob() {
    return new Promise((resolve) => {
      if (!wrappedCanvas) return resolve(null);
      wrappedCanvas.toBlob(resolve, 'image/png');
    });
  }

  async function downloadWrapped() {
    const blob = await wrappedBlob();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'hashshelf-year-in-books.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function shareWrapped() {
    const blob = await wrappedBlob();
    if (!blob) return;
    const file = new File([blob], 'hashshelf-year-in-books.png', { type: 'image/png' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'My year in books' });
      } else {
        await downloadWrapped();
      }
    } catch {}
  }

  // --------------------------------------------------------------- events

  function initEvents() {
    $('#bookForm').addEventListener('submit', addOrUpdateBook);
    bookIdEl.addEventListener('input', () => { bookIdEl.title = bookIdEl.value; });
    titleSearchEl.addEventListener('input', onSearchInput);
    titleSearchEl.addEventListener('keydown', onSearchKeydown);
    titleSearchEl.addEventListener('blur', () => setTimeout(clearSuggestions, 120));
    clearFormBtn.addEventListener('click', clearForm);
    createSnapshotBtn.addEventListener('click', createSnapshot);
    copyLinkBtn.addEventListener('click', copyLink);

    backToEditor.addEventListener('click', (e) => {
      e.preventDefault();
      switchToEditor();
      updateLiveHash();
    });
    importShelfBtn?.addEventListener('click', importViewerBooks);
    compareWithMineBtn?.addEventListener('click', async () => {
      const hash = await HashShelfSnapshot.encodeSnapshot(lastViewerBooks || [], '');
      compareLinkInput.value = hash;
      switchToCompare();
      runCompare();
    });

    shelfSelect.addEventListener('change', () => switchShelf(shelfSelect.value));
    newShelfBtn.addEventListener('click', () => {
      const name = (prompt('Shelf name (this is the title on links you share):', 'New shelf') || '').trim();
      if (!name) return;
      const shelf = { id: newId(), name: name.slice(0, 60), books: [] };
      store.shelves.push(shelf);
      saveShelves();
      switchShelf(shelf.id);
      showNotice(`Created "${shelf.name}".`, 'ok', 2500);
    });
    renameShelfBtn.addEventListener('click', () => {
      const shelf = activeShelf();
      const name = (prompt('Rename shelf (this is the title on links you share):', shelf.name) || '').trim();
      if (!name) return;
      shelf.name = name.slice(0, 60);
      saveShelves();
      renderShelfSelect();
      renderEditorList();
      updateLiveHash();
    });
    deleteShelfBtn.addEventListener('click', () => {
      if (store.shelves.length <= 1) return;
      const shelf = activeShelf();
      if (!confirm(`Delete "${shelf.name}" and its ${shelf.books.length} book(s)? Any links you already shared keep working.`)) return;
      store.shelves = store.shelves.filter(s => s.id !== shelf.id);
      switchShelf(store.shelves[0].id);
      showNotice(`Deleted "${shelf.name}".`, 'ok', 2500);
    });

    importCsvBtn.addEventListener('click', () => csvFileInput.click());
    csvFileInput.addEventListener('change', () => {
      const file = csvFileInput.files && csvFileInput.files[0];
      csvFileInput.value = ''; // let the same file be picked again
      handleCsvFile(file);
    });

    compareBtn.addEventListener('click', () => {
      compareLinkInput.value = '';
      compareResults.innerHTML = '';
      switchToCompare();
    });
    compareBack.addEventListener('click', (e) => { e.preventDefault(); switchToEditor(); });
    compareRunBtn.addEventListener('click', runCompare);
    compareLinkInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runCompare(); });

    wrappedBtn.addEventListener('click', showWrapped);
    wrappedClose.addEventListener('click', () => wrappedModal.classList.add('is-hidden'));
    wrappedModal.addEventListener('click', (e) => { if (e.target === wrappedModal) wrappedModal.classList.add('is-hidden'); });
    wrappedDownload.addEventListener('click', downloadWrapped);
    wrappedShare.addEventListener('click', shareWrapped);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !wrappedModal.classList.contains('is-hidden')) wrappedModal.classList.add('is-hidden');
    });

    window.addEventListener('hashchange', () => {
      const hash = location.hash || '';
      if (hash && !isOwnHash(hash)) loadSnapshotHash(hash);
      else if (!hash) switchToEditor();
    });

    editorFilterSelect?.addEventListener('change', () => renderEditorList());
    editorGenreSelect?.addEventListener('change', () => renderEditorList());
    viewerFilterSelect?.addEventListener('change', () => { if (lastViewerBooks) renderViewer(lastViewerBooks); });
  }

  function init() {
    // Affiliate disclosure is required whenever buy links are live, and must
    // not appear when they are not.
    const disclosure = $('#affiliateDisclosure');
    if (disclosure && HashShelfLib.affiliateActive(window.HashShelfConfig)) {
      disclosure.classList.remove('is-hidden');
    }
    renderShelfSelect();
    renderEditorList();
    initEvents();

    // Short-link (/s/<slug>) pages carry the snapshot in a <meta> tag the
    // server injects — a meta, not an inline script, so the strict CSP allows it.
    const bootMeta = document.querySelector('meta[name="hashshelf-snapshot"]');
    const boot = bootMeta ? (bootMeta.getAttribute('content') || '') : '';
    const hash = location.hash || '';
    if (hash && !isOwnHash(hash)) {
      loadSnapshotHash(hash);           // someone else's snapshot link
    } else if (boot && !hash) {
      loadSnapshotHash(boot);           // short-link page, snapshot inlined by the server
    } else {
      switchToEditor();                 // fresh visit, or our own live-hash URL
      updateLiveHash();
    }
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/service-worker.js').catch(() => {});
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
