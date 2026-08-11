"""Hermetic server tests: no network, temp database, OpenLibrary mocked.

Run from the repo root:  python -m unittest discover tests -v
"""

import json
import os
import sys
import tempfile
import unittest
import zlib
from base64 import urlsafe_b64encode
from hashlib import sha256
from unittest import mock

os.environ["HASHSHELF_DB"] = os.path.join(tempfile.mkdtemp(), "test.db")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402

# The suite mints many snapshots from one test-client IP; keep the abuse caps
# out of the way except in MintRateLimitTests, which sets its own values.
server.MINT_PER_IP_HOUR = 10000
server.MINT_GLOBAL_PER_DAY = 100000


def make_payload(obj):
    """Build a valid snapshot payload the way the client does (raw deflate)."""
    raw = json.dumps(obj, separators=(",", ":")).encode()
    comp = zlib.compressobj(9, zlib.DEFLATED, -15)
    deflated = comp.compress(raw) + comp.flush()
    b64 = urlsafe_b64encode(deflated).rstrip(b"=").decode()
    return f"{b64}.{sha256(deflated).hexdigest()[:12]}"


VALID_SNAPSHOT = {
    "v": 1,
    "name": "Zack",
    "books": [{"idType": "work", "id": "OL45804W", "rating": 5, "status": "finished"}],
}


class GenreTests(unittest.TestCase):
    def test_punctuation_insensitive(self):
        self.assertIn("Science Fiction", server.normalize_genres(["Science-fiction"]))
        self.assertIn("Science Fiction", server.normalize_genres(["Science fiction"]))

    def test_one_genre_per_subject_specific_wins(self):
        # Contains both "science fiction" and bare "fiction": must count once, as SF
        got = server.normalize_genres(["Fiction, science fiction, general"])
        self.assertEqual(got, ["Science Fiction"])

    def test_specific_rule_beats_general_on_tie(self):
        got = server.normalize_genres(["Science fiction", "Science"])
        self.assertEqual(got[0], "Science Fiction")

    def test_noise_subjects_excluded(self):
        self.assertEqual(server.normalize_genres(
            ["nyt:bestseller=2021", "award:hugo_award=1966", "Accessible book"]), [])

    def test_nonfiction_does_not_false_match(self):
        self.assertNotIn("Literary Fiction", server.normalize_genres(["Nonfiction"]))

    def test_empty_and_none(self):
        self.assertEqual(server.normalize_genres([]), [])
        self.assertEqual(server.normalize_genres(None), [])

    def test_limit_and_count_ranking(self):
        subs = ["fantasy fiction", "fantasy", "magic", "science fiction", "poetry"]
        got = server.normalize_genres(subs, limit=2)
        self.assertEqual(got, ["Fantasy", "Science Fiction"])


class HelperTests(unittest.TestCase):
    def test_redirect_target(self):
        stub = {"type": {"key": "/type/redirect"}, "location": "/works/OL45804W"}
        self.assertEqual(server._redirect_target(stub, r"^/works/(OL[^/]+W)$"), "OL45804W")
        self.assertIsNone(server._redirect_target({"title": "x"}, r"^/works/(OL[^/]+W)$"))
        self.assertIsNone(server._redirect_target(stub, r"^/books/(OL[^/]+M)$"))

    def test_id_regex(self):
        for good in ("OL45804W", "9780140449136", "014044913X", "OL7353617M"):
            self.assertTrue(server.ID_RE.match(good), good)
        for bad in ("", "a" * 65, "id\nnewline", "semi;colon"):
            self.assertFalse(server.ID_RE.match(bad), repr(bad))

    def test_token_bucket_burst(self):
        b = server.TokenBucket(rate=1000, burst=3)
        for _ in range(3):
            b.acquire()
        self.assertLess(b.tokens, 1)


class SnapshotValidationTests(unittest.TestCase):
    def _reject(self, payload, msg):
        from werkzeug.exceptions import HTTPException
        with self.assertRaises(HTTPException, msg=msg) as ctx:
            server._validate_snapshot_payload(payload)
        self.assertEqual(ctx.exception.code, 400, msg)

    def test_valid_roundtrip(self):
        digest, name, count = server._validate_snapshot_payload(make_payload(VALID_SNAPSHOT))
        self.assertEqual(name, "Zack")
        self.assertEqual(count, 1)
        self.assertEqual(len(digest), 64)

    def test_tampered_integrity(self):
        p = make_payload(VALID_SNAPSHOT)
        flipped = ("B" if p[0] != "B" else "C") + p[1:]
        self._reject(flipped, "tampered payload must 400")

    def test_garbage_and_schema_violations(self):
        self._reject("notavalidpayload", "malformed")
        self._reject("!!!.aaaaaaaaaaaa", "bad alphabet")
        bad_variants = [
            {"v": 2, "books": []},                                            # wrong version
            {"v": 1, "books": "nope"},                                        # books not a list
            {"v": 1, "books": [{"idType": "cd", "id": "X", "status": "want"}]},   # bad idType
            {"v": 1, "books": [{"idType": "work", "id": "OL1W", "status": "meh"}]},  # bad status
            {"v": 1, "books": [{"idType": "work", "id": "OL1W", "status": "want", "extra": 1}]},
            {"v": 1, "books": [{"idType": "work", "id": "OL1W", "status": "want", "rating": 9}]},
            {"v": 1, "name": "x" * 121, "books": []},                          # name too long
        ]
        for snap in bad_variants:
            self._reject(make_payload(snap), f"schema violation should 400: {snap}")

    def test_book_count_cap(self):
        big = {"v": 1, "books": [
            {"idType": "work", "id": f"OL{i}W", "status": "want"}
            for i in range(server.MAX_SNAPSHOT_BOOKS + 1)
        ]}
        self._reject(make_payload(big), "too many books")


def fake_ol(routes):
    """Returns an ol_get replacement serving canned responses by path prefix."""
    def _get(path, params=None, attempts=3):
        for prefix, resp in routes.items():
            if path.startswith(prefix):
                if isinstance(resp, Exception):
                    raise resp
                return resp
        raise AssertionError(f"unexpected upstream call: {path}")
    return _get


WORK_ROUTES = {
    "/works/OL900W/editions": {"entries": [
        {"languages": [{"key": "/languages/eng"}], "title": "English Title",
         "covers": [42], "isbn_13": ["978-0-00-000000-1"]},
    ]},
    "/works/OL900W": {"key": "/works/OL900W", "title": "Original Title",
                      "subjects": ["Science fiction", "American Science fiction"],
                      "authors": [{"author": {"key": "/authors/OL1A"}}], "covers": [7]},
    "/authors/OL1A": {"name": "Test Author"},
}


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = server.app.test_client()

    def test_healthz(self):
        r = self.client.get("/healthz")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.get_json()["ok"])

    def test_static_allowlist(self):
        for path, want in [("/ui.js", 200), ("/vendor/fflate.min.js", 200),
                           ("/robots.txt", 200), ("/genres.json", 200),
                           ("/about.html", 200), ("/guide.html", 200),
                           ("/server.py", 404), ("/render.yaml", 404),
                           ("/requirements.txt", 404), ("/data/hashshelf.db", 404),
                           ("/.gitignore", 404), ("/tests/test_server.py", 404)]:
            self.assertEqual(self.client.get(path).status_code, want, path)

    def test_path_traversal_blocked(self):
        # QA-found (pre-1.5.5): vendor/..%2fserver.py bypassed the allowlist and
        # served source. Every encoding of traversal must now 404, and no
        # response may contain source markers.
        exploits = [
            "/vendor/..%2fserver.py", "/icons/..%2fserver.py",
            "/vendor/../server.py", "/vendor/..%2f..%2fserver.py",
            "/vendor/..%5cserver.py", "/..%2fserver.py",
            "/vendor/..%2frequirements.txt", "/icons/..%2f.gitignore",
        ]
        for p in exploits:
            r = self.client.get(p)
            self.assertEqual(r.status_code, 404, p)
            self.assertNotIn(b"APP_VERSION", r.data, p)
            self.assertNotIn(b"import flask", r.data, p)
        # legitimate nested assets still serve
        self.assertEqual(self.client.get("/vendor/fflate.min.js").status_code, 200)
        self.assertEqual(self.client.get("/icons/icon-192.png").status_code, 200)

    def test_books_validation(self):
        self.assertEqual(self.client.post("/api/books", json={}).status_code, 400)
        self.assertEqual(self.client.post("/api/books", json={"books": []}).status_code, 400)
        cap = [{"idType": "work", "id": f"OL{i}W"} for i in range(server.MAX_BOOKS_PER_REQUEST + 1)]
        self.assertEqual(self.client.post("/api/books", json={"books": cap}).status_code, 400)
        # invalid entries are filtered, not fatal
        r = self.client.post("/api/books", json={"books": [{"idType": "cd", "id": "x"}]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["books"], {})

    def test_work_hydration_assembles_and_caches(self):
        with mock.patch.object(server, "ol_get", side_effect=fake_ol(WORK_ROUTES)):
            r = self.client.post("/api/books", json={"books": [{"idType": "work", "id": "OL900W"}]})
        book = r.get_json()["books"]["work:OL900W"]
        self.assertTrue(book["ok"])
        self.assertEqual(book["title"], "English Title")      # English edition preferred
        self.assertEqual(book["authors"], ["Test Author"])
        self.assertEqual(book["workId"], "OL900W")
        self.assertIn("Science Fiction", book["genres"])
        self.assertIn("/b/id/42-M.jpg", book["coverUrl"])
        # representative ISBN, punctuation stripped, so work-added books can link out
        self.assertEqual(book["isbn"], "9780000000001")
        # cached: upstream now unreachable, result must still come back
        with mock.patch.object(server, "ol_get", side_effect=RuntimeError("no upstream")):
            r2 = self.client.post("/api/books", json={"books": [{"idType": "work", "id": "OL900W"}]})
        self.assertTrue(r2.get_json()["books"]["work:OL900W"]["ok"])

    def test_failures_are_never_cached(self):
        with mock.patch.object(server, "ol_get", side_effect=RuntimeError("down")):
            r = self.client.post("/api/books", json={"books": [{"idType": "work", "id": "OL901W"}]})
        self.assertFalse(r.get_json()["books"]["work:OL901W"]["ok"])
        routes = {
            "/works/OL901W/editions": {"entries": []},
            "/works/OL901W": {"key": "/works/OL901W", "title": "Recovered", "subjects": [], "authors": []},
        }
        with mock.patch.object(server, "ol_get", side_effect=fake_ol(routes)):
            r2 = self.client.post("/api/books", json={"books": [{"idType": "work", "id": "OL901W"}]})
        book = r2.get_json()["books"]["work:OL901W"]
        self.assertTrue(book["ok"])
        self.assertEqual(book["title"], "Recovered")

    def test_edition_borrows_parent_work_metadata(self):
        routes = {
            "/isbn/9780000000002": {"title": "Some Edition", "covers": [5],
                                    "works": [{"key": "/works/OL902W"}]},
            "/works/OL902W/editions": {"entries": []},
            "/works/OL902W": {"key": "/works/OL902W", "title": "Parent Work",
                              "subjects": ["Fantasy fiction"],
                              "authors": [{"author": {"key": "/authors/OL1A"}}]},
            "/authors/OL1A": {"name": "Test Author"},
        }
        with mock.patch.object(server, "ol_get", side_effect=fake_ol(routes)):
            r = self.client.post("/api/books", json={"books": [{"idType": "isbn", "id": "9780000000002"}]})
        book = r.get_json()["books"]["isbn:9780000000002"]
        self.assertEqual(book["authors"], ["Test Author"])    # borrowed from work
        self.assertIn("Fantasy", book["genres"])              # borrowed from work
        self.assertEqual(book["workId"], "OL902W")
        self.assertEqual(book["isbn"], "9780000000002")       # the id itself is the ISBN
        # the parent work row was warmed into the cache as a side effect
        with mock.patch.object(server, "ol_get", side_effect=RuntimeError("no upstream")):
            r2 = self.client.post("/api/books", json={"books": [{"idType": "work", "id": "OL902W"}]})
        self.assertTrue(r2.get_json()["books"]["work:OL902W"]["ok"])

    def test_work_redirect_followed(self):
        routes = {
            "/works/OL903W": {"type": {"key": "/type/redirect"}, "location": "/works/OL904W"},
            "/works/OL904W/editions": {"entries": []},
            "/works/OL904W": {"key": "/works/OL904W", "title": "Canonical", "subjects": [], "authors": []},
        }
        with mock.patch.object(server, "ol_get", side_effect=fake_ol(routes)):
            r = self.client.post("/api/books", json={"books": [{"idType": "work", "id": "OL903W"}]})
        book = r.get_json()["books"]["work:OL903W"]
        self.assertEqual(book["title"], "Canonical")
        self.assertEqual(book["workId"], "OL904W")


class PrewarmTests(unittest.TestCase):
    def test_thread_never_starts_on_import(self):
        # CI and tests import server; the background worker must stay off
        self.assertFalse(server._prewarm_started)

    def test_extract_work_ids(self):
        payload = {"works": [
            {"key": "/works/OL111W"}, {"key": "/works/OL222W"},
            {"key": "/books/OL5M"}, {"key": None}, {},
        ]}
        self.assertEqual(server._extract_work_ids(payload), ["OL111W", "OL222W"])
        self.assertEqual(server._extract_work_ids({}), [])
        self.assertEqual(server._extract_work_ids(None), [])

    def test_cursor_roundtrip(self):
        server._prewarm_set_state(7, 125)
        self.assertEqual(server._prewarm_get_state(), (7, 125))
        server._prewarm_set_state(0, 0)

    def test_cycle_hydrates_new_and_skips_cached(self):
        server._prewarm_set_state(0, 0)
        server._prewarm_lists.clear()
        routes = {
            "/trending/daily": {"works": [{"key": "/works/OL801W"}, {"key": "/works/OL802W"}]},
            "/works/OL801W/editions": {"entries": []},
            "/works/OL802W/editions": {"entries": []},
            "/works/OL801W": {"key": "/works/OL801W", "title": "Warm One", "subjects": [], "authors": []},
            "/works/OL802W": {"key": "/works/OL802W", "title": "Warm Two", "subjects": [], "authors": []},
        }
        with mock.patch.object(server, "ol_get", side_effect=fake_ol(routes)):
            hydrated = server._prewarm_cycle()
        self.assertEqual(hydrated, 2)
        row = server.db().execute(
            "SELECT title FROM books WHERE id_type='work' AND id='OL801W'").fetchone()
        self.assertEqual(row[0], "Warm One")

        # Second cycle: same trending list (memoized), everything cached ->
        # zero hydrations, and the ladder must advance instead of stalling
        with mock.patch.object(server, "ol_get", side_effect=fake_ol({
            "/trending/": {"works": []}, "/subjects/": {"works": []},
        })):
            hydrated2 = server._prewarm_cycle()
        self.assertEqual(hydrated2, 0)
        source, _ = server._prewarm_get_state()
        self.assertGreater(source, 0)
        server._prewarm_set_state(0, 0)
        server._prewarm_lists.clear()


class SecurityHeaderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = server.app.test_client()

    def test_headers_on_every_response_type(self):
        for path in ("/", "/healthz", "/ui.js", "/about.html"):
            h = self.client.get(path).headers
            self.assertIn("script-src 'self'", h.get("Content-Security-Policy", ""), path)
            self.assertIn("frame-ancestors 'none'", h.get("Content-Security-Policy", ""), path)
            self.assertEqual(h.get("X-Content-Type-Options"), "nosniff", path)
            self.assertEqual(h.get("Referrer-Policy"), "strict-origin-when-cross-origin", path)
            self.assertEqual(h.get("X-Frame-Options"), "DENY", path)
            self.assertIn("max-age=", h.get("Strict-Transport-Security", ""), path)

    def test_csp_permits_only_expected_hosts(self):
        csp = self.client.get("/").headers["Content-Security-Policy"]
        # the complete third-party surface: OpenLibrary data + covers, nothing else
        self.assertIn("https://openlibrary.org", csp)
        self.assertIn("https://covers.openlibrary.org", csp)
        # covers 302 to archive.org for the actual bytes; redirects must pass CSP too
        self.assertIn("https://*.archive.org", csp)
        for banned in ("unsafe-inline", "unsafe-eval", "googletagmanager", " * ", "http:"):
            self.assertNotIn(banned, csp)

    def test_no_inline_script_or_style_in_pages(self):
        for path in ("/", "/about.html", "/guide.html"):
            body = self.client.get(path).get_data(as_text=True)
            self.assertNotIn("<script>", body, path)
            self.assertNotIn("<style>", body, path)
            self.assertNotIn(' style="', body, path)


class SnapshotEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = server.app.test_client()

    def test_mint_is_idempotent_and_resolvable(self):
        payload = make_payload(VALID_SNAPSHOT)
        r1 = self.client.post("/api/snapshot", json={"payload": payload})
        r2 = self.client.post("/api/snapshot", json={"payload": payload})
        self.assertEqual(r1.status_code, 200)
        slug = r1.get_json()["slug"]
        self.assertEqual(slug, r2.get_json()["slug"])          # content-addressed
        self.assertEqual(slug, sha256_of(payload)[:12])
        got = self.client.get(f"/api/snapshot/{slug}")
        self.assertEqual(got.get_json()["payload"], payload)

    def test_urls_blocked_in_stored_shelves(self):
        # Abuse control (v1.6.0): a hashshelf.com page must never carry someone
        # else's URL. Names are stricter than comments because they become the
        # unfurl title on /s/ links (borrowed-domain phishing surface).
        def mint(snap):
            return self.client.post("/api/snapshot", json={"payload": make_payload(snap)})

        blocked_names = [
            "Deals at https://evil.example", "see WWW.evil.example", "visit evil.com now",
            "invoice.zip", "watch demo.mov", "promo evil.xyz", "login evil.icu",
        ]
        for bad in blocked_names:
            self.assertEqual(mint(dict(VALID_SNAPSHOT, name=bad)).status_code, 400, bad)

        # No false positives on legitimate initials-with-dots names.
        for ok in ["Vol. 2 favorites (J.R.R. picks)", "Books by C.S. Lewis & J.K.", "Sci-Fi 2026"]:
            self.assertEqual(mint(dict(VALID_SNAPSHOT, name=ok)).status_code, 200, ok)

        def with_comment(c):
            return {"v": 1, "name": "Zack", "books": [
                {"idType": "work", "id": "OL45804W", "status": "want", "comment": c}]}

        for bad in ["grab it https://evil.example/x", "at WWW.evil.example", "ftp://drop.example"]:
            self.assertEqual(mint(with_comment(bad)).status_code, 400, bad)

        # Bare domains stay allowed in comments (real notes say "found on
        # archive.org"); ordinary punctuation never false-positives.
        self.assertEqual(mint(with_comment("found this on archive.org")).status_code, 200)
        self.assertEqual(mint(dict(VALID_SNAPSHOT, name="Vol. 2 favorites (J.R.R. picks)")).status_code, 200)

    def test_mint_rate_limits(self):
        # Per-IP hourly cap, distinct IPs independent, global daily ceiling.
        def mint(i, ip=None):
            headers = {"CF-Connecting-IP": ip} if ip else {}
            snap = dict(VALID_SNAPSHOT, name=f"rl shelf {i}")
            return self.client.post(
                "/api/snapshot", json={"payload": make_payload(snap)}, headers=headers)

        old_ip, old_day = server.MINT_PER_IP_HOUR, server.MINT_GLOBAL_PER_DAY
        try:
            server._mint_by_ip.clear()
            server._mint_day.update(day=-1, count=0)
            server.MINT_PER_IP_HOUR = 3
            for i in range(3):
                self.assertEqual(mint(i).status_code, 200)
            self.assertEqual(mint(99).status_code, 429)          # 4th from same IP
            self.assertEqual(mint(100, ip="203.0.113.7").status_code, 200)  # other IP fine

            server.MINT_PER_IP_HOUR = 10000
            server.MINT_GLOBAL_PER_DAY = server._mint_day["count"] + 1
            self.assertEqual(mint(101, ip="203.0.113.8").status_code, 200)
            self.assertEqual(mint(102, ip="203.0.113.9").status_code, 429)  # global ceiling
        finally:
            server.MINT_PER_IP_HOUR, server.MINT_GLOBAL_PER_DAY = old_ip, old_day
            server._mint_by_ip.clear()
            server._mint_day.update(day=-1, count=0)

    def test_s_page_snapshot_is_csp_safe(self):
        # QA-found (v1.5.8): the snapshot bootstrap must be a <meta> tag, not an
        # inline <script> — the strict CSP (script-src 'self') blocks inline
        # scripts, which silently broke every short link. Guard both invariants.
        payload = make_payload(VALID_SNAPSHOT)
        slug = self.client.post("/api/snapshot", json={"payload": payload}).get_json()["slug"]
        page = self.client.get(f"/s/{slug}").get_data(as_text=True)
        self.assertIn('name="hashshelf-snapshot"', page)
        self.assertIn(f'content="#{payload}"', page)
        # zero inline scripts anywhere on the page (every <script> must have src=)
        import re as _re
        for tag in _re.findall(r"<script\b[^>]*>", page):
            self.assertIn("src=", tag, f"inline script would be CSP-blocked: {tag}")
        self.assertNotIn("__HASHSHELF_SNAPSHOT__", page)

    def test_og_injection_and_name_escaping(self):
        snap = {"v": 1, "name": 'Zack <script>alert(1)</script>', "books": []}
        payload = make_payload(snap)
        slug = self.client.post("/api/snapshot", json={"payload": payload}).get_json()["slug"]
        page = self.client.get(f"/s/{slug}").get_data(as_text=True)
        self.assertIn('name="hashshelf-snapshot"', page)       # meta bootstrap
        self.assertIn("&lt;script&gt;", page)                  # escaped
        self.assertNotIn("Zack <script>", page)                # never raw
        self.assertIn("og:title", page)

    def test_unknown_and_malformed_slugs(self):
        self.assertEqual(self.client.get("/s/deadbeefdead").status_code, 404)
        self.assertEqual(self.client.get("/s/NOTHEX!").status_code, 404)
        self.assertEqual(self.client.get("/api/snapshot/deadbeefdead").status_code, 404)

    def test_mint_rejects_invalid(self):
        for body in [{}, {"payload": "junk"}, {"payload": "a" * 40000}]:
            self.assertEqual(self.client.post("/api/snapshot", json=body).status_code, 400)


def sha256_of(payload):
    b64 = payload.split(".")[0]
    from base64 import urlsafe_b64decode
    return sha256(urlsafe_b64decode(b64 + "=" * (-len(b64) % 4))).hexdigest()


if __name__ == "__main__":
    unittest.main()
