# HashShelf test plan

Three automated suites plus a manual checklist. Everything here runs from the
repo root. The rule of thumb: **automated suites before every commit; the
manual smoke before every deploy; the full manual pass before a DNS swap.**

## 1. Automated suites

| Suite | Command | Covers |
|---|---|---|
| Snapshot encoding | `node tests/test-snapshot.js` | Portable SHA-256 vs Node crypto across 201 padding boundaries; encode/decode roundtrip with unicode; order-independent (deterministic) encoding; keep-last dedupe; locale-independent sort; tamper rejection; legacy `#v1.` links; malformed-input rejection; **`sanitizeName` boundary** — comments dropped, and names stripped of URLs/exotic-TLD domains/zero-width+bidi chars/fullwidth homoglyphs on both encode & decode, capped by code point (no surrogate split) |
| Client logic | `node tests/test-lib.js` | CSV parser edge cases (quoted commas, embedded newlines, escaped quotes); Goodreads mapping (statuses, custom DNF shelves, rating-0-means-unrated, ISBN-13 preference, Excel `="…"` guards); genre normalization parity cases against `genres.json`; compare (cross-ID matching via workId, disagreements, overlap); wrapped-card stats |
| Server | `python -m unittest discover tests -v` | Hermetic (no network, temp DB, OpenLibrary mocked): genre rules; redirect following; ID validation; token bucket; static allowlist (source files must 404); legal pages render + cross-link; **short links fully removed** (`/api/snapshot` + `/s/<slug>` 404, `snapshots` table dropped, helpers gone); **request-body size cap** (413 on oversized POST); **security headers on error responses** (via WSGI middleware); **search cached under a hash, raw query never stored**; bulk hydration assembly + caching; **failures-never-cached**; edition-borrows-work metadata |

All three must pass before any commit. They need no server running and no
network access.

## 2. Manual test plan

### 2.1 Core flows (run against `python server.py`, http://localhost:8000)

- [ ] Search by title → "Searching the catalog…" shows immediately, then suggestions with covers; gibberish shows a no-matches row; Escape dismisses → select → form fills with work ID + cover preview
- [ ] Add book with rating/status → row renders, hydrates title/author/cover/genre chips (no comment field exists)
- [ ] Add the same book again → updates in place with notice, no duplicate
- [ ] Edit and Delete a row; rating `0` displays as `0 ★`, unrated as `No rating`
- [ ] URL hash updates live as you edit; an empty shelf → clean URL
- [ ] Reload mid-edit → returns to **editor** (not viewer), draft intact
- [ ] Create HashShelf → link copied; paste in new private window → viewer renders
- [ ] Open the `#…` link in a private window → viewer renders identically
- [ ] Viewer: status filter works; "Copy to my shelf" imports and lands in editor with clean URL
- [ ] Corrupt a link character → "Link corrupted" notice, editor still usable

### 2.2 v1.3 features

- [ ] Import a real `goodreads_library_export.csv` → correct counts in notice; skipped-no-ISBN titles listed; statuses/ratings mapped (reviews are not imported)
- [ ] Shelves: create, rename, delete (blocked at one shelf); books isolated per shelf; counts in dropdown; survives reload; renaming updates the live link and the shared title
- [ ] Genre filter populates from hydrated books and filters correctly; status+genre combine
- [ ] Compare: paste a link; tiles + four sections render; "Add their N books" merges as `want`
- [ ] Viewer → "Compare with mine" works
- [ ] Buy links: rows show Amazon + Audiobook chips carrying the affiliate tag; disclosure footer visible; both vanish if `config.js` ids are cleared
- [ ] Year in review: card renders **with covers**; Download saves a PNG; Share shows native sheet (mobile); works on an empty-ratings shelf (avg shows `—`)

### 2.3 Static hosting (no backend — now at full parity)

Stop `server.py`, serve statically: `python -m http.server 8000`, hard-reload.

- [ ] Editor, search, add, hydration all work (direct OpenLibrary, slower)
- [ ] Link sharing and viewing work; Create copies the link (with a length warning if huge)
- [ ] Compare works; pasting a retired `/s/…` short link shows a clear "short links removed" message
- [ ] Genres still appear (client-side mapping from `genres.json`)
- [ ] After a failed API call the app retries the API only after ~60s (no request spam in DevTools)

### 2.4 Device matrix (minimum bar per release)

| Check | Desktop Chrome | Desktop Firefox | iOS Safari | Android Chrome |
|---|---|---|---|---|
| Add + share + view link | ● | ● | ● | ● |
| Clipboard copy (fallback chain on iOS HTTP) | ● | — | ● | ● |
| Wrapped card render + share sheet | ● | ● | ● | ● |
| PWA install + offline reload (HTTPS only) | ● | — | ● | ● |
| Layout at 375px (no horizontal scroll) | ● | — | ● | ● |

### 2.5 Offline / service worker

- [ ] Load site (HTTPS or localhost) → airplane mode → reload → app shell loads, cached books still hydrate
- [ ] After deploying an asset change with a bumped `CACHE_NAME`: hard-refresh twice → new version active (check a visible change)
- [ ] SW must never serve a cached error: DevTools → simulate a 500 from OpenLibrary → retry succeeds

## 3. Release checklist

### Before `git push`
1. All three automated suites pass
2. `node --check` on changed JS; `python -m py_compile server.py`
3. If any static asset changed: bump `CACHE_NAME` in service-worker.js
4. Manual smoke: §2.1 first four items + one share/view roundtrip

### After CF Pages auto-deploy (static parity is expected)
5. hashshelf.com loads new UI; §2.3 spot-check (sharing works with no backend)

### After Render deploy (`.onrender.com`)
6. `/healthz` returns current version
7. Bulk hydrate a 5-book shelf (cold) → all `ok:true` on retry at worst
8. Short links gone: `curl -s -o /dev/null -w "%{http_code}" …/s/deadbeefdead` → 404; `POST /api/snapshot` → 404/405
9. Leak check: `/server.py`, `/render.yaml`, `/data/hashshelf.db`, `/tests/…` → all 404
10. Phone test on the real URL

### After DNS swap to Render
11. hashshelf.com serves `/healthz` (proves Flask, not Pages)
12. Old `#…` links from before the change still decode
13. Old `/s/…` short links now 404 (expected — feature removed)
14. PWA install prompt on mobile; SW updates from the old prod version cleanly
15. Watch Render logs for 10 minutes of organic traffic; then delete nothing —
    keep the CF Pages project as instant DNS rollback

## 4. Performance / abuse spot-checks (quarterly or before a launch push)

- [ ] Cold 20-book shelf renders progressively; warm shelf < 1s
- [ ] 200-book Goodreads import completes; UI stays responsive; OpenLibrary
      calls stay ≤ ~4/s in server logs (token bucket holding)
- [ ] No shelf-storage endpoints exist: `POST /api/snapshot` and `GET /s/<slug>` → 404
- [ ] SQLite file size sane (`data/hashshelf.db` grows with the book cache only, not unbounded; no `snapshots` table)

## 5. Known accepted limitations (do not chase as bugs)

- A few hydrations can fail during a large cold import under OpenLibrary
  throttling — never cached, self-heal on next view
- Very large shelves make very long links; the editor warns past ~8000 chars
  (trim the shelf or split it in two)
- Shelf management uses `prompt()`/`confirm()` — functional everywhere, polish later
- The prewarmer makes a slow trickle of OpenLibrary calls (≤ ~30 books/hour)
  on running servers — expected background noise in logs; `books_cached` in
  `/healthz` should climb over time. It never runs in tests or CI
