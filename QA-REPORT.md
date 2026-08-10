# HashShelf — Pre-Production QA Report

**Date:** 2026-08-10 · **Build at start:** v1.5.4 · **Build at finish:** v1.5.6
**Scope:** adversarial testing of the whole webapp (client codec, server API,
security, concurrency, browser behavior) as the final gate before launch.

## Verdict

**Ship it.** One critical vulnerability was found *and fixed* during this pass
(a path-traversal source disclosure that was live in production), plus two
lower-severity client-robustness gaps (also fixed). Everything else — the
snapshot codec, XSS handling, concurrency/DB integrity, input validation,
security headers — held up under deliberate attack. All fixes shipped with
regression tests; CI is green.

## Method

Testing was adversarial, not confirmatory: fuzzing, boundary/limit abuse,
malformed and hostile inputs, injection attempts, path traversal, decompression
bombs, and concurrency stress — run against a fresh local instance (isolated
temp DB) and, where safe, against production. A discipline note: several
apparent "failures" were traced to test-harness bugs, not product bugs, and are
recorded as such so the signal stays honest.

## Findings

### F1 — Path traversal / source disclosure — **CRITICAL** — FIXED (v1.5.5)

`GET /vendor/..%2fserver.py` returned **200 with server source**, live on
`hashshelf.com` and the Render origin. The URL-encoded `..%2f` passed the
`startswith("vendor/")` allowlist gate, and the installed Werkzeug's
`send_from_directory` resolved the `..` rather than rejecting it.

- **Reachable:** files in the app root (all already public in the repo) and one
  level up from `vendor/`/`icons/`. **Not** reachable: the SQLite database
  (`/var/data`, outside root) or anything outside root — deeper traversal
  (`../../etc/passwd`, backslashes) returned 400/404. So **no private data was
  exposed**, but it was a genuine allowlist bypass that must not ship.
- **Fix:** reject `..` in any encoding (the `%2f` form still contains the `..`
  substring) plus `/`- and `\`-prefixed names, and add a `realpath`
  containment check, before touching the filesystem — not relying on
  `send_from_directory`'s own safety. Regression test
  `test_path_traversal_blocked` locks 8 exploit encodings to 404.
- **Verified:** exploit now 404s with zero leak locally and on production.

### F2 — Client decompression bomb — **MEDIUM** — FIXED (v1.5.6)

`decodeFromHash` inflated shared-link payloads with no size bound. A 19 KB link
crafted to inflate to 20 MB did so in 51 ms; a larger one could freeze or crash
a visitor's tab. Since links come from anyone, untrusted decompression is a
real (annoyance-grade) client-side DoS. The **server** already guarded this
(`MAX_SNAPSHOT_INFLATED` 512 KB → 400); the client did not.

- **Fix:** bounded streaming inflate (`MAX_INFLATED` 1 MB, `MAX_PAYLOAD_B64`
  64 KB) — aborts a bomb in ~5 ms while a legitimate 1000-book shelf still
  decodes. Regression tests cover both.

### F3 — Client/server validation asymmetry — **LOW** — FIXED (v1.5.6)

The client accepted book states the server's snapshot validator rejects: a
manually-typed id with a comma/slash/unicode/`>64` chars, or a `>2000`-char
comment. Such a shelf worked as a long link but silently could not be
shortened (fell back to the long link) — and wouldn't hydrate anyway.

- **Fix:** the Add-book form now validates the id against the same `ID_RE` and
  caps comments at 2000 chars, with a helpful error — so anything addable is
  always shortenable. (Search-added books were never affected; this only
  touched manual ID-field entry.)

### F4 — HSTS missing from static-fallback `_headers` — **LOW** — FIXED (v1.5.6)

The Flask app sends `Strict-Transport-Security`, but the `_headers` file used
on the Cloudflare Pages rollback path omitted it (CSP and the rest matched
exactly). Added for parity so the fallback path is equally hardened.

## Verified robust (attacked, held)

| Area | Test | Result |
|---|---|---|
| Snapshot codec | 4000-case property fuzz: round-trip fidelity, integrity = SHA-256(deflated), order-independence (unique keys), tamper rejection | **0 real failures**; 4000/4000 real tampers rejected |
| XSS — client viewer | shelf name = `<img onerror><script>`, opened as a shared link | rendered as escaped text; tripwire never fired |
| XSS — server `/s/` page | same payload via OG tags + inlined snapshot | only escaped `&lt;img`; the one literal `<img` is the app's own element; no execution |
| Buy-link hrefs | hostile titles (`javascript:`, `" onmouseover=`) | always `https` scheme, query encoded |
| Path traversal (post-fix) | 8 encodings incl. `%2f`, `%5c`, `../`, nested | all 404, no leak |
| Concurrency | 60 distinct + 40 same-payload mints, 25 same-book hydrations, 120-op mixed hammer | DB `integrity_check: ok`, **0 duplicate slugs**, idempotent, no 5xx on DB paths |
| Rate-limit backpressure | thundering herd of cold upstream calls | queues behind the 4/s bucket; some search 502s → client falls back to direct OpenLibrary (by design) |
| Boundary validation | float rating, 201 books, 2500-char comment, 150-char name, empty/oversized search, uppercase slug | all correctly 400/404; 0-book and boundary-exact values accepted |
| HTTP methods | PUT/DELETE/PATCH on `/api/books`, GET on POST route, garbage JSON, 10 MB body | 405/404/400 — no crash |
| Malformed hashes | 6 corrupt fragments in a live tab | all handled gracefully, page alive |
| Security headers | CSP `script-src 'self'` (no inline anywhere), HSTS, nosniff, frame-deny, referrer, permissions | present on every response type; server ≡ `_headers` |

## Non-findings investigated & cleared

- **"Health check takes 2 s."** Reproducible only via Python `urllib` on this
  Windows box (uniform across *all* endpoints); the same requests are 0.22 s via
  curl and 194 ms on production, and the `COUNT(*)` DB path is 0.5 ms. A client
  measurement artifact, not a server issue.
- **Concurrency "502s."** The intentional 4 req/s OpenLibrary rate limiter
  applying backpressure to a synthetic thundering herd — not corruption or a
  crash (DB integrity verified clean).
- **Initial codec fuzz "83 failures."** Two harness bugs: flipping a base64
  padding bit (decodes to identical bytes, nothing to catch) and injecting
  conflicting duplicate keys (last-wins legitimately depends on order; the UI
  prevents that state). Corrected harness: 0 failures over 4000 cases.

## Regression coverage added

- `tests/test_server.py::test_path_traversal_blocked` — 8 exploit encodings
- `tests/test-snapshot.js` — decompression bomb rejected fast; 1000-book shelf
  still decodes under the cap
- `tests/test-lib.js` — audiobook + Amazon link construction (from the prior
  feature pass) remain green

Run all three suites from the repo root; CI also runs them on every push.
