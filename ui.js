(function() {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const editorView = $('#editorView');
  const viewerView = $('#viewerView');
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

  

  const privacyToggle = null;
  const backToEditor = $('#backToEditor');
  const editorFilterSelect = $('#editorFilterSelect');
  const viewerFilterSelect = $('#viewerFilterSelect');
  const listTitle = $('#listTitle');
  const displayName = $('#displayName');
  const LS_NAME = 'displayName';

  const LS_BOOKS = 'booksDraft';
  const LS_PRIVACY = null;

  let books = loadDraftBooks();
  let editIndex = null;
  let suggestions = [];
  let activeSuggestion = -1;
  let searchDebounce = null;
  let allowViewerFromHash = false;

  async function updateLiveHash() {
    try {
      const hash = await HashShelfSnapshot.encodeSnapshot(books, (displayName?.value || '').trim());
      const url = `${location.origin}${location.pathname}${hash}`;
      history.replaceState(null, '', url);
      if (snapshotLinkInput) {
        snapshotLinkInput.value = url;
        snapshotOutput.classList.remove('is-hidden');
      }
    } catch {}
  }

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
    // Try modern clipboard first
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    // Fallback to execCommand
    const ok = await legacyCopyText(text);
    if (ok) return true;
    // As a last resort, try Web Share (lets the user share/copy manually)
    try {
      if (navigator.share) {
        await navigator.share({ title: 'HashShelf Snapshot', url: text, text });
        return true;
      }
    } catch {}
    return false;
  }

  function loadDraftBooks() {
    try {
      const raw = localStorage.getItem(LS_BOOKS);
      if (raw) return JSON.parse(raw);
    } catch {}
    return [];
  }
  function saveDraftBooks() {
    try { localStorage.setItem(LS_BOOKS, JSON.stringify(books)); } catch {}
  }

  function loadPrivacy() {
    try { return localStorage.getItem(LS_PRIVACY) === '1'; } catch { return false; }
  }
  function savePrivacy(val) {
    try { localStorage.setItem(LS_PRIVACY, val ? '1' : '0'); } catch {}
  }

  function showNotice(msg, kind) {
    if (!msg) { noticeEl.classList.add('is-hidden'); return; }
    noticeEl.textContent = msg;
    noticeEl.className = 'notice ' + (kind || '');
  }

  function renderEditorList() {
    editorList.innerHTML = '';
    const name = (displayName?.value || '').trim();
    if (listTitle) listTitle.textContent = name ? `${name}'s books` : 'Your books';
    if (!books.length) {
      const empty = document.createElement('div');
      empty.className = 'card';
      empty.textContent = 'No books yet. Add one above to get started.';
      editorList.appendChild(empty);
      return;
    }
    const canHydrate = true;
    const selectedVal = editorFilterSelect?.value || 'all';
    for (let i = 0; i < books.length; i++) {
      const b = books[i];
      if (selectedVal !== 'all' && b.status !== selectedVal) continue;
      const item = document.createElement('div');
      item.className = 'book-item';
      const cover = document.createElement('img');
      cover.className = 'cover';
      cover.alt = 'cover';
      cover.src = '';
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
      rating.textContent = b.rating !== undefined ? '★'.repeat(b.rating) : 'No rating';
      const status = document.createElement('span');
      status.className = 'tag';
      status.textContent = b.status;
      const comment = document.createElement('div');
      comment.className = 'authors';
      comment.textContent = b.comment || '';
      const actions = document.createElement('div');
      actions.className = 'actions';
      const editBtn = document.createElement('button');
      editBtn.className = 'secondary';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => beginEdit(i));
      const delBtn = document.createElement('button');
      delBtn.className = 'secondary';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => { books.splice(i, 1); saveDraftBooks(); renderEditorList(); updateLiveHash(); });
      actions.append(editBtn, delBtn);
      tags.append(rating, status);
      meta.append(title, authors, tags, comment);
      item.append(cover, meta, actions);
      editorList.appendChild(item);

      if (canHydrate) {
        OpenLibrary.fetchBookMeta(b.idType, b.id).then((m) => {
          title.textContent = m.title || title.textContent;
          authors.textContent = (m.authors && m.authors.join(', ')) || '';
          if (m.coverUrl) cover.src = m.coverUrl;
        }).catch(() => {});
      }
    }
  }

  function clearSuggestions() {
    suggestions = [];
    activeSuggestion = -1;
    titleSuggestionsEl.innerHTML = '';
    titleSuggestionsEl.classList.add('is-hidden');
  }

  function suggestionItemTemplate(s, idx) {
    const item = document.createElement('div');
    item.className = 'suggestion-item' + (idx === activeSuggestion ? ' active' : '');
    const img = document.createElement('img');
    img.className = 'suggestion-cover';
    img.alt = '';
    if (s.cover_i) img.src = `https://covers.openlibrary.org/b/id/${s.cover_i}-S.jpg`;
    const meta = document.createElement('div');
    const t = document.createElement('div');
    t.className = 'suggestion-title';
    t.textContent = s.title || 'Untitled';
    const a = document.createElement('div');
    a.className = 'suggestion-authors';
    a.textContent = Array.isArray(s.author_name) ? s.author_name.join(', ') : '';
    meta.append(t, a);
    const pill = document.createElement('div');
    pill.className = 'suggestion-pill';
    pill.textContent = (Array.isArray(s.isbn) && s.isbn.length) ? 'isbn' : 'work';
    item.append(img, meta, pill);
    item.addEventListener('click', () => { selectSuggestion(idx); });
    return item;
  }

  function renderSuggestions() {
    titleSuggestionsEl.innerHTML = '';
    if (!suggestions.length) { titleSuggestionsEl.classList.add('is-hidden'); return; }
    for (let i = 0; i < suggestions.length; i++) {
      titleSuggestionsEl.appendChild(suggestionItemTemplate(suggestions[i], i));
    }
    titleSuggestionsEl.classList.remove('is-hidden');
  }

  function extractWorkIdFromKey(key) {
    // key example: '/works/OL45883W'
    if (!key) return '';
    const m = String(key).match(/\/works\/(OL[^/]+W)/i);
    return m ? m[1] : '';
  }

  function chooseBestIsbn(doc) {
    const list = Array.isArray(doc?.isbn) ? doc.isbn : [];
    if (!list.length) return '';
    // Prefer 10-digit for shorter ID, then 13-digit
    const isbn10 = list.find(x => x && x.replace(/[^0-9Xx]/g, '').length === 10);
    if (isbn10) return isbn10.replace(/[^0-9Xx]/g, '');
    const isbn13 = list.find(x => x && x.replace(/[^0-9Xx]/g, '').length === 13);
    if (isbn13) return isbn13.replace(/[^0-9Xx]/g, '');
    // Fallback to first cleaned value
    return String(list[0]).replace(/[^0-9Xx]/g, '');
  }

  async function selectSuggestion(idx) {
    const s = suggestions[idx];
    if (!s) return;
    // Always resolve and store a Work ID, regardless of search mode
    let workId = extractWorkIdFromKey(s.key);
    if (!workId) {
      const isbn = chooseBestIsbn(s);
      if (isbn) {
        try {
          const res = await fetch(`https://openlibrary.org/isbn/${encodeURIComponent(isbn)}.json`, { credentials: 'omit' });
          if (res.ok) {
            const ed = await res.json();
            const wk = Array.isArray(ed?.works) && ed.works[0]?.key;
            const resolved = wk && extractWorkIdFromKey(wk);
            if (resolved) workId = resolved;
          }
        } catch {}
      }
    }
    if (!workId) return;
    idTypeEl.value = 'work';
    bookIdEl.value = workId;
    bookIdEl.title = workId;
    // Show cover preview from suggestion or fetch if needed
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
      if (s.cover_i) {
        show(`https://covers.openlibrary.org/b/id/${s.cover_i}-M.jpg`);
      } else {
        OpenLibrary.fetchBookMeta('work', workId).then(m => show(m.coverUrl)).catch(() => show(''));
      }
    }
    clearSuggestions();
    titleSearchEl.value = s.title || titleSearchEl.value;
    showNotice('Filled form from search. Adjust fields, then Add book.', 'ok');
  }

  function onSearchInput() {
    const q = titleSearchEl.value.trim();
    if (!q) { clearSuggestions(); return; }
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(async () => {
      try {
        const url = `https://openlibrary.org/search.json?title=${encodeURIComponent(q)}&limit=10&fields=key,title,author_name,cover_i,isbn`;
        const res = await fetch(url, { credentials: 'omit' });
        if (!res.ok) throw new Error('search failed');
        const data = await res.json();
        const docs = Array.isArray(data?.docs) ? data.docs : [];
        suggestions = docs.filter(d => d.key && d.title).slice(0, 10);
        activeSuggestion = -1;
        renderSuggestions();
      } catch {
        clearSuggestions();
      }
    }, 250);
  }

  function onSearchKeydown(e) {
    if (!suggestions.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeSuggestion = (activeSuggestion + 1) % suggestions.length;
      renderSuggestions();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeSuggestion = (activeSuggestion - 1 + suggestions.length) % suggestions.length;
      renderSuggestions();
    } else if (e.key === 'Enter') {
      if (activeSuggestion >= 0) { e.preventDefault(); selectSuggestion(activeSuggestion); }
    } else if (e.key === 'Escape') {
      clearSuggestions();
    }
  }

  function beginEdit(idx) {
    const b = books[idx];
    editIndex = idx;
    idTypeEl.value = b.idType;
    bookIdEl.value = b.id;
    bookIdEl.title = b.id;
    ratingEl.value = b.rating ?? '';
    statusEl.value = b.status;
    commentEl.value = b.comment || '';
    addBookBtn.textContent = 'Update book';
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

  function addOrUpdateBook(e) {
    e.preventDefault();
    const idType = idTypeEl.value.trim();
    const id = bookIdEl.value.trim();
    const ratingVal = ratingEl.value;
    const status = statusEl.value.trim();
    const comment = commentEl.value.trim();
    const rating = ratingVal === '' ? undefined : Number(ratingVal);
    if (!id) return;
    const entry = { idType, id, status, ...(rating !== undefined ? { rating } : {}), ...(comment ? { comment } : {}) };
    if (editIndex !== null) books[editIndex] = entry; else books.push(entry);
    saveDraftBooks();
    clearForm();
    renderEditorList();
    updateLiveHash();
  }

  async function createSnapshot() {
    try {
      const hash = await HashShelfSnapshot.encodeSnapshot(books, (displayName?.value || '').trim());
      const link = `${location.origin}${location.pathname}${hash}`;
      history.replaceState(null, '', link);
      const copied = await copyTextRobust(link);
      if (copied) {
        showNotice('successfully copied to clipboard', 'ok');
        setTimeout(() => showNotice('', ''), 1500);
      } else {
        snapshotLinkInput.value = link;
        snapshotOutput.classList.remove('is-hidden');
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
      if (ok) {
        showNotice('Link copied to clipboard.', 'ok');
        setTimeout(() => showNotice('', ''), 1500);
      }
    });
  }

  

  async function loadFromHashIfPresent() {
    const hash = location.hash;
    if (!hash || !hash.startsWith(HashShelfSnapshot.hashPrefix)) {
      switchToEditor();
      return;
    }
    try {
      const data = await HashShelfSnapshot.decodeFromHash(hash);
      if (viewerTitle) viewerTitle.textContent = data?.name ? `${data.name}'s books` : 'HashShelf';
      await renderViewer(data.books);
      switchToViewer();
    } catch (err) {
      console.error(err);
      showNotice('Link corrupted or outdated. Returning to editor.', 'error');
      switchToEditor();
    }
  }

  function switchToEditor() {
    viewerView.classList.add('is-hidden');
    editorView.classList.remove('is-hidden');
    snapshotOutput.classList.add('is-hidden');
  }

  function switchToViewer() {
    editorView.classList.add('is-hidden');
    viewerView.classList.remove('is-hidden');
  }

  async function renderViewer(booksList) {
    viewerList.innerHTML = '';
    const selectedVal = viewerFilterSelect?.value || 'all';
    const filtered = selectedVal === 'all' ? booksList : booksList.filter(b => b.status === selectedVal);
    const hydrated = await OpenLibrary.hydrateAll(filtered);
    for (const b of hydrated) {
      const item = document.createElement('div');
      item.className = 'book-item';
      const cover = document.createElement('img');
      cover.className = 'cover';
      cover.alt = 'cover';
      cover.src = b.meta.coverUrl || '';
      const meta = document.createElement('div');
      meta.className = 'meta';
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = b.meta.title || `${b.idType.toUpperCase()}: ${b.id}`;
      const authors = document.createElement('div');
      authors.className = 'authors';
      authors.textContent = (b.meta.authors && b.meta.authors.join(', ')) || '';
      const tags = document.createElement('div');
      tags.className = 'tags';
      const rating = document.createElement('span');
      rating.className = 'tag rating';
      rating.textContent = b.rating !== undefined ? '★'.repeat(b.rating) : 'No rating';
      const status = document.createElement('span');
      status.className = 'tag';
      status.textContent = b.status;
      const comment = document.createElement('div');
      comment.className = 'authors';
      comment.textContent = b.comment || '';
      tags.append(rating, status);
      meta.append(title, authors, tags, comment);
      const filler = document.createElement('div');
      item.append(cover, meta, filler);
      viewerList.appendChild(item);
    }
  }

  function initEvents() {
    $('#bookForm').addEventListener('submit', addOrUpdateBook);
    bookIdEl.addEventListener('input', () => { bookIdEl.title = bookIdEl.value; });
    titleSearchEl.addEventListener('input', onSearchInput);
    titleSearchEl.addEventListener('keydown', onSearchKeydown);
    titleSearchEl.addEventListener('blur', () => setTimeout(clearSuggestions, 120));
    clearFormBtn.addEventListener('click', clearForm);
    createSnapshotBtn.addEventListener('click', createSnapshot);
    copyLinkBtn.addEventListener('click', copyLink);
    

    backToEditor.addEventListener('click', (e) => { e.preventDefault(); allowViewerFromHash = false; history.replaceState(null, '', `${location.origin}${location.pathname}`); switchToEditor(); });
    window.addEventListener('hashchange', () => { if (allowViewerFromHash) loadFromHashIfPresent(); });

    editorFilterSelect?.addEventListener('change', () => renderEditorList());
    viewerFilterSelect?.addEventListener('change', () => loadFromHashIfPresent());
    displayName?.addEventListener('input', () => { try { localStorage.setItem(LS_NAME, (displayName.value || '').trim()); } catch {} renderEditorList(); updateLiveHash(); });
  }

  function init() {

    allowViewerFromHash = location.hash && location.hash.startsWith(HashShelfSnapshot.hashPrefix);
    try { const savedName = localStorage.getItem(LS_NAME); if (savedName && displayName) displayName.value = savedName; } catch {}
    renderEditorList();
    initEvents();
    if (allowViewerFromHash) loadFromHashIfPresent();
    else updateLiveHash();
  }

  document.addEventListener('DOMContentLoaded', init);
})();


