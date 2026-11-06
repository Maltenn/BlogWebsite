// Browse's small, explainable algorithm (docs/decisions/001-ranking.md): pure functions, unit-tested in
// test/browse.test.mjs, with no database and no clock of their own. browse.js reads the candidates with bounded, indexed
// queries and hands them here; everything that decides an order, a cap or a reason is in this file.
//   · interests → boards: the six interest fields cut into phrases, every 1–3 word run looked up in the board_terms
//     crosswalk, each match weighted by how rare the term is (IDF)
//   · mutuals: friends of friends by mutual friends, then "follows you", then Adamic–Adar, then recently active
//   · discovery: hot plus a few small boosts, then at most 2 posts per author and 4 per board on a page
// Nothing here uses views, dwell, scroll or watch time: none of that is recorded anywhere.
import { hot } from '../shared/ranking.js';

export const DAY = 86400000;
export const WINDOW = 7 * DAY;                   // discovery reads the last 7 days; "busy" boards are busy this week
export const ACTIVE = 30 * DAY;                  // a board you posted in within 30 days is one you're active in

/* -------------------------------------------------- interests → boards */

export const INTEREST_FIELDS = ['General', 'Music', 'Movies', 'Television', 'Books', 'Heroes'];
// a field "matches" a board's own subject (001: Music for a music board), so its terms count 1.5 times there
export const FIELD_BOARDS = { Music: ['music'], Movies: ['movies-tv'], Television: ['movies-tv'], Books: ['books-writing'] };
export const FIELD_WEIGHT = 1.5;
export const MIN_BOARD_SCORE = 1;                // a board needs this much to be suggested from interests
export const MAX_PHRASES = 40;                   // phrases read from one profile
export const MAX_PHRASE = 60;                    // characters of one phrase
export const NGRAM = 3;                          // the longest run of words looked up (and the longest term)
const STOP = new Set(['and', 'the', 'of', 'a', 'an', 'n', 'to', 'in', 'on', 'for']);   // never a term by themselves

// lower case, no accents, "&" → "and", apostrophes dropped ("she's" → "shes"), anything else that isn't a letter or a
// digit → a space
export const clean = s => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, ' and ')
  .replace(/['’`]/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// a trailing "s" on a word over 3 letters goes (on both sides, so "killers" meets "killer")
export const fold = w => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);

// the words of a term or a phrase as people wrote them (cleaned), without a leading "the"
export function words(s) {
  const w = clean(s).split(' ').filter(Boolean);
  return w.length > 1 && w[0] === 'the' ? w.slice(1) : w;
}

// what a term or a run of words is looked up by: its words, folded
export const termKey = s => words(s).map(fold).join(' ');

// A term moderators may store: one to three words, 60 characters at most. Answers its cleaned form or null.
export function validTerm(s) {
  const w = clean(s).split(' ').filter(Boolean);
  const t = w.join(' ');
  return w.length && t.length <= MAX_PHRASE && words(t).length <= NGRAM && !(w.length === 1 && STOP.has(w[0])) ? t : null;
}

// One interest field → its phrases (each the list of its words): split on commas, semicolons, slashes, new lines, "&"
// and " and ", each cut at 60 characters.
export function phrases(text) {
  return String(text ?? '').split(/[,;/\n\r&+]+|\s+and\s+/i)
    .map(p => words(p.trim().slice(0, MAX_PHRASE))).filter(w => w.length);
}

// Every 1–3 word run of a profile's six fields: [{ key, shown, field }] (shown: the words as written, for the reason),
// from at most 40 phrases in all, in field order.
export function runsOf(interests) {
  const out = [];
  let left = MAX_PHRASES;
  for (const field of INTEREST_FIELDS) {
    for (const w of phrases(interests && interests[field])) {
      if (left-- <= 0) return out;
      const k = w.map(fold);
      for (let i = 0; i < w.length; i++) {
        for (let n = 1; n <= NGRAM && i + n <= w.length; n++) out.push({ key: k.slice(i, i + n).join(' '), shown: w.slice(i, i + n).join(' '), field });
      }
    }
  }
  return out;
}

// The lookup table: boards (not archived) [{ id, slug, name }] and their stored terms [{ term, board_id, weight }] →
// { terms: Map(key → Map(board id → weight)), N (boards), boards: Map(id → board) }. Each board's name counts as terms
// too (the whole name, and each word in it that isn't "and", "the" …), at weight 1 unless stored otherwise.
export function termIndex(boards, rows) {
  const terms = new Map();
  const byId = new Map(boards.map(b => [b.id, b]));
  const put = (key, id, w) => {
    if (!key || !byId.has(id)) return;
    if (!terms.has(key)) terms.set(key, new Map());
    const m = terms.get(key);
    if (!m.has(id)) m.set(id, w);
  };
  for (const r of rows) put(termKey(r.term), r.board_id, Number(r.weight) || 1);
  for (const b of boards) {
    const w = words(b.name);
    put(w.map(fold).join(' '), b.id, 1);
    for (const x of w) if (!STOP.has(x)) put(fold(x), b.id, 1);
  }
  return { terms, N: boards.length, boards: byId };
}

// How much a matched term says: ln(1 + N / df), df = the boards holding it. A term only one board has counts most.
export const idf = (N, df) => Math.log(1 + N / df);

// A profile's interests against the index → the boards they point to, best first: [{ board_id, score, terms }] where
// score = Σ over distinct matched terms of (1.5 if the field is the board's own subject, else 1) · weight · idf, and
// terms = [{ term (the words as written), field, score }] (each term once, where it counts most), best first. Only boards
// scoring 1 or more. Ties: more terms, then the board's id.
export function matchBoards(interests, index) {
  const per = new Map();                         // board id → Map(key → { term, field, score })
  for (const run of runsOf(interests)) {
    const holders = index.terms.get(run.key);
    if (!holders) continue;
    const df = holders.size;
    for (const [id, weight] of holders) {
      const b = index.boards.get(id);
      const wf = (FIELD_BOARDS[run.field] || []).includes(b.slug) ? FIELD_WEIGHT : 1;
      const s = wf * weight * idf(index.N, df);
      if (!per.has(id)) per.set(id, new Map());
      const got = per.get(id).get(run.key);
      if (!got || s > got.score) per.get(id).set(run.key, { term: run.shown, field: run.field, score: s });
    }
  }
  const out = [];
  for (const [id, m] of per) {
    const terms = [...m.values()].sort((x, y) => y.score - x.score || x.term.localeCompare(y.term));
    const score = terms.reduce((a, t) => a + t.score, 0);
    if (score >= MIN_BOARD_SCORE) out.push({ board_id: id, score, terms });
  }
  return out.sort((x, y) => y.score - x.score || y.terms.length - x.terms.length || x.board_id - y.board_id);
}

// The board suggestions, n of them: boards from interests first, then the fallback ladder: boards busy this week (most
// people posting first), then every other board in the index's order. `skip` (a Set of board ids: boards you post in,
// boards you hid) never shows. busy: [{ board_id, posters, posts }]; all: [{ id }] in the index's order.
// Answers [{ board_id, source: 'interests' | 'busy' | 'all', terms?, posters }].
export function boardLadder({ matches = [], busy = [], all = [], skip = new Set(), n = 5 }) {
  const out = [];
  const seen = new Set(skip);
  const posters = new Map(busy.map(b => [b.board_id, b.posters]));
  const add = (id, x) => {
    if (out.length >= n || seen.has(id)) return;
    seen.add(id);
    out.push({ board_id: id, ...x, posters: posters.get(id) || 0 });
  };
  for (const m of matches) add(m.board_id, { source: 'interests', terms: m.terms });
  const ranked = [...busy].filter(b => b.posters > 0).sort((x, y) => y.posters - x.posters || y.posts - x.posts);
  for (const b of ranked) add(b.board_id, { source: 'busy' });
  for (const b of all) add(b.id, { source: 'all' });
  return out;
}

// why a board is suggested, in words
export function whyBoard(pick, boardName) {
  if (pick.source === 'interests') {
    const t = pick.terms[0];
    return `Because you listed "${t.term}" under ${t.field}`;
  }
  if (pick.source === 'busy') return `${pick.posters} ${pick.posters === 1 ? 'member' : 'members'} posted in ${boardName} this week`;
  return 'Quiet this week: start something';
}

/* ------------------------------------------------------------ mutuals */

// Adamic–Adar over the mutual friends' friend counts (each count includes you): Σ 1 / ln(2 + d). A mutual friend
// with few friends says more than one who's friends with everybody.
export const adamicAdar = degrees => degrees.reduce((a, d) => a + 1 / Math.log(2 + d), 0);

// A candidate's place: mutual friends, follows you, Adamic–Adar, active in 30 days (all high first), then the lower id.
// { n, followsMe, aa, active, id } → a key compared by compareKeys.
export const mutualKey = r => [r.n, r.followsMe ? 1 : 0, r.aa, r.active ? 1 : 0, -r.id];

// < 0 when key a comes first (every part, higher first)
export function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i] - a[i];
  return 0;
}

export const rankMutuals = rows => [...rows].sort((x, y) => compareKeys(mutualKey(x), mutualKey(y)));

// the cursor after a candidate, and back: "<n>:<follows you>:<aa>:<active>:<id>"
export const mutualCursor = r => mutualKey(r).map((v, i) => (i === 4 ? -v : v)).join(':');
export function readMutualCursor(s) {
  const p = String(s ?? '').split(':').map(Number);
  if (p.length !== 5 || !p.every(Number.isFinite)) return null;
  return [p[0], p[1], p[2], p[3], -p[4]];
}

// One page of ranked candidates after the cursor key (null: from the top) → { rows, next }
export function mutualPage(ranked, after, per) {
  const pool = after ? ranked.filter(r => compareKeys(mutualKey(r), after) > 0) : ranked;
  const rows = pool.slice(0, per);
  return { rows, next: pool.length > per ? mutualCursor(rows[rows.length - 1]) : null };
}

// "kat", "kat and pete", "kat, pete and mia", "kat, pete and 2 others": up to `names.length` names, then the rest
export function namesLine(names, count = names.length) {
  const shown = names.slice(0, count);
  const rest = count - shown.length;
  const parts = rest > 0 ? [...shown, `${rest} ${rest === 1 ? 'other' : 'others'}`] : shown;
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// why a person is suggested: their mutual friends with you (mutual.people: the first 3 by how close you are, out of
// mutual.count), or for the fallback list how many people follow them
export function whyPerson(p) {
  if (p.mutual) return `Friends with ${namesLine(p.mutual.people.map(x => x.name), p.mutual.count)}` + (p.followsMe ? ' · follows you' : '');
  if (p.followsMe) return 'Follows you';
  if (p.followers > 0) return `Followed by ${p.followers >= POPULAR_CAP ? `${POPULAR_CAP}+` : p.followers} ${p.followers === 1 ? 'person' : 'people'}`;
  return 'Active on OurSpace lately';
}
export const POPULAR_CAP = 25;                   // the fallback counts followers up to here (it's a bounded count)

/* ---------------------------------------------------------- discovery */

export const BOOST = { replied: 0.2, repliedMax: 3, friends: 0.3, interest: 0.3 };   // in UNITs of hot: 1.0 = 2 days
export const CAPS = { per: 20, author: 2, board: 4 };
export const MIN_NET = -3;                       // a thread at net -3 or lower isn't suggested

// hot for any candidate: a thread's stored key; a status, blog post or quote has no dislikes, and its likes and
// reposts are its votes (replies count up to 5, as on the boards)
export const postHot = r => (r.kind === 'thread' ? r.hot : hot((r.like_count || 0) + (r.repost_count || 0), 0, r.reply_count || 0, r.created));

// score = hot + 0.2 per person you follow who replied or commented (up to 3) + 0.3 if friends of yours follow the
// author + 0.3 if it's a thread on a board your interests point to
export function discoveryScore(base, { replied = 0, friends = 0, interest = false } = {}) {
  return base + BOOST.replied * Math.min(replied, BOOST.repliedMax) + (friends > 0 ? BOOST.friends : 0) + (interest ? BOOST.interest : 0);
}

// The reason a candidate shows, first match wins: people you follow replied (or commented), friends of yours follow the
// author, a board your interests point to, else popular. c: { kind, author, board, replied: [names], friends: [names],
// term: { term, field } | null } → { kind, why }
export function reasonFor(c) {
  const thread = c.kind === 'thread';
  if (c.replied && c.replied.length) {
    const [a, ...rest] = c.replied;
    if (thread) return { kind: 'replied', why: rest.length ? `${a} and ${namesLine([], rest.length)} you follow commented` : `${a}, who you follow, commented` };
    return { kind: 'replied', why: rest.length ? `Replied to by ${a} and ${namesLine([], rest.length)} you follow` : `Replied to by ${a}, who you follow` };
  }
  if (c.friends && c.friends.length) {
    const [a, ...rest] = c.friends;
    return { kind: 'friends', why: rest.length ? `${a} and ${rest.length} other ${rest.length === 1 ? 'friend' : 'friends'} follow ${c.author}` : `Your friend ${a} follows ${c.author}` };
  }
  if (c.term) return { kind: 'interest', why: `Because you listed "${c.term.term}" under ${c.term.field}` };
  return { kind: 'popular', why: thread && c.board ? `Popular in ${c.board}` : 'Popular on OurSpace this week' };
}

// The candidates discovery reads in full, from the newest posts of each bucket ([{ id, author_id, created }], any order):
// newest first (then the newer id), each writer's first `perAuthor` only, `max` in all. So one account posting all day
// takes `perAuthor` places, never the whole list. Answers [ids].
export function pickCandidates(recent, perAuthor = 3, max = 150) {
  const seen = new Map();
  const out = [];
  for (const r of [...recent].sort((x, y) => y.created - x.created || y.id - x.id)) {
    if (out.length >= max) break;
    const n = seen.get(r.author_id) || 0;
    if (n >= perAuthor) continue;
    seen.set(r.author_id, n + 1);
    out.push(r.id);
  }
  return out;
}

// the order every page reads the candidates in: score, then the newer id
export const byScore = (x, y) => y.score - x.score || y.id - x.id;
const below = (r, at) => r.score < at.score || (r.score === at.score && r.id < at.id);

export const MAX_DEFERRED = 40;                  // held-back posts a cursor carries at most

// One page of the ranked candidates ([{ id, score, author, board }], sorted by byScore), after the cursor { score, id,
// deferred: [ids] } (null: the first page): walk them in order, taking each one unless its author already has 2 on the
// page or its board 4, until 20 are taken. What's skipped for a cap isn't lost: its id rides in the next cursor and it's
// first in line on the next page (40 at most: the walk stops there, so the rest wait below the cursor's place). The
// cursor is a place in the score order, so a new post never makes a later page repeat or skip anything.
// Answers { rows, next: cursor | null }.
export function discoveryPage(ranked, cursor, caps = CAPS) {
  const deferred = new Set(cursor ? cursor.deferred : []);
  const pool = cursor ? ranked.filter(r => deferred.has(r.id) || below(r, cursor)) : ranked;
  const rows = [], skipped = [];
  const authors = new Map(), boards = new Map();
  let i = 0;
  for (; i < pool.length && rows.length < caps.per && skipped.length < MAX_DEFERRED; i++) {
    const r = pool[i];
    if ((authors.get(r.author) || 0) >= caps.author || (r.board != null && (boards.get(r.board) || 0) >= caps.board)) { skipped.push(r.id); continue; }
    rows.push(r);
    authors.set(r.author, (authors.get(r.author) || 0) + 1);
    if (r.board != null) boards.set(r.board, (boards.get(r.board) || 0) + 1);
  }
  const more = i < pool.length || skipped.length > 0;
  if (!more || !rows.length) return { rows, next: null };
  // the place reached: the last candidate walked, unless that was one held back earlier (those sit above the old place)
  const last = pool[i - 1];
  const at = !cursor || below(last, cursor) ? last : cursor;
  // still held: what was skipped now, and earlier hold-backs the page filled up before reaching
  const held = [...skipped, ...pool.slice(i).filter(r => deferred.has(r.id)).map(r => r.id)];
  return { rows, next: { score: at.score, id: at.id, deferred: held } };
}

// a discovery cursor as text and back: "<score>:<id>:<deferred ids, dot-separated>"
export const writeCursor = c => `${c.score}:${c.id}:${c.deferred.join('.')}`;
export function readCursor(s) {
  const [score, id, rest = ''] = String(s ?? '').split(':');
  const x = { score: Number(score), id: Number(id), deferred: rest ? rest.split('.').map(Number) : [] };
  if (score === '' || !Number.isFinite(x.score) || !Number.isSafeInteger(x.id) || x.deferred.length > MAX_DEFERRED || !x.deferred.every(Number.isSafeInteger)) return null;
  return x;
}
