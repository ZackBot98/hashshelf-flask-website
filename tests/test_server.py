"""Hermetic server tests: no network, temp database, OpenLibrary mocked.

Run from the repo root:  python -m unittest discover tests -v
"""

import os
import sys
import tempfile
import unittest
from unittest import mock

os.environ["HASHSHELF_DB"] = os.path.join(tempfile.mkdtemp(), "test.db")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402


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
                           ("/terms.html", 200), ("/privacy.html", 200),
                           ("/server.py", 404), ("/render.yaml", 404),
                           ("/requirements.txt", 404), ("/data/hashshelf.db", 404),
                           ("/.gitignore", 404), ("/tests/test_server.py", 404)]:
            self.assertEqual(self.client.get(path).status_code, want, path)

    def test_legal_pages_content(self):
        # Terms/Privacy must actually render their content and cross-link.
        terms = self.client.get("/terms.html").get_data(as_text=True)
        self.assertIn("Terms of Service", terms)
        self.assertIn("Acceptable use", terms)
        self.assertIn("/privacy.html", terms)
        privacy = self.client.get("/privacy.html").get_data(as_text=True)
        self.assertIn("Privacy Policy", privacy)
        self.assertIn("/terms.html", privacy)

    def test_request_body_size_capped(self):
        # Oversized POST must be refused (413) before buffering into memory.
        big = b"x" * (300 * 1024)
        r = self.client.post("/api/books", data=big, content_type="application/json")
        self.assertEqual(r.status_code, 413)

    def test_search_cached_under_hashed_key_not_raw(self):
        import hashlib
        routes = {
            "/search.json": {"docs": [{"key": "/works/OL55W", "title": "Q"}]},
            "/works/OL55W/editions": {"entries": []},
            "/works/OL55W": {"key": "/works/OL55W", "title": "Q", "subjects": [], "authors": []},
        }
        with mock.patch.object(server, "ol_get", side_effect=fake_ol(routes)):
            self.assertEqual(self.client.get("/api/search?q=Secret Query Phrase").status_code, 200)
        raw = "secret query phrase"  # normalized: lowercased, whitespace-collapsed
        keys = [row[0] for row in server.db().execute("SELECT q FROM searches").fetchall()]
        self.assertIn(hashlib.sha256(raw.encode("utf-8")).hexdigest(), keys)  # stored hashed
        self.assertNotIn(raw, keys)                                           # raw never stored
        for k in keys:
            self.assertRegex(k, r"^[0-9a-f]{64}$")                            # every key is a hash

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

    def test_headers_on_error_responses(self):
        # The WSGI middleware must apply headers to error responses too (404/400),
        # not just 200s — an uncaught 500 would otherwise ship bare.
        for path in ("/definitely-not-a-file-xyz", "/api/search"):  # 404, 400
            h = self.client.get(path).headers
            self.assertIn("script-src 'self'", h.get("Content-Security-Policy", ""), path)
            self.assertEqual(h.get("X-Content-Type-Options"), "nosniff", path)
            self.assertEqual(h.get("X-Frame-Options"), "DENY", path)


class ShortLinksRemovedTests(unittest.TestCase):
    """Short links were removed entirely: no minting, no storage, no /s/ page.
    The server must store no user content and expose no snapshot surface."""

    @classmethod
    def setUpClass(cls):
        cls.client = server.app.test_client()

    def test_snapshot_endpoints_gone(self):
        # POST to the old mint path no longer routes (405 from the GET-only
        # static catch-all, or 404) — never a 200 with a slug.
        self.assertIn(self.client.post("/api/snapshot", json={"payload": "x"}).status_code, (404, 405))
        self.assertEqual(self.client.get("/api/snapshot/deadbeefdead").status_code, 404)

    def test_s_page_gone(self):
        for slug in ("deadbeefdead", "abcdef012345", "NOTHEX!"):
            self.assertEqual(self.client.get(f"/s/{slug}").status_code, 404, slug)

    def test_snapshots_table_purged(self):
        # init_db drops it; no shelf is ever retained.
        row = server.db().execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='snapshots'"
        ).fetchone()
        self.assertIsNone(row)

    def test_no_snapshot_helpers_left(self):
        # The mint/validate/rate-limit machinery is gone from the module.
        for attr in ("api_snapshot", "snapshot_page", "_validate_snapshot_payload",
                     "_mint_allowed", "MINT_PER_IP_HOUR"):
            self.assertFalse(hasattr(server, attr), attr)


if __name__ == "__main__":
    unittest.main()
