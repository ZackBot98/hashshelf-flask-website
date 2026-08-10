"""HashShelf server.

Serves the static app plus a small API:

  POST /api/books     bulk book-metadata hydration, backed by a SQLite cache
                      so OpenLibrary is hit at most once per book per TTL
  GET  /api/search    cached OpenLibrary search proxy with English-edition
                      title/cover enrichment done server-side
  POST /api/snapshot  content-addressed snapshot storage -> short link slug
  GET  /s/<slug>      serves the app with per-shelf OG tags + inlined snapshot
  GET  /healthz       health check for Render

Design invariant: the URL hash remains the source of truth. Everything in the
DB is either a cache of OpenLibrary (disposable) or a copy of a snapshot whose
canonical form still lives in the long link. Losing the DB never loses data.
"""

import html
import json
import logging
import os
import re
import sqlite3
import threading
import time
import zlib
from base64 import urlsafe_b64decode
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256

import requests
from flask import Flask, abort, jsonify, request, send_from_directory

APP_VERSION = "1.4.8"
ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("HASHSHELF_DB", os.path.join(ROOT, "data", "hashshelf.db"))
CONTACT = os.environ.get("HASHSHELF_CONTACT", "https://hashshelf.com")
USER_AGENT = f"HashShelf/{APP_VERSION} (+{CONTACT})"

OL_BASE = "https://openlibrary.org"
BOOK_TTL = 60 * 86400      # assembled book metadata is very stable
SEARCH_TTL = 1 * 86400
MAX_BOOKS_PER_REQUEST = 200
MAX_SNAPSHOT_PAYLOAD = 32 * 1024      # base64url chars; far beyond usable URL length
MAX_SNAPSHOT_INFLATED = 512 * 1024
MAX_SNAPSHOT_BOOKS = 1000

ALLOWED_ID_TYPES = {"work", "isbn", "edition"}
ALLOWED_STATUSES = {"want", "reading", "finished", "did not finish"}
ID_RE = re.compile(r"^[A-Za-z0-9 ._:-]{1,64}$")

STATIC_FILES = {
    "index.html", "about.html", "guide.html", "styles.css", "ui.js", "lib.js", "snapshot.js",
    "openlibrary.js", "service-worker.js", "manifest.json", "genres.json",
    "robots.txt", "config.js",
}
STATIC_DIRS = ("vendor/", "icons/")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("hashshelf")

app = Flask(__name__, static_folder=None)

# ------------------------------------------------------------------ genres

with open(os.path.join(ROOT, "genres.json"), encoding="utf-8") as _f:
    _GENRES = json.load(_f)


def _norm_subject(value):
    """Fold punctuation so 'Science-fiction' and 'Science fiction' match alike."""
    return re.sub(r"[^a-z0-9]+", " ", str(value).lower()).strip()


_GENRE_EXCLUDE = tuple(_norm_subject(x) for x in _GENRES["exclude"])
_GENRE_RULES = [(r["genre"], tuple(_norm_subject(m) for m in r["match"])) for r in _GENRES["rules"]]


def normalize_genres(subjects, limit=3):
    """Messy OpenLibrary subjects -> a few display genres, most-supported first.

    One subject contributes to at most one genre, and rules run specific
    before general, so "Science fiction" counts as Science Fiction and never
    also as Science. Ties break toward the earlier (more specific) rule.
    """
    hits = {}
    for subject in subjects or []:
        s = _norm_subject(subject)
        if not s or any(bad in s for bad in _GENRE_EXCLUDE):
            continue
        for idx, (genre, needles) in enumerate(_GENRE_RULES):
            if any(n in s for n in needles):
                count = hits[genre][0] if genre in hits else 0
                hits[genre] = (count + 1, idx)
                break
    ranked = sorted(hits.items(), key=lambda kv: (-kv[1][0], kv[1][1]))
    return [g for g, _ in ranked[:limit]]


# ---------------------------------------------------------------- database

_db_local = threading.local()


def db():
    conn = getattr(_db_local, "conn", None)
    if conn is None:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        conn = sqlite3.connect(DB_PATH, timeout=15)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=10000")
        conn.execute("PRAGMA synchronous=NORMAL")
        _db_local.conn = conn
    return conn


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS books (
          id_type TEXT NOT NULL, id TEXT NOT NULL,
          title TEXT, authors TEXT, cover_url TEXT, genres TEXT, work_id TEXT,
          fetched_at INTEGER NOT NULL,
          PRIMARY KEY (id_type, id)
        );
        CREATE TABLE IF NOT EXISTS authors (
          key TEXT PRIMARY KEY, name TEXT, fetched_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS work_editions (
          work_id TEXT PRIMARY KEY, en_title TEXT, en_cover_id INTEGER,
          en_isbn TEXT, fetched_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS searches (
          q TEXT PRIMARY KEY, results TEXT NOT NULL, fetched_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS snapshots (
          slug TEXT PRIMARY KEY, digest TEXT NOT NULL, payload TEXT NOT NULL,
          name TEXT, book_count INTEGER NOT NULL, created_at INTEGER NOT NULL
        );
        """
    )
    # Columns added after v1.2.0; CREATE TABLE IF NOT EXISTS won't backfill them
    have = {r[1] for r in conn.execute("PRAGMA table_info(books)")}
    for col in ("genres", "work_id", "isbn"):
        if col not in have:
            conn.execute(f"ALTER TABLE books ADD COLUMN {col} TEXT")
            # Existing rows predate the column; expire them so they re-hydrate
            conn.execute("UPDATE books SET fetched_at = 0")
    have_we = {r[1] for r in conn.execute("PRAGMA table_info(work_editions)")}
    if "en_isbn" not in have_we:
        conn.execute("ALTER TABLE work_editions ADD COLUMN en_isbn TEXT")
        conn.execute("UPDATE work_editions SET fetched_at = 0")
    conn.commit()
    conn.close()


# ------------------------------------------------- OpenLibrary politeness

class TokenBucket:
    """Global cap on upstream request rate, shared by all worker threads."""

    def __init__(self, rate=4.0, burst=8):
        self.rate, self.capacity = rate, burst
        self.tokens = float(burst)
        self.updated = time.monotonic()
        self.lock = threading.Lock()

    def acquire(self):
        while True:
            with self.lock:
                now = time.monotonic()
                self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate)
                self.updated = now
                if self.tokens >= 1:
                    self.tokens -= 1
                    return
                wait = (1 - self.tokens) / self.rate
            time.sleep(wait)


_bucket = TokenBucket()
_session = requests.Session()
_session.headers["User-Agent"] = USER_AGENT
_executor = ThreadPoolExecutor(max_workers=8)

_inflight_locks = {}
_inflight_mutex = threading.Lock()


def _key_lock(key):
    with _inflight_mutex:
        if len(_inflight_locks) > 10000:
            _inflight_locks.clear()
        return _inflight_locks.setdefault(key, threading.Lock())


_RETRY_STATUS = {429, 500, 502, 503, 504}


def ol_get(path, params=None, attempts=3):
    """GET with polite retry: bulk imports otherwise trip OpenLibrary's limiter."""
    last = None
    for attempt in range(attempts):
        _bucket.acquire()
        try:
            res = _session.get(f"{OL_BASE}{path}", params=params, timeout=(5, 12))
            if res.status_code in _RETRY_STATUS and attempt < attempts - 1:
                delay = float(res.headers.get("Retry-After") or 0) or (0.6 * (2 ** attempt))
                time.sleep(min(delay, 5.0))
                continue
            res.raise_for_status()
            return res.json()
        except requests.RequestException as err:
            last = err
            if attempt < attempts - 1:
                time.sleep(0.6 * (2 ** attempt))
    raise last or RuntimeError(f"OpenLibrary request failed: {path}")


# ------------------------------------------------------ hydration + cache

def _fresh(fetched_at, ttl):
    return fetched_at and (time.time() - fetched_at) < ttl


def get_author_name(key):
    """key like '/authors/OL23919A'. Cached forever-ish; author names don't move."""
    row = db().execute("SELECT name, fetched_at FROM authors WHERE key=?", (key,)).fetchone()
    if row and _fresh(row[1], BOOK_TTL * 6):
        return row[0]
    data = ol_get(f"{key}.json")
    name = data.get("name") or ""
    db().execute(
        "INSERT OR REPLACE INTO authors (key, name, fetched_at) VALUES (?,?,?)",
        (key, name, int(time.time())),
    )
    db().commit()
    return name


def _author_names(author_refs):
    names = []
    for ref in (author_refs or [])[:4]:
        key = None
        if isinstance(ref, dict):
            key = (ref.get("author") or {}).get("key") or ref.get("key")
        if not key or not str(key).startswith("/authors/"):
            continue
        try:
            name = get_author_name(str(key))
            if name:
                names.append(name)
        except Exception:
            pass
    return names


def _edition_isbn(ed):
    """Prefer ISBN-13 (universal); ISBN-10 converts to it losslessly client-side."""
    for field in ("isbn_13", "isbn_10"):
        for value in ed.get(field) or []:
            cleaned = re.sub(r"[^0-9Xx]", "", str(value)).upper()
            if len(cleaned) in (10, 13):
                return cleaned
    return None


def get_english_edition_pick(work_id):
    """Best English edition (title, cover, isbn) for a work, cached including misses."""
    row = db().execute(
        "SELECT en_title, en_cover_id, fetched_at, en_isbn FROM work_editions WHERE work_id=?",
        (work_id,),
    ).fetchone()
    if row and _fresh(row[2], BOOK_TTL):
        return row[0], row[1], row[3]
    en_title, en_cover, en_isbn = None, None, None
    try:
        data = ol_get(f"/works/{work_id}/editions.json", params={"limit": 100})
        for ed in data.get("entries") or []:
            langs = ed.get("languages") or []
            if not any("/languages/eng" in str(l.get("key", "")).lower() for l in langs if isinstance(l, dict)):
                continue
            en_title = ed.get("title") or en_title
            covers = ed.get("covers") or []
            if covers and not en_cover:
                en_cover = covers[0]
            if not en_isbn:
                en_isbn = _edition_isbn(ed)
            if en_title and en_cover and en_isbn:
                break
    except Exception:
        if row:
            return row[0], row[1], row[3]
        raise
    db().execute(
        "INSERT OR REPLACE INTO work_editions (work_id, en_title, en_cover_id, en_isbn, fetched_at)"
        " VALUES (?,?,?,?,?)",
        (work_id, en_title, en_cover, en_isbn, int(time.time())),
    )
    db().commit()
    return en_title, en_cover, en_isbn


def cover_url(cover_id):
    return f"https://covers.openlibrary.org/b/id/{cover_id}-M.jpg" if cover_id else None


def _redirect_target(data, pattern):
    """Merged OL records return a stub {'type': {'key': '/type/redirect'}, 'location': ...}."""
    if isinstance(data, dict) and (data.get("type") or {}).get("key") == "/type/redirect":
        m = re.match(pattern, str(data.get("location", "")))
        if m:
            return m.group(1)
    return None


def _subject_strings(data):
    out = []
    for field in ("subjects", "subject_places", "subject_times"):
        for s in data.get(field) or []:
            if isinstance(s, str):
                out.append(s)
    return out


def hydrate_work(work_id, _depth=0):
    data = ol_get(f"/works/{work_id}.json")
    target = _redirect_target(data, r"^/works/(OL[^/]+W)$")
    if target and _depth < 2:
        return hydrate_work(target, _depth + 1)
    title = data.get("title") or f"Work {work_id}"
    authors = _author_names(data.get("authors"))
    covers = data.get("covers") or []
    cover = covers[0] if covers else None
    canonical = re.sub(r"^/works/", "", str(data.get("key") or "")) or work_id
    isbn = None
    try:
        en_title, en_cover, en_isbn = get_english_edition_pick(canonical)
        if en_title:
            title = en_title
        if en_cover:
            cover = en_cover
        isbn = en_isbn
    except Exception:
        pass
    return {
        "title": title,
        "authors": authors,
        "coverUrl": cover_url(cover),
        "genres": normalize_genres(_subject_strings(data)),
        "workId": canonical,
        # Representative edition ISBN so work-added books can still link out
        "isbn": isbn,
    }


def hydrate_edition(id_or_isbn, _depth=0):
    try:
        data = ol_get(f"/isbn/{id_or_isbn}.json")
    except Exception:
        data = ol_get(f"/books/{id_or_isbn}.json")
    target = _redirect_target(data, r"^/books/(OL[^/]+M)$")
    if target and _depth < 2:
        return hydrate_edition(target, _depth + 1)
    title = data.get("title") or f"ISBN {id_or_isbn}"
    authors = _author_names(data.get("authors"))
    covers = data.get("covers") or []
    genres = normalize_genres(_subject_strings(data))

    # Edition records frequently omit authors and subjects; borrow them from
    # the parent work (and expose its id so compare can match this against a
    # work-id entry for the same book).
    work_id = None
    works = data.get("works") or []
    if works and isinstance(works[0], dict):
        m = re.match(r"^/works/(OL[^/]+W)$", str(works[0].get("key") or ""))
        if m:
            work_id = m.group(1)
    if work_id and (not genres or not authors):
        # Reuse the cached work row instead of refetching the parent work JSON
        # per sibling edition; also warms work:<id> for compare matching.
        parent = get_book("work", work_id)
        if parent.get("ok"):
            if not genres:
                genres = parent.get("genres") or []
            if not authors:
                authors = parent.get("authors") or []

    # An ISBN-typed id is itself the ISBN; otherwise read it off the edition
    isbn = re.sub(r"[^0-9Xx]", "", str(id_or_isbn)).upper()
    if len(isbn) not in (10, 13):
        isbn = _edition_isbn(data)

    return {
        "title": title,
        "authors": authors,
        "coverUrl": cover_url(covers[0] if covers else None),
        "genres": genres,
        "workId": work_id,
        "isbn": isbn,
    }


_BOOK_COLS = ("SELECT title, authors, cover_url, fetched_at, genres, work_id, isbn"
              " FROM books WHERE id_type=? AND id=?")


def _row_to_book(row):
    return {
        "title": row[0],
        "authors": json.loads(row[1]),
        "coverUrl": row[2],
        "genres": json.loads(row[4]) if row[4] else [],
        "workId": row[5],
        "isbn": row[6],
        "ok": True,
    }


def get_book(id_type, book_id):
    """Cache-first assembled metadata. Failures are never cached; stale beats nothing."""
    row = db().execute(_BOOK_COLS, (id_type, book_id)).fetchone()
    if row and _fresh(row[3], BOOK_TTL):
        return _row_to_book(row)

    lock = _key_lock(f"{id_type}:{book_id}")
    with lock:
        row = db().execute(_BOOK_COLS, (id_type, book_id)).fetchone()
        if row and _fresh(row[3], BOOK_TTL):
            return _row_to_book(row)
        try:
            value = hydrate_work(book_id) if id_type == "work" else hydrate_edition(book_id)
            db().execute(
                "INSERT OR REPLACE INTO books"
                " (id_type, id, title, authors, cover_url, genres, work_id, isbn, fetched_at)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (id_type, book_id, value["title"], json.dumps(value["authors"]), value["coverUrl"],
                 json.dumps(value["genres"]), value["workId"], value.get("isbn"), int(time.time())),
            )
            db().commit()
            return {**value, "ok": True}
        except Exception:
            log.warning("hydration failed for %s:%s", id_type, book_id, exc_info=True)
            if row:
                return _row_to_book(row)
            return {"title": None, "authors": [], "coverUrl": None, "genres": [], "workId": None, "isbn": None, "ok": False}


# ----------------------------------------------------------------- routes

@app.post("/api/books")
def api_books():
    body = request.get_json(force=True, silent=True) or {}
    items = body.get("books")
    if not isinstance(items, list) or not items:
        abort(400, "books must be a non-empty list")
    if len(items) > MAX_BOOKS_PER_REQUEST:
        abort(400, f"max {MAX_BOOKS_PER_REQUEST} books per request")

    todo = []
    for it in items:
        if not isinstance(it, dict):
            continue
        id_type = str(it.get("idType", "")).strip().lower()
        book_id = str(it.get("id", "")).strip()
        if id_type in ALLOWED_ID_TYPES and ID_RE.match(book_id):
            todo.append((id_type, book_id))
    todo = list(dict.fromkeys(todo))

    futures = {key: _executor.submit(get_book, *key) for key in todo}
    out = {}
    for (id_type, book_id), fut in futures.items():
        try:
            out[f"{id_type}:{book_id}"] = fut.result(timeout=45)
        except Exception:
            log.warning("book task failed for %s:%s", id_type, book_id, exc_info=True)
            out[f"{id_type}:{book_id}"] = {
                "title": None, "authors": [], "coverUrl": None, "genres": [], "workId": None, "isbn": None, "ok": False
            }
    resp = jsonify({"books": out})
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/api/search")
def api_search():
    q = re.sub(r"\s+", " ", str(request.args.get("q", ""))).strip().lower()
    if not q or len(q) > 200:
        abort(400, "missing or oversized q")

    row = db().execute("SELECT results, fetched_at FROM searches WHERE q=?", (q,)).fetchone()
    if row and _fresh(row[1], SEARCH_TTL):
        resp = jsonify(json.loads(row[0]))
        resp.headers["Cache-Control"] = "public, max-age=3600"
        return resp

    try:
        data = ol_get(
            "/search.json",
            params={"q": q, "limit": 10, "fields": "key,title,author_name,cover_i,isbn"},
        )
    except Exception:
        if row:  # stale beats nothing
            resp = jsonify(json.loads(row[0]))
            resp.headers["Cache-Control"] = "public, max-age=300"
            return resp
        abort(502, "search upstream failed")

    docs = []
    for d in (data.get("docs") or [])[:10]:
        if not isinstance(d, dict) or not d.get("key") or not d.get("title"):
            continue
        docs.append({
            "key": d.get("key"),
            "title": d.get("title"),
            "author_name": d.get("author_name") or [],
            "cover_i": d.get("cover_i"),
            "isbn": (d.get("isbn") or [])[:5],
        })

    # English-edition enrichment for the top hits, using the shared editions cache
    for d in docs[:5]:
        m = re.match(r"^/works/(OL[^/]+W)$", str(d["key"]), re.I)
        if not m:
            continue
        try:
            en_title, en_cover, _ = get_english_edition_pick(m.group(1))
            if en_title:
                d["en_title"] = en_title
            if en_cover:
                d["en_cover_i"] = en_cover
        except Exception:
            pass

    result = {"docs": docs, "enriched": True}
    db().execute(
        "INSERT OR REPLACE INTO searches (q, results, fetched_at) VALUES (?,?,?)",
        (q, json.dumps(result), int(time.time())),
    )
    db().commit()
    resp = jsonify(result)
    resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp


def _validate_snapshot_payload(payload):
    """payload is '<base64url>.<12 hex>'. Returns (digest_hex, name, book_count)."""
    if not isinstance(payload, str) or len(payload) > MAX_SNAPSHOT_PAYLOAD:
        abort(400, "payload missing or too large")
    m = re.match(r"^([A-Za-z0-9_-]+)\.([0-9a-f]{12})$", payload)
    if not m:
        abort(400, "malformed payload")
    b64u, integrity = m.groups()
    try:
        raw = urlsafe_b64decode(b64u + "=" * (-len(b64u) % 4))
    except Exception:
        abort(400, "bad base64url")
    digest = sha256(raw).hexdigest()
    if digest[:12] != integrity:
        abort(400, "integrity mismatch")
    try:
        inflated = zlib.decompressobj(-15).decompress(raw, MAX_SNAPSHOT_INFLATED + 1)
    except Exception:
        abort(400, "bad deflate stream")
    if len(inflated) > MAX_SNAPSHOT_INFLATED:
        abort(400, "snapshot too large")
    try:
        data = json.loads(inflated)
    except Exception:
        abort(400, "invalid JSON")
    if not isinstance(data, dict) or data.get("v") != 1 or not isinstance(data.get("books"), list):
        abort(400, "unsupported schema")
    if len(data["books"]) > MAX_SNAPSHOT_BOOKS:
        abort(400, "too many books")
    name = data.get("name")
    if name is not None and (not isinstance(name, str) or len(name) > 120):
        abort(400, "bad name")
    for b in data["books"]:
        if not isinstance(b, dict) or set(b) - {"idType", "id", "rating", "comment", "status"}:
            abort(400, "bad book entry")
        if b.get("idType") not in ALLOWED_ID_TYPES or not isinstance(b.get("id"), str) or not ID_RE.match(b["id"]):
            abort(400, "bad book id")
        if b.get("status") not in ALLOWED_STATUSES:
            abort(400, "bad status")
        if "rating" in b and (not isinstance(b["rating"], int) or not 0 <= b["rating"] <= 5):
            abort(400, "bad rating")
        if "comment" in b and (not isinstance(b["comment"], str) or len(b["comment"]) > 2000):
            abort(400, "bad comment")
    return digest, (name or None), len(data["books"])


@app.post("/api/snapshot")
def api_snapshot():
    body = request.get_json(force=True, silent=True) or {}
    payload = body.get("payload")
    digest, name, count = _validate_snapshot_payload(payload)

    conn = db()
    slug = None
    for length in (12, 16, 24, 64):
        cand = digest[:length]
        row = conn.execute("SELECT digest FROM snapshots WHERE slug=?", (cand,)).fetchone()
        if row is None or row[0] == digest:
            slug = cand
            break
    if slug is None:
        abort(500, "slug space exhausted")
    conn.execute(
        "INSERT OR IGNORE INTO snapshots (slug, digest, payload, name, book_count, created_at) VALUES (?,?,?,?,?,?)",
        (slug, digest, payload, name, count, int(time.time())),
    )
    conn.commit()
    resp = jsonify({"slug": slug})
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/api/snapshot/<slug>")
def api_snapshot_get(slug):
    """Resolve a short link back to its payload (used by Compare)."""
    if not re.match(r"^[0-9a-f]{12,64}$", slug):
        abort(404)
    row = db().execute("SELECT payload FROM snapshots WHERE slug=?", (slug,)).fetchone()
    if row is None:
        abort(404)
    resp = jsonify({"payload": row[0]})
    resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp


def _read_index():
    with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as f:
        return f.read()


@app.get("/s/<slug>")
def snapshot_page(slug):
    if not re.match(r"^[0-9a-f]{12,64}$", slug):
        abort(404)
    row = db().execute(
        "SELECT payload, name, book_count FROM snapshots WHERE slug=?", (slug,)
    ).fetchone()
    if row is None:
        abort(404)
    payload, name, count = row
    title = f"{name} — HashShelf" if name else "A HashShelf shelf"
    plural = "book" if count == 1 else "books"
    desc = f"{count} {plural} · shared with HashShelf, the link-based book tracker. No accounts."

    page = _read_index()
    page = re.sub(r"<title>.*?</title>", f"<title>{html.escape(title)}</title>", page, count=1, flags=re.S)
    page = re.sub(
        r'(<meta property="og:title" content=")[^"]*(")',
        rf"\g<1>{html.escape(title)}\g<2>", page, count=1)
    page = re.sub(
        r'(<meta property="og:description" content=")[^"]*(")',
        rf"\g<1>{html.escape(desc)}\g<2>", page, count=1)
    page = re.sub(
        r'(<meta name="description" content=")[^"]*(")',
        rf"\g<1>{html.escape(desc)}\g<2>", page, count=1)
    page = re.sub(
        r'(<meta property="og:url" content=")[^"]*(")',
        rf"\g<1>{html.escape(request.base_url)}\g<2>", page, count=1)
    # payload alphabet is [A-Za-z0-9_.-], safe to inline verbatim
    bootstrap = f'<script>window.__HASHSHELF_SNAPSHOT__="#{payload}";</script>'
    page = page.replace("<script", bootstrap + "\n    <script", 1)
    return page, 200, {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600"}


@app.get("/healthz")
def healthz():
    # db_on_disk: True when the database lives on the persistent disk, i.e.
    # short links and the cache survive restarts. Diagnostic, not sensitive.
    return {"ok": True, "version": APP_VERSION, "db_on_disk": DB_PATH.startswith("/var/data")}


@app.get("/favicon.ico")
def favicon():
    return send_from_directory(os.path.join(ROOT, "icons"), "icon-192.png")


@app.get("/")
def index():
    return _read_index(), 200, {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache"}


@app.get("/<path:filename>")
def static_file(filename):
    if filename not in STATIC_FILES and not filename.startswith(STATIC_DIRS):
        abort(404)
    resp = send_from_directory(ROOT, filename)
    if filename == "service-worker.js":
        resp.headers["Cache-Control"] = "no-cache"
    else:
        resp.headers["Cache-Control"] = "public, max-age=300"
    return resp


init_db()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    app.run(host="0.0.0.0", port=port, threaded=True)
