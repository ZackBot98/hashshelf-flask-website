# HashShelf

A fully client‑side, hash‑driven book tracker. No accounts. No backend. A link is the data.

## What it does

- Add books by OpenLibrary Work ID (e.g. `OL45883W`) or ISBN.
- Set rating (0–5), status (want/reading/read), and an optional comment.
- Hydrate titles/authors/covers from OpenLibrary, cached for 7 days (localStorage + Service Worker).
- Live snapshot: the URL hash updates as you edit. Click “Create HashShelf” to copy the link.
- Open any snapshot link to reconstruct the list deterministically.
- Optional name/title shown as “<name>’s books” (stored locally and in the hash).
- Works offline after first load.

## Snapshot format

- Canonical JSON (deterministic ordering/whitespace):

```json
{
  "v": 1,
  "name": "optional string",
  "books": [
    { "idType": "work"|"edition"|"isbn", "id": "string", "rating": 0, "comment": "string", "status": "want|reading|finished" }
  ]
}
```

- Canonicalization rules:
  - `books` normalized and sorted by `id` asc (tie‑break by `idType`).
  - Keys inserted in fixed order; empty/undefined fields omitted; comments trimmed.
- Payload = deflate (fflate) of the canonical JSON, base64‑url encoded
- Integrity suffix = first 12 hex chars of SHA‑256(payload) (48‑bit)
- Final link: `https://host/#<payload>.<hash>`

## Architecture

- 100% client‑side. No writes to any network. All state lives in:
  - URL hash (shareable, deterministic snapshot)
  - `localStorage` (draft edits, hydration cache, name, UI state)
  - Service Worker cache (assets + API responses with TTL)
- Hashing: baseline JS SHA‑256 (no secure‑context requirement). Integrity still 48‑bit.
- Compression: fflate

## Hydration (OpenLibrary)

- Work JSON: `https://openlibrary.org/works/<id>.json`
- ISBN/Edition JSON: first `https://openlibrary.org/isbn/<isbn>.json`, fallback `https://openlibrary.org/books/<id>.json`
- Covers: `https://covers.openlibrary.org/b/id/<coverId>-M.jpg`
- Caching:
  - `localStorage` key `bookCache:<idType>:<id>` with 7‑day TTL
  - Service Worker: cache‑first with 7‑day TTL for OpenLibrary and cover domains; serves stale on errors

## UI Overview

- Editor
  - Title + Name (optional). If blank, shows “Your books”.
  - Search by title (OpenLibrary Search suggestions). Selecting fills Work/ISBN and shows cover.
  - Fields: ID Type, ID, Rating, Status, Comment; cover preview on the right.
  - Status filter dropdown (All/Want/Reading/Read) above the list.
  - “Create HashShelf” copies the current link to clipboard, with robust fallbacks (execCommand, Web Share).
- Viewer
  - Renders a decoded snapshot; hydrates metadata (cached). Filter available.

## Develop locally

- Python

```bash
python -m http.server 5173
```

- Node

```bash
npx http-server -p 5173
# or
npx serve -l 5173
```

Open `http://localhost:5173`.

Notes:
- On plain HTTP over LAN, everything works (baseline SHA‑256 and copy fallbacks are included). For the best clipboard and PWA behavior on mobile, serve over HTTPS.

## Deploy

### Cloudflare Pages (no build)

- Push to GitHub
- Cloudflare Pages → Create Project → Connect repo
- Framework preset: None
- Build command: (leave blank)
- Output directory: `/`
- Alternatively, drag‑and‑drop the folder

Optional headers for better caching (create a `_headers` file at repo root):

```
/service-worker.js
  Cache-Control: no-cache

/*.css
  Cache-Control: public, max-age=31536000, immutable

/*.js
  Cache-Control: public, max-age=31536000, immutable
```

### GitHub Pages / Netlify / Vercel

- It’s a static site; publish the root directory as is. Hash routing needs no rewrites.

## Project structure

```
index.html        # SPA shell
styles.css        # Dark theme + layout
snapshot.js       # Canonicalize + deflate + base64url + SHA‑256 integrity
openlibrary.js    # Hydration + 7d caching
ui.js             # Rendering, events, filters, clipboard, live hash
service-worker.js # Asset + API cache (7d TTL), offline support
```

## Security & privacy

- Snapshots are deterministic, integrity‑checked (48‑bit suffix), and shareable via URL hash.
- No backend writes. Hydration fetches are GETs to OpenLibrary. Snapshot data itself never leaves the browser except via the link you share.

## Accessibility & mobile

- Inputs use ≥16px font to avoid iOS auto‑zoom.
- Copy flow has fallbacks for older/locked‑down browsers (execCommand/Web Share).

## License

Add your preferred license here (e.g., MIT).
