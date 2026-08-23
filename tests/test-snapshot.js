// Snapshot encoding tests: SHA-256 vectors, determinism, dedupe, tamper detection.
// Run from repo root:  node tests/test-snapshot.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
global.window = {};
global.fflate = require(path.join(ROOT, 'vendor', 'fflate.min.js'));
global.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
global.atob = (s) => Buffer.from(s, 'base64').toString('binary');
eval(fs.readFileSync(path.join(ROOT, 'snapshot.js'), 'utf8'));
const S = global.window.HashShelfSnapshot;

let fails = 0;
const check = (name, cond, extra) => {
  if (!cond) { fails++; console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra) : ''); }
  else console.log('ok:', name);
};

(async () => {
  // SHA-256 vs Node crypto across every padding boundary (uses identity
  // "deflate" so payload bytes are fully controlled by the name length)
  const realDeflate = global.fflate;
  global.fflate = { deflateSync: (x) => x, inflateSync: (x) => x };
  let shaFails = 0;
  for (let n = 0; n <= 200; n++) {
    const hash = await S.encodeSnapshot([], 'a'.repeat(n) || 'x');
    const [b64u, integrity] = hash.slice(1).split('.');
    const bytes = Buffer.from(b64u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - b64u.length % 4) % 4), 'base64');
    const expected = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    if (integrity !== expected) shaFails++;
  }
  check('SHA-256 matches Node crypto across 201 padding boundaries', shaFails === 0, shaFails);
  global.fflate = realDeflate;

  // Real-deflate roundtrip with unicode name; comments are dropped entirely
  const books = [
    { idType: 'work', id: 'OL45804W', rating: 5, comment: 'héllo — ✓ 日本語', status: 'finished' },
    { idType: 'isbn', id: '9780140449136', rating: 0, status: 'did not finish' },
  ];
  const hash = await S.encodeSnapshot(books, 'Zäck 日本語');
  const dec = await S.decodeFromHash(hash);
  check('roundtrip preserves books/name/unicode', dec.books.length === 2 && dec.name === 'Zäck 日本語');
  check('comments are stripped on encode/decode', dec.books.every(b => b.comment === undefined));
  check('rating 0 distinct from unrated', dec.books.find(b => b.id === '9780140449136').rating === 0);

  // Determinism: input order must not matter
  const h2 = await S.encodeSnapshot([books[1], books[0]], 'Zäck 日本語');
  check('order-independent encoding', hash === h2);

  // Dedupe keep-last per (idType, id); comment on either is dropped
  const canon = S.canonicalizeBooks([
    { idType: 'work', id: 'OL1W', rating: 2, status: 'want' },
    { idType: 'work', id: 'OL1W', rating: 5, comment: 'dropped', status: 'finished' },
  ]);
  check('dedupe keeps last write', canon.length === 1 && canon[0].rating === 5);
  check('canonicalize drops comments', canon[0].comment === undefined);

  // Name sanitization is the real boundary: it runs on encode AND decode, so a
  // hand-crafted link cannot smuggle a URL/domain into the title.
  check('sanitizeName strips http URLs', S.sanitizeName('Reads visit http://evil.example/x now') === 'Reads visit now');
  check('sanitizeName strips www', S.sanitizeName('deals www.evil.example here') === 'deals here');
  check('sanitizeName strips bare domains', S.sanitizeName('grab evil.com today') === 'grab today');
  check('sanitizeName strips .zip lookalikes', S.sanitizeName('open invoice.zip') === 'open');
  check('sanitizeName keeps legit titles', S.sanitizeName('Vol. 2 (J.R.R. picks)') === 'Vol. 2 (J.R.R. picks)');
  check('sanitizeName keeps initials + emoji', S.sanitizeName('Beach Reads \u{1F3D6}️ 2026') === 'Beach Reads \u{1F3D6}️ 2026');
  check('sanitizeName caps length to MAX_NAME (by code point)', [...S.sanitizeName('x'.repeat(200))].length === S.MAX_NAME);
  // Concealment/bypass hardening (QA campaign): no invisible char, bidi control,
  // homoglyph scheme, or exotic-TLD domain may survive.
  const noInvisible = (s) => !/[­​-‏‪-‮⁠-⁯﻿]/.test(s);
  const noLink = (s) => !/https?:|ftp:|www\.|[a-z0-9-]+\.[a-z]{2,}/i.test(s);
  check('strips zero-width-joiner in scheme', noLink(S.sanitizeName('go htt‍p://evil.example')));
  check('strips zero-width in domain', noLink(S.sanitizeName('buy ev​il.com now')) && noInvisible(S.sanitizeName('buy ev​il.com now')));
  check('strips bidi override (RLO)', noInvisible(S.sanitizeName('safe ‮moc.live‬ x')));
  check('folds fullwidth scheme then strips', noLink(S.sanitizeName('go ｈｔｔｐ：／／evil.example')));
  check('strips exotic TLD .gov (denylist-free)', noLink(S.sanitizeName('visit evil.gov/phish')));
  check('strips exotic TLD .tech', noLink(S.sanitizeName('grab library.tech/x')));
  check('strips trailing zero-width padding', S.sanitizeName('MyShelf​​​') === 'MyShelf');
  check('no surrogate half at the 50 cap', (() => {
    const out = S.sanitizeName('\u{1F600}'.repeat(60));  // 60 astral chars
    return [...out].length === S.MAX_NAME && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out);
  })());
  // Decode path neutralizes concealed content in a raw/crafted link's name
  const evilHash = await S.encodeSnapshot([{ idType: 'work', id: 'OL1W', status: 'want' }], 'go to htt‍p://evil.example ‮x‬');
  const evilDec = await S.decodeFromHash(evilHash);
  check('decode name carries no URL or invisible char', noLink(evilDec.name || '') && noInvisible(evilDec.name || ''));

  // Locale-independent sort: 'B' (0x42) before 'a' (0x61)
  const sorted = S.canonicalizeBooks([
    { idType: 'work', id: 'a1', status: 'want' },
    { idType: 'work', id: 'B1', status: 'want' },
  ]);
  check('code-unit sort (B before a)', sorted[0].id === 'B1');

  // Tamper detection
  let caught = false;
  try { await S.decodeFromHash('#' + 'A' + hash.slice(2)); } catch { caught = true; }
  check('tampered payload rejected', caught);

  // Legacy #v1. prefix still decodes
  const legacy = '#v1.' + hash.slice(1);
  const dec2 = await S.decodeFromHash(legacy);
  check('legacy v1 prefix accepted', dec2.books.length === 2);

  // Invalid inputs rejected
  for (const bad of ['#nodot', '#a.b.c', '#!!!.aaaaaaaaaaaa']) {
    let threw = false;
    try { await S.decodeFromHash(bad); } catch { threw = true; }
    check(`rejects ${bad}`, threw);
  }

  // QA (v1.5.6): decompression-bomb link must be rejected, not inflated to GBs.
  const bomb = '{"v":1,"name":"' + 'A'.repeat(20000000) + '","books":[]}';
  const deflated = global.fflate.deflateSync(new TextEncoder().encode(bomb));
  const b64u = Buffer.from(deflated).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const integ = crypto.createHash('sha256').update(Buffer.from(deflated)).digest('hex').slice(0, 12);
  let bombRejected = false;
  const t0 = Date.now();
  try { await S.decodeFromHash('#' + b64u + '.' + integ); } catch { bombRejected = true; }
  check('decompression bomb rejected', bombRejected);
  check('bomb rejected fast (<500ms, bounded inflate)', Date.now() - t0 < 500, Date.now() - t0);

  // A legitimately large shelf (near the 1000-book cap) must still decode.
  const big = Array.from({ length: 1000 }, (_, i) =>
    ({ idType: 'work', id: 'OL' + (100000 + i) + 'W', rating: i % 6, status: 'finished' }));
  const bigHash = await S.encodeSnapshot(big, 'Big Shelf');
  const bigDec = await S.decodeFromHash(bigHash);
  check('1000-book shelf still decodes under the cap', bigDec.books.length === 1000);

  console.log(fails === 0 ? '\nALL SNAPSHOT TESTS PASSED' : `\n${fails} FAILURES`);
  process.exit(fails ? 1 : 0);
})();
