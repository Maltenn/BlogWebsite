// Unit tests for Browse's scoring (src/browse/score.js, docs/decisions/001-ranking.md): interests → boards through the
// board_terms crosswalk, the mutuals ranking with Adamic–Adar, the discovery score, its diversity caps and cursor, and
// the board fallback ladder. Pure functions on fixed fixtures: no server needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clean, fold, words, termKey, validTerm, phrases, runsOf, termIndex, idf, matchBoards, boardLadder, whyBoard, adamicAdar,
  rankMutuals, mutualPage, mutualCursor, readMutualCursor, namesLine, whyPerson, postHot, discoveryScore, reasonFor, byScore,
  discoveryPage, readCursor, writeCursor, pickCandidates, BOOST, CAPS, FIELD_WEIGHT, MIN_BOARD_SCORE,
} from '../src/browse/score.js';
import { hot } from '../src/shared/ranking.js';
import { ageCut, ageOn } from '../src/shared/dates.js';
import { ages } from '../src/browse/browse.js';

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} ≠ ${expected}`);

/* -------------------------------------------------- interests → boards */

test('normalizing: case, accents, "&", apostrophes and punctuation; a leading "the"; a trailing "s" folded on longer words', () => {
  assert.equal(clean('  Beyoncé & JAY-Z!!  '), 'beyonce and jay z');
  assert.equal(clean('She\'s the Man'), 'shes the man');
  assert.equal(clean('blink-182'), 'blink 182');
  assert.deepEqual(words('The Killers'), ['killers']);
  assert.deepEqual(words('the'), ['the'], 'a lone "the" stays a word');
  assert.equal(fold('killers'), 'killer');
  assert.equal(fold('gas'), 'gas', '3 letters: kept');
  assert.equal(termKey('The Killers'), termKey('killer'));
  assert.equal(termKey('Video Games'), 'video game');
  assert.equal(validTerm('  My Chemical Romance! '), 'my chemical romance');
  assert.equal(validTerm('the perks of being'), 'the perks of being', 'three words after "the"');
  assert.equal(validTerm('perks of being a wallflower'), null, 'more than three words');
  assert.equal(validTerm('and'), null, 'a stop word alone');
  assert.equal(validTerm('!!!'), null);
  assert.equal(validTerm('x'.repeat(61)), null, 'over 60 characters');
});

test('phrases: split on commas, semicolons, slashes, new lines, "&", "+" and " and ", 60 characters each', () => {
  assert.deepEqual(phrases('paramore, avril; the killers / britney (forever)\nsk8 & bmx and more'),
    [['paramore'], ['avril'], ['killers'], ['britney', 'forever'], ['sk8'], ['bmx'], ['more']]);
  assert.deepEqual(phrases('florence + the machine'), [['florence'], ['machine']]);
  assert.deepEqual(phrases(''), []);
  assert.equal(phrases('a'.repeat(100))[0][0].length, 60);
  // runs: every 1–3 word run of each phrase, with the words as written and the field
  const runs = runsOf({ Music: 'My Chemical Romance' });
  assert.deepEqual(runs.map(r => r.key), ['my', 'my chemical', 'my chemical romance', 'chemical', 'chemical romance', 'romance']);
  assert.ok(runs.every(r => r.field === 'Music'));
  // at most 40 phrases across the six fields
  const many = runsOf({ General: Array.from({ length: 50 }, (_, i) => `w${i}`).join(', ') });
  assert.equal(many.length, 40);
});

// four boards, a few terms: "punk" is on two, "music" (Music's own name) on one, "sk8" is nowhere
const BOARDS = [
  { id: 1, slug: 'music', name: 'Music' }, { id: 2, slug: 'movies-tv', name: 'Movies & TV' },
  { id: 3, slug: 'fashion', name: 'Fashion' }, { id: 4, slug: 'books-writing', name: 'Books & Writing' },
];
const TERMS = [
  { term: 'my chemical romance', board_id: 1, weight: 1 }, { term: 'punk', board_id: 1, weight: 1 }, { term: 'punk', board_id: 3, weight: 1 },
  { term: 'the killers', board_id: 1, weight: 1 }, { term: 'band tees', board_id: 3, weight: 1 }, { term: 'donnie darko', board_id: 2, weight: 1 },
  { term: 'poetry', board_id: 4, weight: 2 }, { term: 'ghost', board_id: 9, weight: 1 },
];

test('the term index: stored terms folded, each board\'s own name and its words, unknown boards left out', () => {
  const ix = termIndex(BOARDS, TERMS);
  assert.equal(ix.N, 4);
  assert.deepEqual([...ix.terms.get('punk').keys()], [1, 3]);
  assert.ok(ix.terms.has('killer'), '"the killers" is stored folded');
  assert.ok(ix.terms.get('movie and tv').has(2), 'the whole name');
  assert.ok(ix.terms.get('movie').has(2) && ix.terms.get('tv').has(2), 'and its words');
  assert.ok(!ix.terms.has('and'), 'never "and"');
  assert.equal(ix.terms.get('poetry').get(4), 2, 'the stored weight');
  assert.ok(!ix.terms.has('ghost'), 'a term for a board that isn\'t there (or is archived)');
  near(idf(4, 1), Math.log(5), 'idf');
});

test('interests → boards: Σ field weight · weight · ln(1 + N/df) over distinct terms; multi-word terms, case and punctuation', () => {
  const ix = termIndex(BOARDS, TERMS);
  const got = matchBoards({ Music: 'MY CHEMICAL ROMANCE!!, The Killers', General: 'punk', Movies: 'Donnie Darko', Heroes: 'sk8' }, ix);
  const music = got.find(m => m.board_id === 1);
  // mcr and killers under Music (Music's own field: 1.5 · ln 5 each), punk under General (1 · ln 3: two boards hold it)
  near(music.score, 2 * FIELD_WEIGHT * Math.log(5) + Math.log(3), 'music');
  assert.deepEqual(music.terms.map(t => [t.term, t.field]), [['killers', 'Music'], ['my chemical romance', 'Music'], ['punk', 'General']]);
  const movies = got.find(m => m.board_id === 2);
  near(movies.score, FIELD_WEIGHT * Math.log(5), 'Movies is movies-tv\'s field');
  const fashion = got.find(m => m.board_id === 3);
  near(fashion.score, Math.log(3), 'punk alone: ln 3 ≈ 1.10, just over the bar');
  assert.ok(fashion.score >= MIN_BOARD_SCORE);
  assert.deepEqual(got.map(m => m.board_id), [1, 2, 3], 'best first');
});

test('interests → boards: a term counts once per board (where it counts most), a common word fades, nothing below 1', () => {
  // with 14 boards all holding "music", it's worth ln 2 ≈ 0.69 anywhere: not enough on its own
  const many = Array.from({ length: 14 }, (_, i) => ({ id: i + 1, slug: `b${i}`, name: `Board ${i}` }));
  const ix = termIndex(many, many.map(b => ({ term: 'music', board_id: b.id, weight: 1 })));
  assert.deepEqual(matchBoards({ General: 'music', Music: 'music, Music' }, ix), []);
  // the same term in two fields counts once, at the better field
  const ix2 = termIndex(BOARDS, TERMS);
  const [m] = matchBoards({ General: 'the killers', Music: 'killers' }, ix2);
  near(m.score, FIELD_WEIGHT * Math.log(5), 'once, as Music');
  assert.deepEqual(m.terms.map(t => t.field), ['Music']);
  // the stored weight scales a term: poetry (weight 2) under Books, Books & Writing's field
  near(matchBoards({ Books: 'poetry' }, ix2)[0].score, FIELD_WEIGHT * 2 * Math.log(5), 'weight 2');
  // nothing listed, nothing matched
  assert.deepEqual(matchBoards({}, ix2), []);
  assert.deepEqual(matchBoards(null, ix2), []);
});

test('the board ladder: interests, then busy this week, then the rest; never a skipped board; reasons for each', () => {
  const all = [1, 2, 3, 4, 5, 6].map(id => ({ id }));
  const matches = [{ board_id: 3, score: 4, terms: [{ term: 'band tees', field: 'General' }] }, { board_id: 2, score: 2, terms: [{ term: 'buffy', field: 'Television' }] }];
  const busy = [{ board_id: 5, posters: 2, posts: 9 }, { board_id: 4, posters: 7, posts: 7 }, { board_id: 3, posters: 1, posts: 1 }, { board_id: 6, posters: 0, posts: 0 }];
  const got = boardLadder({ matches, busy, all, skip: new Set([2]), n: 5 });
  assert.deepEqual(got.map(p => [p.board_id, p.source]), [[3, 'interests'], [4, 'busy'], [5, 'busy'], [1, 'all'], [6, 'all']]);
  assert.equal(got[0].posters, 1, 'a board from interests says how busy it is too');
  assert.equal(whyBoard(got[0], 'Fashion'), 'Because you listed "band tees" under General');
  assert.equal(whyBoard(got[1], 'Pets'), '7 members posted in Pets this week');
  assert.equal(whyBoard({ source: 'busy', posters: 1 }, 'Pets'), '1 member posted in Pets this week');
  assert.equal(whyBoard(got[3], 'Music'), 'Quiet this week: start something');
  // no interests and nothing busy: the index in order; n caps it
  assert.deepEqual(boardLadder({ all, n: 3 }).map(p => p.board_id), [1, 2, 3]);
  // busiest: most people posting, then most posts
  assert.deepEqual(boardLadder({ busy: [{ board_id: 1, posters: 2, posts: 2 }, { board_id: 2, posters: 2, posts: 5 }], n: 2 }).map(p => p.board_id), [2, 1]);
});

/* ------------------------------------------------------------ mutuals */

test('Adamic–Adar: Σ 1 / ln(2 + d); a mutual friend with few friends counts more', () => {
  near(adamicAdar([1]), 1 / Math.log(3), 'one friend of one');
  near(adamicAdar([1, 10]), 1 / Math.log(3) + 1 / Math.log(12), 'two');
  assert.ok(adamicAdar([2]) > adamicAdar([50]));
  assert.equal(adamicAdar([]), 0);
});

test('mutuals: most mutual friends, then follows you, then Adamic–Adar, then active, then the lower id', () => {
  const p = (id, n, followsMe, degrees, active = false) => ({ id, n, followsMe, aa: adamicAdar(degrees), active });
  const rows = [
    p(1, 1, false, [3]),
    p(2, 3, false, [50, 50, 50]),
    p(3, 2, false, [100, 100]),
    p(4, 2, true, [200, 200]),              // follows you: beats 3 despite a smaller Adamic–Adar
    p(5, 2, false, [4, 4]),                  // rare mutual friends: beats 3
    p(6, 2, false, [100, 100], true),        // a tie on everything with 3 but active: first
    p(7, 2, false, [100, 100]),              // a full tie with 3: the lower id first
  ];
  assert.deepEqual(rankMutuals(rows).map(r => r.id), [2, 4, 5, 6, 3, 7, 1]);
});

test('mutuals paging: a cursor is a place in the order, so people who drop out (followed) don\'t shift the next page', () => {
  const rows = rankMutuals(Array.from({ length: 7 }, (_, i) => ({ id: i + 1, n: 7 - i, followsMe: false, aa: 1 / 3, active: false })));
  const one = mutualPage(rows, null, 3);
  assert.deepEqual(one.rows.map(r => r.id), [1, 2, 3]);
  assert.equal(one.next, mutualCursor(rows[2]));
  assert.deepEqual(readMutualCursor(one.next), [5, 0, 1 / 3, 0, -3], 'the float survives the trip');
  // person 2 is followed in between (gone from the list) and 4 too: the next page still starts after 3
  const two = mutualPage(rows.filter(r => r.id !== 2 && r.id !== 4), readMutualCursor(one.next), 3);
  assert.deepEqual(two.rows.map(r => r.id), [5, 6, 7]);
  assert.equal(two.next, null);
  assert.equal(readMutualCursor('nope'), null);
  assert.equal(readMutualCursor('1:2:3'), null);
});

test('who you have in common, in words', () => {
  assert.equal(namesLine(['kat']), 'kat');
  assert.equal(namesLine(['kat', 'pete']), 'kat and pete');
  assert.equal(namesLine(['kat', 'pete', 'mia']), 'kat, pete and mia');
  assert.equal(namesLine(['kat', 'pete', 'mia'], 5), 'kat, pete, mia and 2 others');
  assert.equal(namesLine(['kat'], 2), 'kat and 1 other');
  assert.equal(namesLine([], 2), '2 others');
  const mutual = (names, count) => ({ count, people: names.map(name => ({ name })) });
  assert.equal(whyPerson({ mutual: mutual(['kat', 'pete'], 4) }), 'Friends with kat, pete and 2 others');
  assert.equal(whyPerson({ mutual: mutual(['kat'], 1), followsMe: true }), 'Friends with kat · follows you');
  assert.equal(whyPerson({ followers: 12 }), 'Followed by 12 people');
  assert.equal(whyPerson({ followers: 1 }), 'Followed by 1 person');
  assert.equal(whyPerson({ followers: 24 }), 'Followed by 24 people');
  assert.equal(whyPerson({ followers: 25 }), 'Followed by 25+ people', 'counted up to 25 (a bounded count)');
  assert.equal(whyPerson({ followers: 0 }), 'Active on OurSpace lately');
});

/* ---------------------------------------------------------- discovery */

test('the discovery score: hot plus 0.2 per person you follow who replied (up to 3), 0.3 friends, 0.3 interests', () => {
  const t = Date.UTC(2026, 9, 1);
  near(postHot({ kind: 'status', like_count: 4, repost_count: 5, reply_count: 9, created: t }), hot(9, 0, 9, t), 'likes and reposts are its votes, replies capped at 5');
  assert.equal(postHot({ kind: 'thread', hot: 7.5 }), 7.5, 'a thread\'s stored hot');
  near(discoveryScore(1), 1, 'no boosts');
  near(discoveryScore(1, { replied: 2 }), 1.4, 'two people');
  near(discoveryScore(1, { replied: 9 }), 1 + 3 * BOOST.replied, 'capped at 3');
  near(discoveryScore(1, { friends: 4, interest: true }), 1.6, 'friends (however many) and interests');
  // in hot's units 1.0 is 2 days: a post a day newer outweighs one friend-of-a-friend boost
  assert.ok(discoveryScore(hot(0, 0, 0, t + 86400000)) > discoveryScore(hot(0, 0, 0, t), { friends: 1 }));
});

test('reasons: first match wins (replied, friends, interests, popular), each in words', () => {
  assert.deepEqual(reasonFor({ kind: 'status', author: 'zed', replied: ['kat'], friends: ['mia'] }), { kind: 'replied', why: 'Replied to by kat, who you follow' });
  assert.equal(reasonFor({ kind: 'status', replied: ['kat', 'mia', 'jo'] }).why, 'Replied to by kat and 2 others you follow');
  assert.equal(reasonFor({ kind: 'thread', replied: ['kat'] }).why, 'kat, who you follow, commented');
  assert.equal(reasonFor({ kind: 'thread', replied: ['kat', 'jo'] }).why, 'kat and 1 other you follow commented');
  assert.deepEqual(reasonFor({ kind: 'blog', author: 'zed', replied: [], friends: ['kat'] }), { kind: 'friends', why: 'Your friend kat follows zed' });
  assert.equal(reasonFor({ kind: 'blog', author: 'zed', friends: ['kat', 'mia', 'jo'] }).why, 'kat and 2 other friends follow zed');
  assert.deepEqual(reasonFor({ kind: 'thread', board: 'Music', term: { term: 'paramore', field: 'Music' } }), { kind: 'interest', why: 'Because you listed "paramore" under Music' });
  assert.deepEqual(reasonFor({ kind: 'thread', board: 'Cooking' }), { kind: 'popular', why: 'Popular in Cooking' });
  assert.deepEqual(reasonFor({ kind: 'status' }), { kind: 'popular', why: 'Popular on OurSpace this week' });
});

// candidates: id, score, author, board (null for posts that aren't threads)
const C = (id, score, author, board = null) => ({ id, score, author, board });

test('diversity: at most 2 per author and 4 per board on a page; what a cap holds back comes first on the next page', () => {
  const ranked = [
    C(1, 9, 'a'), C(2, 8, 'a'), C(3, 7, 'a'), C(4, 6, 'b', 1), C(5, 5, 'c', 1), C(6, 4, 'd', 1), C(7, 3, 'e', 1), C(8, 2, 'f', 1), C(9, 1, 'g'),
  ].sort(byScore);
  const caps = { per: 5, author: 2, board: 4 };
  const one = discoveryPage(ranked, null, caps);
  assert.deepEqual(one.rows.map(r => r.id), [1, 2, 4, 5, 6], 'a\'s third waits');
  assert.deepEqual(one.next.deferred, [3]);
  const two = discoveryPage(ranked, readCursor(writeCursor(one.next)), caps);
  assert.deepEqual(two.rows.map(r => r.id), [3, 7, 8, 9], 'the held-back post leads; board 1 starts over on a new page');
  assert.equal(two.next, null, 'the end');
  // nothing repeats and nothing is lost
  assert.deepEqual([...one.rows, ...two.rows].map(r => r.id).sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('diversity on the real caps: one author with 30 posts takes 2 a page, the rest of the page is everybody else', () => {
  const ranked = [
    ...Array.from({ length: 30 }, (_, i) => C(100 + i, 100 - i, 'loud')),
    ...Array.from({ length: 30 }, (_, i) => C(200 + i, 50 - i, `p${i}`, i % 3)),
  ].sort(byScore);
  const seen = [];
  let cursor = null;
  for (let pages = 0; pages < 50; pages++) {
    const { rows, next } = discoveryPage(ranked, cursor, CAPS);
    const by = a => rows.filter(r => r.author === a).length;
    assert.ok(by('loud') <= 2);
    for (const b of [0, 1, 2]) assert.ok(rows.filter(r => r.board === b).length <= 4);
    assert.ok(rows.length <= 20);
    seen.push(...rows.map(r => r.id));
    if (!next) break;
    cursor = readCursor(writeCursor(next));
  }
  assert.equal(new Set(seen).size, seen.length, 'no repeats');
  assert.equal(seen.length, 60, 'and nothing is lost');
});

test('discovery paging is a place in the score order: a new post never shifts a later page', () => {
  const ranked = Array.from({ length: 30 }, (_, i) => C(i + 1, 30 - i, `p${i}`)).sort(byScore);
  const one = discoveryPage(ranked, null, CAPS);
  assert.deepEqual(one.rows.map(r => r.id), Array.from({ length: 20 }, (_, i) => i + 1));
  const fresh = [C(99, 100, 'new'), ...ranked].sort(byScore);
  const two = discoveryPage(fresh, readCursor(writeCursor(one.next)), CAPS);
  assert.deepEqual(two.rows.map(r => r.id), Array.from({ length: 10 }, (_, i) => i + 21), 'the new post is for a refresh, not page 2');
  // ties on score break on the newer id, both in the order and at the cursor
  const tied = [C(1, 5, 'a'), C(2, 5, 'b'), C(3, 5, 'c')].sort(byScore);
  assert.deepEqual(tied.map(r => r.id), [3, 2, 1]);
  const t1 = discoveryPage(tied, null, { per: 2, author: 2, board: 4 });
  assert.deepEqual(discoveryPage(tied, t1.next, { per: 2, author: 2, board: 4 }).rows.map(r => r.id), [1]);
  // cursors: what comes back is what went out; junk is refused
  assert.deepEqual(readCursor('1.5:12:'), { score: 1.5, id: 12, deferred: [] });
  assert.deepEqual(readCursor('-0.25:3:4.5'), { score: -0.25, id: 3, deferred: [4, 5] });
  for (const bad of ['', 'x:1:', '1:x:', '1:2:a.b', `1:2:${Array(50).fill(1).join('.')}`]) assert.equal(readCursor(bad), null, bad);
});

test('discovery candidates: newest first, each writer\'s newest 3 only, 150 in all, so one account posting all day can\'t fill them', () => {
  const spam = Array.from({ length: 300 }, (_, i) => ({ id: 1000 + i, author_id: 9, created: 10000 - i }));   // newest of all
  const others = Array.from({ length: 40 }, (_, i) => ({ id: 100 + i, author_id: 100 + (i % 20), created: 5000 - i }));
  const picked = pickCandidates([...others, ...spam], 3, 150);
  assert.deepEqual(picked.slice(0, 3), [1000, 1001, 1002], 'the spammer\'s newest 3 lead (they are the newest)');
  assert.equal(picked.filter(id => id >= 1000).length, 3, 'and that is all of theirs');
  assert.equal(picked.length, 43, 'everybody else\'s posts all make it (20 writers, 2 each)');
  assert.deepEqual(pickCandidates([{ id: 1, author_id: 1, created: 5 }, { id: 2, author_id: 2, created: 5 }, { id: 3, author_id: 1, created: 6 }], 1, 10), [3, 2], 'ties on time: the newer id');
  assert.equal(pickCandidates(Array.from({ length: 500 }, (_, i) => ({ id: i, author_id: i, created: i })), 3, 150).length, 150, '150 at most');
});

/* --------------------------------------------------------- the 18 line */

test('the 18 line: the cut is ageOn\'s rule as text, leap days included (born Feb 29; cut on Feb 28, Feb 29, Mar 1)', () => {
  const at = d => Date.parse(d + 'T12:00:00Z');
  // on a leap day the cut stays Feb 29 of the year 18 back (a Date would roll it to Mar 1, making a 17-year-old an adult)
  assert.equal(ageCut(18, at('2028-02-29')), '2010-02-29');
  assert.equal(ageCut(18, at('2026-02-28')), '2008-02-28');
  assert.equal(ageCut(18, at('2026-03-01')), '2008-03-01');
  assert.equal(ageCut(18, Date.parse('2026-03-01T00:00:00Z')), '2008-03-01', 'midnight UTC is already the new day');
  const cases = [
    ['2028-02-29', '2010-03-01', false], ['2028-02-29', '2010-02-28', true], ['2028-02-29', '2028-02-29', false],
    ['2046-02-28', '2028-02-29', false], ['2046-03-01', '2028-02-29', true], ['2046-02-28', '2028-02-28', true],
    ['2026-02-28', '2008-02-29', false], ['2026-03-01', '2008-02-29', true], ['2026-02-28', '2008-02-28', true],
    ['2027-02-28', '2009-02-28', true], ['2027-03-01', '2009-03-01', true], ['2027-02-28', '2009-03-01', false],
  ];
  for (const [day, born, adult] of cases) {
    const now = at(day);
    assert.equal(born <= ageCut(18, now), adult, `${born} on ${day}`);
    assert.equal(ageOn(born, now) >= 18, adult, `ageOn agrees: ${born} on ${day}`);
    assert.equal(ages({ birthdate: born }, now).adult, adult ? 1 : 0, `ages(): ${born} on ${day}`);
  }
  assert.equal(ages(null, at('2028-02-29')).adult, 1, 'logged out counts as an adult: adults only');
});
