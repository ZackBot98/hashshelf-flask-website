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

  // Real-deflate roundtrip with unicode
  const books = [
    { idType: 'work', id: 'OL45804W', rating: 5, comment: 'héllo — ✓ 日本語', status: 'finished' },
    { idType: 'isbn', id: '9780140449136', rating: 0, status: 'did not finish' },
  ];
  const hash = await S.encodeSnapshot(books, 'Zack');
  const dec = await S.decodeFromHash(hash);
  check('roundtrip preserves books/name/unicode', dec.books.length === 2 && dec.name === 'Zack'
    && dec.books.find(b => b.id === 'OL45804W').comment.includes('日本語'));
  check('rating 0 distinct from unrated', dec.books.find(b => b.id === '9780140449136').rating === 0);

  // Determinism: input order must not matter
  const h2 = await S.encodeSnapshot([books[1], books[0]], 'Zack');
  check('order-independent encoding', hash === h2);

  // Dedupe keep-last per (idType, id)
  const canon = S.canonicalizeBooks([
    { idType: 'work', id: 'OL1W', rating: 2, status: 'want' },
    { idType: 'work', id: 'OL1W', rating: 5, comment: 'kept', status: 'finished' },
  ]);
  check('dedupe keeps last write', canon.length === 1 && canon[0].rating === 5 && canon[0].comment === 'kept');

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

  console.log(fails === 0 ? '\nALL SNAPSHOT TESTS PASSED' : `\n${fails} FAILURES`);
  process.exit(fails ? 1 : 0);
})();
