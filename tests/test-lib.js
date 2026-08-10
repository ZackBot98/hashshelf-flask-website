// lib.js unit tests: CSV parsing, Goodreads import, genres, compare, stats.
// Run from repo root:  node tests/test-lib.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const root = {};
eval(fs.readFileSync(path.join(ROOT, 'lib.js'), 'utf8').replace(
  "})(typeof window !== 'undefined' ? window : globalThis);", "})(root);"));
const L = root.HashShelfLib;

// Serve the real genres.json to lib.js's fetch, so the JS mapping is tested
// against the same rules file the server uses.
const genresJson = fs.readFileSync(path.join(ROOT, 'genres.json'), 'utf8');
global.fetch = async (url) => {
  if (String(url).includes('genres.json')) {
    return { ok: true, json: async () => JSON.parse(genresJson) };
  }
  throw new Error('unexpected fetch: ' + url);
};

let fails = 0;
const check = (name, cond, extra) => {
  if (!cond) { fails++; console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra) : ''); }
  else console.log('ok:', name);
};

(async () => {
  // --- CSV edge cases -----------------------------------------------------
  const rows = L.parseCsv('a,b,c\n"quoted, comma","line\nbreak","escaped ""quotes"""\n');
  check('csv row count', rows.length === 2, rows);
  check('csv embedded comma', rows[1][0] === 'quoted, comma');
  check('csv embedded newline', rows[1][1] === 'line\nbreak');
  check('csv escaped quotes', rows[1][2] === 'escaped "quotes"');

  // --- Goodreads export ---------------------------------------------------
  const gr = [
    'Book Id,Title,Author,ISBN,ISBN13,My Rating,Average Rating,Number of Pages,Exclusive Shelf,My Review,Bookshelves',
    '1,The Hobbit,J.R.R. Tolkien,"=""0547928246""","=""9780547928241""",5,4.28,366,read,"Loved it, twice.",fantasy',
    '2,Dune,Frank Herbert,"=""0441013597""","=""9780441013593""",4,4.25,884,currently-reading,,sci-fi',
    '3,Ulysses,James Joyce,"=""""","=""""",0,3.74,783,to-read,,',
    '4,Some DNF Book,Nobody,"=""1234567890""","=""9781234567897""",2,3.0,100,read,"gave up","dnf, owned"',
    '5,No Isbn Book,Ghost Writer,"=""""","=""""",3,3.5,120,read,,'
  ].join('\n');
  const parsed = L.parseGoodreadsCsv(gr);
  check('goodreads imported count', parsed.books.length === 3, parsed.books);
  check('goodreads skipped count', parsed.skipped.length === 2, parsed.skipped);
  const hobbit = parsed.books.find(b => b.id === '9780547928241');
  check('status read -> finished', hobbit && hobbit.status === 'finished');
  check('rating kept', hobbit && hobbit.rating === 5);
  check('review kept with comma', hobbit && hobbit.comment === 'Loved it, twice.');
  check('currently-reading -> reading', parsed.books.find(b => b.id === '9780441013593').status === 'reading');
  check('custom dnf shelf detected', parsed.books.find(b => b.id === '9781234567897').status === 'did not finish');
  check('goodreads rating 0 means unrated', parsed.books.every(b => b.rating !== 0));
  check('prefers isbn13', hobbit && hobbit.id.length === 13);
  let threw = false;
  try { L.parseGoodreadsCsv('foo,bar\n1,2'); } catch { threw = true; }
  check('rejects non-goodreads csv', threw);

  // --- genres (parity cases with tests/test_server.py) --------------------
  check('genre punctuation fold', (await L.normalizeGenres(['Science-fiction'])).includes('Science Fiction'));
  check('one genre per subject, specific wins',
    JSON.stringify(await L.normalizeGenres(['Fiction, science fiction, general'])) === '["Science Fiction"]');
  check('specific beats general on tie',
    (await L.normalizeGenres(['Science fiction', 'Science']))[0] === 'Science Fiction');
  check('noise excluded', (await L.normalizeGenres(['nyt:bestseller=2021', 'award:hugo_award=1966'])).length === 0);
  check('nonfiction no false literary match',
    !(await L.normalizeGenres(['Nonfiction'])).includes('Literary Fiction'));

  // --- identity + compare -------------------------------------------------
  const mkEntry = (idType, id, rating, status, workId) => ({
    key: L.identityKey({ idType, id }, { workId }),
    book: { idType, id, rating, status },
    meta: { workId, title: id, authors: [], genres: [] }
  });
  const mine = [
    mkEntry('isbn', '9780547928241', 5, 'finished', 'OL27479W'),
    mkEntry('work', 'OL45804W', 2, 'finished', 'OL45804W'),
    mkEntry('work', 'OL262758W', 5, 'finished', 'OL262758W')
  ];
  const theirs = [
    mkEntry('work', 'OL27479W', 4, 'finished', 'OL27479W'),
    mkEntry('work', 'OL45804W', 5, 'finished', 'OL45804W'),
    mkEntry('work', 'OL999W', 3, 'want', 'OL999W')
  ];
  const cmp = L.compareShelves(mine, theirs);
  check('cross-idtype match via workId', cmp.both.length === 2, cmp.both.map(b => b.key));
  check('only mine', cmp.onlyMine.length === 1 && cmp.onlyMine[0].book.id === 'OL262758W');
  check('only theirs', cmp.onlyTheirs.length === 1 && cmp.onlyTheirs[0].book.id === 'OL999W');
  check('disagreement flagged (gap 3)', cmp.disagreements.length === 1 && cmp.disagreements[0].gap === 3);
  check('agreement flagged (5 vs 4)', cmp.agreements.length === 1);
  check('overlap pct', cmp.overlapPct === 50, cmp.overlapPct);

  // --- stats --------------------------------------------------------------
  const hydrated = [
    { book: { status: 'finished', rating: 5 }, meta: { authors: ['Tolkien'], genres: ['Fantasy'], coverUrl: 'u1' } },
    { book: { status: 'finished', rating: 4 }, meta: { authors: ['Tolkien'], genres: ['Fantasy', 'Adventure'], coverUrl: 'u2' } },
    { book: { status: 'reading' }, meta: { authors: ['Herbert'], genres: ['Science Fiction'] } },
    { book: { status: 'want' }, meta: { authors: [], genres: [] } }
  ];
  const stats = L.buildStats(hydrated);
  check('stats total', stats.total === 4);
  check('stats finished', stats.counts.finished === 2);
  check('stats avg rating', stats.avgRating === 4.5);
  check('stats top author', stats.topAuthors[0][0] === 'Tolkien' && stats.topAuthors[0][1] === 2);
  check('stats top genre', stats.topGenres[0][0] === 'Fantasy');
  check('stats covers', stats.covers.length === 2);
  check('stats rating distribution', stats.dist[5] === 1 && stats.dist[4] === 1);

  // --- ISBN conversion (Amazon ASIN = ISBN-10) ----------------------------
  check('isbn13 -> isbn10 (978)', L.toIsbn10('9780547928241') === '0547928246', L.toIsbn10('9780547928241'));
  check('isbn10 passthrough', L.toIsbn10('0547928246') === '0547928246');
  check('isbn10 -> isbn13', L.toIsbn13('0547928246') === '9780547928241', L.toIsbn13('0547928246'));
  check('isbn13 passthrough', L.toIsbn13('9780547928241') === '9780547928241');
  check('X check digit preserved', L.toIsbn10('014044913X') === '014044913X');
  check('isbn10 with X -> isbn13', L.toIsbn13('014044913X') === '9780140449136', L.toIsbn13('014044913X'));
  check('979 has no isbn10', L.toIsbn10('9791234567896') === null);
  check('hyphens tolerated', L.toIsbn10('978-0-547-92824-1') === '0547928246');
  check('garbage -> null', L.toIsbn10('nope') === null && L.toIsbn13('') === null);

  // --- affiliate links ----------------------------------------------------
  const meta = { title: 'The Hobbit', isbn: '9780547928241' };
  check('no config -> no links', L.buyLinks(meta, {}).length === 0);
  check('affiliateActive false when unset', L.affiliateActive({}) === false);
  check('affiliateActive true with amazon tag', L.affiliateActive({ amazonTag: 'x-20' }) === true);

  const amz = L.buyLinks(meta, { amazonTag: 'hashshelf-20' });
  check('amazon link uses ASIN + tag',
    amz.length === 2 && amz[0].url === 'https://www.amazon.com/dp/0547928246?tag=hashshelf-20', amz);
  check('audiobook link: audible index + tag + title',
    amz[1].label === 'Audiobook' && amz[1].url.includes('i=audible')
    && amz[1].url.includes('k=The%20Hobbit') && amz[1].url.includes('tag=hashshelf-20'), amz[1]);
  const withAuthor = L.buyLinks({ title: 'Dune', isbn: '9780441013593', authors: ['Frank Herbert'] }, { amazonTag: 't-20' });
  check('audiobook query includes author',
    withAuthor[1].url.includes('k=Dune%20Frank%20Herbert'), withAuthor[1]);

  const amz979 = L.buyLinks({ title: 'New Book', isbn: '9791234567896' }, { amazonTag: 'hashshelf-20' });
  check('979 falls back to search link',
    amz979[0].url.includes('/s?k=9791234567896') && amz979[0].url.includes('tag=hashshelf-20'), amz979);

  const amzNoIsbn = L.buyLinks({ title: 'Some Title', isbn: null }, { amazonTag: 'hashshelf-20' });
  check('no isbn falls back to title search',
    amzNoIsbn[0].url.includes('/s?k=Some%20Title'), amzNoIsbn);

  check('no isbn and no title -> no link',
    L.buyLinks({ title: '', isbn: null }, { amazonTag: 'hashshelf-20' }).length === 0);

  const both = L.buyLinks(meta, { amazonTag: 'hashshelf-20', bookshopId: '12345' });
  check('all programs render in order', both.length === 3 && both[1].label === 'Audiobook'
    && both[2].url === 'https://bookshop.org/a/12345/9780547928241', both);

  const host = L.buyLinks(meta, { amazonTag: 't-21', amazonHost: 'www.amazon.co.uk' });
  check('custom marketplace host', host[0].url.startsWith('https://www.amazon.co.uk/dp/'), host);

  const evil = L.buyLinks(meta, { amazonTag: 'a b&c=d' });
  check('tag is url-encoded', evil[0].url.includes('tag=a%20b%26c%3Dd'), evil[0].url);

  // --- ISBN cleaner -------------------------------------------------------
  check('isbn cleaner: excel guard', L.cleanIsbn('="9780547928241"') === '9780547928241');
  check('isbn cleaner: X check digit', L.cleanIsbn('014044913x') === '014044913X');
  check('isbn cleaner: garbage', L.cleanIsbn('n/a') === '');

  console.log(fails === 0 ? '\nALL LIB TESTS PASSED' : `\n${fails} FAILURES`);
  process.exit(fails ? 1 : 0);
})();
