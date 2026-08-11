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

### F5 — Short links broken by CSP — **CRITICAL** — FIXED (v1.5.8, post-launch-prep)

Found when a real short link was reported opening nothing. The `/s/` page handed
the snapshot to the app through an **inline `<script>`**, but the strict CSP
added in v1.4.9 (`script-src 'self'`) blocks inline scripts — so the bootstrap
never executed, `window.__HASHSHELF_SNAPSHOT__` stayed undefined, and every
short link fell back to the empty editor (then rewrote its URL to `/`). The
OpenGraph unfurl still worked (meta tags, not scripts), which masked it.
**Every short link had been broken since v1.4.9.**

- **Root cause / process gap:** the original QA pass tested the `/s/` page via
  `curl` (server output) and tested the viewer via `location.hash` in a browser,
  but never opened a real `/s/` short link *in a browser* after the CSP shipped.
  The server-rendered short-link path had no browser-level E2E coverage.
- **Fix:** pass the snapshot via a `<meta name="hashshelf-snapshot">` tag instead
  of an inline script — CSP-clean, no nonce needed. Regression test asserts the
  `/s/` page carries the meta tag and contains **zero inline scripts** (every
  `<script>` must have `src=`), which would have caught this.
- **Verified:** a real short link renders the full shelf in a browser with zero
  CSP violations, locally and on production.
- **Follow-on (v1.5.9):** the `/s/` HTML was served `max-age=3600` and the
  service worker was cache-first for navigations, so the fix was masked behind
  stale cached pages for already-visited links. Changed `/s/` to `no-cache` and
  the SW to network-first for navigations (offline still falls back to the
  cached shell). Fresh links + new visitors now work immediately; devices that
  cached a broken `/s/` page during the outage self-heal within ~1 h or on a
  hard refresh.

### F4 — HSTS missing from static-fallback `_headers` — **LOW** — FIXED (v1.5.6)

The Flask app sends `Strict-Transport-Security`, but the `_headers` file used
on the Cloudflare Pages rollback path omitted it (CSP and the rest matched
exactly). Added for parity so the fallback path is equally hardened.

## Campaign 2 — full feature + abuse audit (2026-08-10, v1.6.0 → v1.6.1)

A second adversarial pass after the abuse controls shipped, focused on malicious
content injection (URLs + XSS) and full feature coverage. 71/72 automated API
checks passed (the one "fail" was a wrong assertion — `GET /api/snapshot` with no
slug correctly 404s, not 405). Everything below was tested against a live local
instance and, where safe, production.

**The linchpin, proven end-to-end:** a maximally hostile *long* link — which
bypasses the server filter entirely, since long links are client-encoded and
never validated — was loaded in a real browser. Name = `<img onerror><script>` +
`</title>` breakout; comments = `http://evil…/phish`, `javascript:alert()`,
`data:text/html,<script>`, `<img onerror>`, `<svg onload>`. Result: **0 injected
scripts, 0 onerror images, 0 onload svgs, 0 clickable links to any user URL**,
clean console. Every payload rendered as inert text. The only anchors on any
shelf page are the app's own `https://…amazon.com` buy links. Confirmed on all
three render paths: long-link viewer, short-link viewer, and the server `/s/`
OG/title injection (all user values `html.escape`d).

### F6 — Rare/abuse TLDs bypassed the bare-domain name filter — **LOW** — FIXED (v1.6.1)

The v1.6.0 name filter blocked common bare domains (`.com/.net/…`) but not rare
or abuse-heavy TLDs, so a shelf named `invoice.zip` or `deals.pizza` stored.
Impact was capped (names are never clickable — only unfurl text), but `.zip`/
`.mov` are real file-lookalike phishing TLDs and worth closing. Extended the TLD
set (`_BARE_TLDS` in server.py, mirrored in lib.js) with file-lookalikes, cheap
phishing generics, and common ccTLDs. Verified no false positives on legitimate
names (`Vol. 2 favorites (J.R.R. picks)`, `C.S. Lewis`). Tests added both sides.

### Accepted residuals (all non-clickable, all low)

The URL filter is spam friction, not a classifier — the guarantee is that stored
text is never clickable or executable (proven above). These store but are inert:

- **Defanged/obfuscated forms in comments:** `hxxp://`, `http:` (no slashes),
  `evil dot com`, homoglyph/ideographic dots. Not real URLs; a victim would have
  to retype them by hand.
- **Bare domains in comments** (by design — real notes say "found on archive.org").
- **`data:` / `javascript:` schemes as comment text** — inert; CSP also forbids
  execution independently.
- **Homoglyph/unicode-dot domains in names** — render as visibly odd text, not
  reproducible by a victim.

Chasing these further risks false positives on real book notes for no real
safety gain, so they are documented and accepted rather than filtered.

### Features exercised (all pass)

Live auto-search + suggestions · add-from-search with OpenLibrary hydration
(title, author, cover, genres, https buy links) · rating/status/comment · the
client-side URL guard (URL comment and `evil.com` shelf name both rejected in
the real UI, clean names accepted) · multiple shelves (create/rename/delete) ·
create short link · Goodreads CSV import with URL-stripping from reviews ·
Year-in-review card (canvas renders) · Compare shelves (overlap + agreement).

### Rate limiting (live)

With the per-IP cap set to 5, a burst of 7 mints returned exactly 5×200 then
2×429; distinct IPs are independent and a global daily ceiling backs it up
(unit-tested). A 429 falls back to the long link with a friendly notice.

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
