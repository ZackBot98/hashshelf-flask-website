# HashShelf

A hash-driven book tracker. No accounts. A link is the data.

Live at [hashshelf.com](https://hashshelf.com).

## What it does

- Add books by OpenLibrary Work ID (e.g. `OL45804W`) or ISBN, or search by title.
- Set rating (0–5), status (`want` / `reading` / `finished` / `did not finish`), and an optional comment.
- Hydrate titles/authors/covers/genres from OpenLibrary — via the HashShelf API cache when available, directly from OpenLibrary otherwise.
- **Multiple shelves**, switched locally; each shares as its own link.
- **Goodreads CSV import**: drop in a `goodreads_library_export.csv` and the shelf fills in. Maps Goodreads' shelves to statuses, keeps ratings and reviews, and reports rows it had to skip (no ISBN).
- **Compare shelves**: paste someone's link to see overlap, books only they have, and where your ratings disagree most — then add their books to your want list in one click.
- **Year in review**: a shareable PNG card (covers, counts, top authors/genres, rating distribution), rendered entirely client-side.
- Filter by status **and genre**; genres are derived from OpenLibrary subjects, not stored in the link.
- Live snapshot: the URL hash updates as you edit. "Create HashShelf" copies a shareable link (a short `/s/<slug>` link with a proper social preview when the backend is up, the full hash link otherwise).
- Open any snapshot link to reconstruct the list deterministically. "Copy to my shelf" imports someone else's shelf into your own.
- Each shelf's name is the title shown on links you share (it travels in the hash; the schema's `name` field carries it).
- Installable PWA; works offline after first load.

## Design invariant

**The URL hash is the source of truth.** The full hash link is always a complete, self-contained copy of the shelf. Everything server-side is either a cache of OpenLibrary (disposable) or a copy of a snapshot that also lives in its long link. Losing the backend never loses data, and the app still works served as plain static files.

## Snapshot format

Canonical JSON (deterministic ordering/whitespace):

```json
{
  "v": 1,
  "name": "optional string",
  "books": [
    { "idType": "work|edition|isbn", "id": "string", "rating": 0, "comment": "string", "status": "want|reading|finished|did not finish" }
  ]
}
```

Canonicalization rules:

- `books` normalized, deduped per `(idType, id)` (last write wins), and sorted by `id` asc (tie-break `idType`), using locale-independent code-unit comparison.
- Keys inserted in fixed order; empty/undefined fields omitted; comments trimmed.

Encoding:

- Payload = raw deflate (fflate, vendored) of the canonical JSON, base64-url encoded.
- Integrity suffix = first 12 hex chars of SHA-256 over the **deflated bytes** (48-bit). This detects corruption/truncation of shared links; it is a checksum, not authentication.
- Final link: `https://hashshelf.com/#<payload>.<hash>`
- Short link: `https://hashshelf.com/s/<slug>` where `slug` is a prefix of the SHA-256 digest — snapshots are content-addressed, so the same shelf always yields the same short link.

## Architecture

```
index.html         SPA shell (editor + viewer + compare + wrapped modal)
styles.css         Dark theme + layout
snapshot.js        Canonicalize + deflate + base64url + SHA-256 integrity
openlibrary.js     Metadata hydration: API-first with direct-OpenLibrary fallback
config.js          Affiliate ids (public by design) — the only file to edit to go live
lib.js             Pure logic: CSV import, genre mapping, compare, wrapped card, buy links
ui.js              Rendering, events, shelves, filters, clipboard, live hash
genres.json        Genre rules, shared by server.py and lib.js
service-worker.js  Asset + API cache (7d TTL), offline support
vendor/fflate.min.js  Vendored fflate 0.8.2 (hash-verified against npm)
server.py          Flask: static serving + API + short links + OG tags
render.yaml        Render blueprint
tests/             Unit tests (2 Node suites + hermetic Python server suite)
TESTING.md         Test plan: automated suites, manual matrix, release checklist
```

Run tests from the repo root:

```bash
node tests/test-snapshot.js
node tests/test-lib.js
python -m unittest discover tests
```

Client state lives in the URL hash (shareable snapshot), `localStorage` (shelves, hydration cache, own-link set), and the Service Worker cache. Shelves are stored under `shelves:v1`; a pre-v1.3 single `booksDraft` is migrated automatically on first load.

### Genres

OpenLibrary subjects are messy free text ("Fiction, science fiction, general", "nyt:bestseller", "Science-fiction"). `genres.json` maps them to a small display set and is the **single source of truth**, loaded by both the server and the browser. Matching is punctuation-insensitive, each subject counts toward at most one genre, and rules run specific-before-general so "Science fiction" never also counts as "Science". Genres are hydration metadata — they never enter the snapshot, so links stay compact.

### API (all optional — the client falls back to OpenLibrary directly)

- `POST /api/books` — bulk hydration: `{books: [{idType, id}]}` → assembled `{title, authors, coverUrl, genres, workId}` per book. SQLite-cached (60d TTL), so OpenLibrary is hit at most once per book per TTL across *all* users. The client batches same-tick requests, so rendering a whole shelf is one round trip.
- `GET /api/search?q=` — cached OpenLibrary search (24h TTL) with English-edition title/cover enrichment done server-side.
- `POST /api/snapshot` — validates a snapshot payload (integrity, deflate, schema) and stores it content-addressed; returns the short-link slug.
- `GET /api/snapshot/<slug>` — resolves a short link back to its payload (used by Compare).
- `GET /s/<slug>` — serves the app with per-shelf OpenGraph tags (link unfurls!) and the snapshot inlined.

Failures are never cached, stale data is served in preference to errors, upstream calls are rate-limited with a global token bucket and retried with backoff on 429/5xx, and concurrent identical hydrations are deduped. `workId` is what lets Compare match the same book added by ISBN on one shelf and by work ID on another.

Known rough edge: a large cold import can still see a few books fail hydration when OpenLibrary throttles. Those failures are never cached, the client falls back to calling OpenLibrary directly, and a later view fills them in.

## Develop locally

```bash
pip install -r requirements.txt
python server.py
```

Open `http://localhost:8000`. For phone testing on your LAN, use `http://<your-LAN-IP>:8000` (the app is designed to work on plain HTTP: portable SHA-256, clipboard fallbacks; the service worker itself requires HTTPS or localhost).

Static-only development still works too (`python -m http.server 5173` from the repo root) — the client just uses the direct OpenLibrary path.

## Deploy

### Render (current target)

The repo contains a `render.yaml` blueprint: Render → New → Blueprint → connect the repo. It runs `gunicorn` serving `server:app`.

- **Free plan:** spins down after ~15 min idle (the client's fallback path covers cold starts); filesystem is ephemeral, so the metadata cache rebuilds on restart — fine — but **short links do not survive restarts**. Upgrade to a paid instance + attach the disk in `render.yaml` before treating short links as permanent.
- Point `hashshelf.com` at the Render service (add the custom domain in Render, update the DNS record in Cloudflare, keep the proxy on for CDN caching). Bump `CACHE_NAME` in `service-worker.js` on deploys that change assets.

### Static hosting (Cloudflare Pages, GitHub Pages, Netlify…)

Still fully supported — publish the repo root as-is. Everything works except short links and per-shelf link previews (the client hydrates straight from OpenLibrary).

## Affiliate links

Buy links are off until an id is set in [`config.js`](config.js). With one set,
each book row gets a small "Buy" link and the required disclosure appears in the
footer; with none set, neither renders and the page is byte-identical to before.

- Amazon links use the ISBN-10 (which is the ASIN for print books), derived from
  the ISBN-13 when needed; 979-prefixed ISBNs and books with no ISBN fall back to
  a search link that still carries attribution.
- Books added by *work* id have no ISBN of their own, so hydration stores a
  representative English-edition ISBN (`work_editions.en_isbn`) — this is what
  lets every book link out, not just ISBN-added ones.
- Links carry `rel="sponsored nofollow noopener noreferrer"` and open in a new tab.
- No tracking scripts are added: these are plain outbound URLs, so the
  no-analytics, no-accounts posture is unchanged.

## Security & privacy

- Snapshots are deterministic and integrity-checked (corruption detection, not authentication — anyone can mint a valid link).
- Shelf data leaves the browser only via links you share, or when you explicitly mint a short link (which stores that snapshot server-side).
- The server stores no user identity: no accounts, no cookies, and nothing in the database ties data to a person. Short links are content-addressed blobs. (The hosting layer's standard access logs exist, as with any web host.)
- All rendering uses `textContent` — comments from shared links cannot inject HTML.

## License

Add your preferred license here (e.g., MIT).
