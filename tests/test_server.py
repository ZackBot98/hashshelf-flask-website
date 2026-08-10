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

    def test_og_injection_and_name_escaping(self):
        snap = {"v": 1, "name": 'Zack <script>alert(1)</script>', "books": []}
        payload = make_payload(snap)
        slug = self.client.post("/api/snapshot", json={"payload": payload}).get_json()["slug"]
        page = self.client.get(f"/s/{slug}").get_data(as_text=True)
        self.assertIn("__HASHSHELF_SNAPSHOT__", page)
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
