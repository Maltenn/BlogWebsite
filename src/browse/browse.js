// Browse (phase 6): the discovery stream ("For you"), Mutuals, board suggestions from interests, and the sidebar's Who
// to follow, by the small algorithm of docs/decisions/001-ranking.md (the scoring itself is score.js). Every suggestion
// says why it's there. Nothing is recorded about what anybody looks at; the one thing Browse writes is a "not
// interested" (browse_hidden) that a member asked for. Privacy and blocks work as everywhere else: discovery only
// shows open profiles' posts the viewer may see (VISIBLE: not hidden, deleted, banned or blocked either way), never
// photos a moderator holds, never a private author; people suggestions skip anyone banned or blocked either way, and a
// private profile shows as its name and picture only. Every candidate set is bounded and read through indexes; the
// row budget of each route is in docs/architecture.md (Browse).
import { fail, json, int, ipKey } from '../shared/http.js';
import { REF_COLS, ref, NOT_BLOCKED, VISIBLE, limit, meter } from '../shared/db.js';
import { ageCut } from '../shared/dates.js';
import { decay, closeness } from '../shared/affinity.js';
import { POST_COLS, POSTS, EXCERPT, hydrate, item } from '../social/items.js';
import { indexFor } from './terms.js';
import {
  WINDOW, ACTIVE, MIN_NET, CAPS, POPULAR_CAP, matchBoards, boardLadder, whyBoard, adamicAdar, rankMutuals, mutualPage,
  readMutualCursor, whyPerson, postHot, discoveryScore, reasonFor, byScore, discoveryPage, readCursor, writeCursor, pickCandidates,
} from './score.js';

// Every read below is cut to a fixed size before it is filtered, so nobody's data (a friend following 10,000 people,
// 10,000 replies, a flood of private posts) makes a request read more: docs/architecture.md (Browse, the row budget).
export const MY_FOLLOWS = 100;                   // your newest follows read, to find your friends among them
export const MAX_FRIENDS = 25;                   // the friends whose follows are read (newest friendships first)
export const PER_FRIEND = 20;                    // each of those friends' newest follows read
export const MAX_PAIRS = 250;                    // friend-of-friend pairs kept at most
export const BUCKETS = 8;                        // discovery: writers split by id into 8 buckets (posts_discover)…
export const BUCKET_ROWS = 64;                   // … and each bucket's newest 64 posts this week read
export const PER_AUTHOR = 3;                     // discovery: candidates kept per writer (before the page's cap of 2)
export const MAX_CANDIDATES = 150;               // discovery: candidates kept, newest first
export const FOLLOWEES_READ = 40;                // discovery: your newest follows whose replies are read
export const REPLIES_EACH = 2;                   // … their newest replies and their newest comments this week, 2 each
export const MAX_MISSING = 40;                   // … what they answered that isn't a candidate already, read at most
export const POPULAR_POOL = 60;                  // Who to follow's fallback: the most recently seen members read
export const POPULAR_KEEP = 20;                  // … of whom the first 20 who could be suggested have their followers counted
export const BUSY_EACH = 20;                     // each board's newest posts this week read to find the busy boards
const PER_PEOPLE = 20;                           // Mutuals: a page
const NAMED = 3;                                 // mutual friends named per person
// For you and Who to follow recompute on every request: a member (or, logged out, a network) may ask 60 times a minute
// and 600 an hour
const BROWSE_LIMITS = [[60, 60000], [600, 3600000]];

const viewerOf = c => (c.user ? c.user.id : 0);

// the answer, with the rows this request read in X-Rows-Read when SHOW_ROWS_READ is set (tests and the demo). Every
// Browse answer depends on who's asking, so none may be kept by a browser (no-store, json()'s default): a shared
// computer that switches accounts must never show the last member's suggestions.
function answer(c, body) {
  return json(body, 200, c.env.SHOW_ROWS_READ === '1' ? { 'X-Rows-Read': String(c.rowsRead) } : {});
}

// the rate limit of the routes that recompute everything: per member, or per network when logged out. Counted before
// the meter starts (its own count is at most 660 rows of `attempts`, in the row budget's last line)
async function browseLimit(c, what) {
  await limit(c, `browse:${what}:` + (c.user ? c.user.id : 'ip:' + await ipKey(c)), BROWSE_LIMITS, 'that\'s a lot of browsing. take a breather.');
}

// SQL: the viewer ?1 hid this (kind) from Browse
const HIDDEN = (kind, col) => `EXISTS (SELECT 1 FROM browse_hidden bh WHERE bh.user_id = ?1 AND bh.kind = '${kind}' AND bh.ref_id = ${col})`;

// SQL: the viewer ?1's friends (they follow each other, both accepted), not banned: among your newest 100 follows, the
// 25 newest friendships. Reads at most 100 index rows + 100 + 100.
const FRIENDS = `SELECT r.id FROM (SELECT f.followee_id AS id, f.accepted FROM follows f INDEXED BY follows_recent
      WHERE f.follower_id = ?1 AND f.status = 'accepted' ORDER BY f.accepted DESC LIMIT ${MY_FOLLOWS}) r
    JOIN follows g ON g.follower_id = r.id AND g.followee_id = ?1 AND g.status = 'accepted'
    JOIN users fu ON fu.id = r.id
  WHERE fu.banned = 0 ORDER BY MAX(r.accepted, g.accepted) DESC LIMIT ${MAX_FRIENDS}`;

// Suggestions keep adults and 13–17 year olds apart (001, open question 3: "the default here: no"; discovery too, by
// the owner's decision of phase 6): the latest birthday of an 18-year-old today (ageOn's rule, shared/dates.js), and
// whether the viewer is an adult. Logged out counts as an adult: only adults are suggested to nobody in particular.
// SQL on users `u` (people) or `a` (a post's writer), with these as ?2 and ?3 (people) or ?4 and ?5 (discovery).
export function ages(user, now) {
  const cut = ageCut(18, now);
  return { cut, adult: !user || user.birthdate <= cut ? 1 : 0 };
}
const SAME_AGE_GROUP = '((u.birthdate <= ?2) = ?3)';

// SQL: a person the viewer ?1 could be suggested: not them, not banned, not held for a moderator, not somebody they follow or asked to, no block
// either way, not hidden, the same age group (?2, ?3)
const SUGGESTABLE = col => `${col} != ?1 AND u.banned = 0 AND u.held = 0 AND ${SAME_AGE_GROUP}
  AND NOT EXISTS (SELECT 1 FROM follows xf WHERE xf.follower_id = ?1 AND xf.followee_id = ${col})
  AND ${NOT_BLOCKED(col)} AND NOT ${HIDDEN('person', col)}`;

// a suggested person as every Browse list shows them: name and picture (that's all for a private profile), whether
// they're private, the follow button's relation (the same shape as a profile's), and why they're suggested
function person(c, r, extra) {
  const p = {
    user: ref(r), private: r.follow_policy === 'approve',
    relation: c.user ? { following: 'none', followsMe: !!r.follows_me, friends: false, blockedByMe: false, canComment: false, canMessage: r.dm_policy === 'everyone' } : null,
    ...extra,
  };
  return { ...p, why: whyPerson({ ...extra, followsMe: !!r.follows_me }) };
}

/* ------------------------------------------------------------ mutuals */

// SQL: the friend-of-friend candidates of the viewer ?1 (mutualCandidates), people on their side of the 18 line (?2, ?3)
const MUTUALS = `WITH mine AS MATERIALIZED (${FRIENDS}),
    pairs AS MATERIALIZED (SELECT m.id AS via, g.follower_id AS cand FROM mine m
        JOIN follows g INDEXED BY sqlite_autoindex_follows_1 ON g.followee_id = m.id AND g.status = 'accepted'
          AND g.follower_id IN (SELECT y.followee_id FROM follows y INDEXED BY follows_recent
            WHERE y.follower_id = m.id AND y.status = 'accepted' ORDER BY y.accepted DESC LIMIT ${PER_FRIEND})
      LIMIT ${MAX_PAIRS}),
    deg AS (SELECT via, COUNT(*) AS d FROM pairs GROUP BY via)
    SELECT p.cand AS id, u.name, u.avatar, u.follow_policy, u.dm_policy, u.last_seen, json_group_array(json_array(p.via, d.d)) AS via,
      EXISTS (SELECT 1 FROM follows b WHERE b.follower_id = p.cand AND b.followee_id = ?1 AND b.status = 'accepted') AS follows_me
    FROM pairs p JOIN deg d ON d.via = p.via JOIN users u ON u.id = p.cand
    WHERE ${SUGGESTABLE('p.cand')}
    GROUP BY p.cand`;

// Friends of friends the viewer doesn't follow yet, ranked (score.js): [{ id, name, avatar, follow_policy, dm_policy,
// follows_me, n, aa, active, via: [mutual friend ids] }]. One query: FRIENDS (≤ 300 rows), then for each of those 25
// friends their newest 20 follows off the index and, for each, whether they follow the friend back (≤ 1,000 rows), at
// most 250 pairs, then the candidates (≤ 250, a few seeks each). A friend's friend count (for Adamic–Adar) is counted
// among their newest 20 follows.
async function mutualCandidates(c) {
  const { cut, adult } = ages(c.user, c.now);
  const { results } = await c.env.DB.prepare(MUTUALS).bind(c.user.id, cut, adult).all();
  return rankMutuals(results.map(r => {
    const via = JSON.parse(r.via);
    return { ...r, followsMe: !!r.follows_me, n: via.length, aa: adamicAdar(via.map(v => v[1])), active: r.last_seen != null && r.last_seen > c.now - ACTIVE, via: via.map(v => v[0]) };
  }));
}

// The people for these rows, each with their mutual friends: the count and the first 3 names, closest to the viewer
// first (the interaction score's closeness, then name). One query for the names.
async function withMutuals(c, rows) {
  const ids = [...new Set(rows.flatMap(r => r.via))];
  const { results } = ids.length ? await c.env.DB.prepare(`SELECT u.id, u.name, u.avatar, a.eff, a.updated, b.eff AS back, b.updated AS back_at
    FROM users u LEFT JOIN affinity a ON a.from_id = ?1 AND a.to_id = u.id LEFT JOIN affinity b ON b.from_id = u.id AND b.to_id = ?1
    WHERE u.id IN (SELECT value FROM json_each(?2))`).bind(c.user.id, JSON.stringify(ids)).all() : { results: [] };
  const close = new Map(results.map(r => [r.id, {
    ref: ref(r), name: r.name,
    score: closeness(r.eff == null ? 0 : decay(r.eff, r.updated, c.now), r.back == null ? 0 : decay(r.back, r.back_at, c.now)),
  }]));
  return rows.map(r => {
    const via = r.via.map(id => close.get(id)).filter(Boolean).sort((x, y) => y.score - x.score || x.name.localeCompare(y.name));
    return person(c, r, { mutual: { count: r.n, people: via.slice(0, NAMED).map(v => v.ref) }, because: 'mutual' });
  });
}

// GET /api/browse/mutuals?before= — friends of your friends you don't follow yet (nor asked to), most mutual friends
// first, then people who follow you, then Adamic–Adar (rare mutual friends count more), then the recently active;
// 20 a page. Each: { user, private, relation, mutual: { count, people (up to 3) }, because: 'mutual', why }.
// `next` is the cursor for before=. Logged out: nobody, with a prompt.
export async function mutuals(c) {
  if (c.user) await browseLimit(c, 'mutuals');
  meter(c);
  if (!c.user) return answer(c, { people: [], next: null, prompt: 'log in to see friends of your friends.' });
  const after = readMutualCursor(c.url.searchParams.get('before'));
  const { rows, next } = mutualPage(await mutualCandidates(c), after, PER_PEOPLE);
  return answer(c, { people: await withMutuals(c, rows), next });
}

// The fallback: recently active open profiles, most followers first (counted up to 25 each), from the first 20 who
// could be suggested among the 60 members seen most recently (in the last 30 days). Logged out: adults only.
// [{ id, name, avatar, dm_policy, follow_policy, followers, follows_me }]. Reads ≤ 60 + a few seeks each + 20 × 25.
async function popular(c) {
  const viewer = viewerOf(c);
  const { cut, adult } = ages(c.user, c.now);
  const { results } = await c.env.DB.prepare(`SELECT ${REF_COLS('u', '')}, u.follow_policy, u.dm_policy, u.last_seen,
      (SELECT COUNT(*) FROM (SELECT 1 FROM follows fc WHERE fc.followee_id = u.id AND fc.status = 'accepted' LIMIT ${POPULAR_CAP})) AS followers,
      EXISTS (SELECT 1 FROM follows b WHERE b.follower_id = u.id AND b.followee_id = ?1 AND b.status = 'accepted') AS follows_me
    FROM (SELECT id FROM users INDEXED BY users_seen WHERE last_seen > ?4 ORDER BY last_seen DESC LIMIT ${POPULAR_POOL}) s CROSS JOIN users u ON u.id = s.id
    WHERE u.follow_policy = 'open' AND ${viewer ? SUGGESTABLE('u.id') : `u.banned = 0 AND u.held = 0 AND ${SAME_AGE_GROUP}`}
    ORDER BY u.last_seen DESC LIMIT ${POPULAR_KEEP}`).bind(viewer, cut, adult, c.now - ACTIVE).all();
  return results.sort((x, y) => y.followers - x.followers || y.last_seen - x.last_seen || x.id - y.id);
}

// GET /api/browse/people?limit=3 — Who to follow (the feed's sidebar): your top mutuals, then (when there are fewer
// than `limit`, 1–10) recently active open profiles with the most followers. Logged out: the second list only, adults
// only. Each person as in Mutuals (because: 'mutual' | 'popular'; a popular one has `followers`, counted up to 25).
// Never kept by the browser (no-store): it's yours, and the next person at this computer is somebody else.
export async function people(c) {
  await browseLimit(c, 'people');
  meter(c);
  const n = Math.min(10, Math.max(1, int(c.url.searchParams.get('limit'), 3)));
  const out = c.user ? await withMutuals(c, (await mutualCandidates(c)).slice(0, n)) : [];
  if (out.length < n) {
    const have = new Set(out.map(p => p.user.id));
    for (const r of await popular(c)) {
      if (out.length >= n) break;
      if (!have.has(r.id)) out.push(person(c, r, { mutual: null, followers: r.followers, because: 'popular' }));
    }
  }
  return answer(c, { people: out });
}

/* ------------------------------------------------------------- boards */

// What a member's interests point at (score.js), from their profile row, against the boards ([{ id, slug, name,
// archived }]). [] when logged out or nothing matches.
async function interestMatches(c, data, boards) {
  let interests = null;
  try { interests = data ? JSON.parse(data).interests : null; } catch { /* unreadable: none */ }
  const has = !!interests && Object.values(interests).some(v => String(v || '').trim());
  return { has, matches: has ? matchBoards(interests, await indexFor(c, boards)) : [] };
}

// SQL: the boards with posts this week (threads and comments that show, by members who aren't banned), with how many
// people posted and how often, among each board's newest 20 posts of the week (read off posts_board_last, then checked:
// ≤ 20 index rows + 20 posts + 20 writers a board, whatever else was written). ?1 since, ?2 now.
const BUSY = `SELECT b.id AS board_id, COUNT(DISTINCT p.author_id) AS posters, COUNT(*) AS posts
  FROM boards b CROSS JOIN posts p ON p.id IN (SELECT x.id FROM posts x INDEXED BY posts_board_last
      WHERE x.board_id = b.id AND x.created > ?1 AND x.created <= ?2 ORDER BY x.created DESC LIMIT ${BUSY_EACH})
    JOIN users a ON a.id = p.author_id
  WHERE b.archived = 0 AND +p.deleted = 0 AND +p.hidden = 0 AND a.banned = 0
  GROUP BY b.id`;

// GET /api/browse/boards?limit=5 — boards for you (1–10, default 5): the boards your interests (the six fields of your
// profile) point to, through the curated board_terms, rarest words counting most; then the boards busiest this week;
// then the rest of the index. Never a board you've posted in, one you hid, or an archived one. Logged out: busiest,
// then the rest. { boards: [{ board: { slug, name, description, icon }, because: 'interests' | 'busy' | 'all',
// terms: [{ term, field }] (interests only), posters (this week), why }], hasInterests }
export async function boardsForYou(c) {
  meter(c);
  const n = Math.min(10, Math.max(1, int(c.url.searchParams.get('limit'), 5)));
  const DB = c.env.DB;
  const [boards, busy, mine = { results: [] }, profile = { results: [] }] = await DB.batch([
    DB.prepare('SELECT id, slug, name, description, icon, archived FROM boards ORDER BY position, id'),
    DB.prepare(BUSY).bind(c.now - WINDOW, c.now),
    c.user && DB.prepare(`SELECT b.id FROM boards b WHERE EXISTS (SELECT 1 FROM posts p WHERE p.author_id = ?1 AND p.board_id = b.id)
      OR ${HIDDEN('board', 'b.id')}`).bind(c.user.id),
    c.user && DB.prepare('SELECT data FROM profiles WHERE user_id = ?').bind(c.user.id),
  ].filter(Boolean));
  const live = boards.results.filter(b => !b.archived);
  const { has, matches } = await interestMatches(c, profile.results[0] && profile.results[0].data, live);
  const byId = new Map(live.map(b => [b.id, b]));
  const picks = boardLadder({
    matches, busy: busy.results.filter(b => byId.has(b.board_id)), all: live, skip: new Set(mine.results.map(r => r.id)), n,
  });
  return answer(c, {
    boards: picks.map(p => {
      const b = byId.get(p.board_id);
      return {
        board: { slug: b.slug, name: b.name, description: b.description, icon: b.icon }, because: p.source,
        ...(p.terms ? { terms: p.terms.map(t => ({ term: t.term, field: t.field })) } : {}), posters: p.posters, why: whyBoard(p, b.name),
      };
    }),
    hasInterests: has,
  });
}

/* ---------------------------------------------------------- discovery */

const COLS = `${POST_COLS}, p.hot AS k_hot, p.board_id AS k_board, a.dm_policy AS a_dm`;

// SQL: a post discovery may show the viewer ?1 at ?2, written since ?3: a status, blog post, quote or board thread they
// may see (VISIBLE), by an open profile that isn't theirs and is on the viewer's side of the 18 line (?4 the cut, ?5
// whether the viewer is an adult: ages()), no photo on it held by a moderator, a thread on a board that isn't archived
// and not at net -3 or lower. Logged in, also: not by somebody they follow (or asked to), not hidden by them (the post,
// its author or its board), and not on a board they posted in since ?6.
const ELIGIBLE = user => `p.kind IN ('status', 'blog', 'quote', 'thread') AND p.created > ?3 AND ${VISIBLE}
  AND a.follow_policy = 'open' AND p.author_id != ?1 AND ((a.birthdate <= ?4) = ?5)
  AND (p.board_id IS NULL OR (bd.archived = 0 AND p.score > ${MIN_NET}))
  AND NOT EXISTS (SELECT 1 FROM media hm WHERE hm.post_id = p.id AND hm.hidden = 1)${user ? `
  AND NOT EXISTS (SELECT 1 FROM follows xf WHERE xf.follower_id = ?1 AND xf.followee_id = p.author_id)
  AND NOT ${HIDDEN('post', 'p.id')} AND NOT ${HIDDEN('person', 'p.author_id')}
  AND (p.board_id IS NULL OR (NOT ${HIDDEN('board', 'p.board_id')}
    AND NOT EXISTS (SELECT 1 FROM posts mp WHERE mp.author_id = ?1 AND mp.board_id = p.board_id AND mp.created > ?6)))` : ''}`;

// SQL: discovery's candidates as of ?2, written since ?3. The writers fall in 8 buckets by id (author_id % 8); for each
// bucket, its newest 64 statuses, blog posts, quotes and threads, straight off posts_discover (≤ 512 index rows,
// whatever else was written: replies aren't in that index, and one account's flood only crowds the writers of its own
// bucket); of those, each writer's newest 3; of those, the newest 150. Only then are the posts read and filtered
// (ELIGIBLE). So one account posting all day takes 3 places, not all 150, and leaves 7/8 of everybody else untouched.
const SLICE = k => `SELECT * FROM (SELECT id, author_id, created FROM posts INDEXED BY posts_discover
    WHERE kind IN ('status', 'blog', 'quote', 'thread') AND author_id % ${BUCKETS} = ${k} AND created > ?3 AND created <= ?2
    ORDER BY created DESC LIMIT ${BUCKET_ROWS})`;
// (D1 allows 5 parts to a compound SELECT, so the buckets go in groups of 4)
const GROUPS = Array.from({ length: Math.ceil(BUCKETS / 4) }, (_, g) => Array.from({ length: 4 }, (_, i) => g * 4 + i).filter(k => k < BUCKETS));
// (the cap per writer and the newest 150 are picked in the Worker, score.js pickCandidates: a window function and two
// sorts in SQL would read the 512 rows over again, and D1 bills those passes too)
const RECENT = `WITH ${GROUPS.map((ks, g) => `part${g} AS (${ks.map(SLICE).join(' UNION ALL ')})`).join(', ')}
  ${GROUPS.map((_, g) => `SELECT id, author_id, created FROM part${g}`).join(' UNION ALL ')}`;
// SQL: the posts in the JSON list ?7 that discovery may show (ELIGIBLE, binds ?1–?6 as discover's)
const CANDIDATES = user => `SELECT ${COLS} FROM json_each(?7) j CROSS JOIN ${POSTS} WHERE p.id = j.value AND ${ELIGIBLE(user)}`;

// SQL: replies and board comments written since ?3 by people the viewer ?1 follows: what they answered (a comment
// counts for its thread), who wrote it. Only your newest 40 follows (not banned), and of each their newest 2 replies
// and newest 2 comments, read off posts_author: ≤ 40 + 40 + 160 index rows + 160 posts.
const FOLLOWED_REPLIES = `WITH fl AS MATERIALIZED (SELECT u.id, u.name FROM (SELECT f.followee_id AS id FROM follows f INDEXED BY follows_recent
        WHERE f.follower_id = ?1 AND f.status = 'accepted' ORDER BY f.accepted DESC LIMIT ${FOLLOWEES_READ}) f
      CROSS JOIN users u ON u.id = f.id WHERE u.banned = 0),
    rr AS MATERIALIZED (${['reply', 'comment'].map(kind => `SELECT fl.id AS uid, fl.name AS uname, r.kind, r.root_id, r.reply_to
      FROM fl CROSS JOIN posts r ON r.id IN (SELECT x.id FROM posts x WHERE x.author_id = fl.id AND x.kind = '${kind}'
        AND x.created > ?3 AND x.created <= ?2 ORDER BY x.created DESC LIMIT ${REPLIES_EACH})
      WHERE +r.deleted = 0 AND +r.hidden = 0`).join(' UNION ALL ')})
  SELECT DISTINCT CASE WHEN kind = 'comment' THEN root_id ELSE reply_to END AS target, uid, uname FROM rr`;

// GET /api/browse/discover?before= — "For you": recent posts and threads from people you don't follow and boards you
// don't post in (logged out: everybody's), scored by score.js: hot, plus 0.2 per person you follow who replied (up to
// 3), 0.3 when friends of yours follow the author, 0.3 for a thread on a board your interests point to; then 2 per
// author and 4 per board on a page of 20. Each: { item (the item every list shows; a thread carries its board), reason:
// 'replied' | 'friends' | 'interest' | 'popular', why, relation (to the item's author, for the follow button; null when
// logged out) }. `next` is the cursor for before= (a place in the score order, plus the posts a cap held back).
export async function discover(c) {
  const cursor = c.url.searchParams.get('before') ? readCursor(c.url.searchParams.get('before')) : null;
  if (c.url.searchParams.get('before') && !cursor) fail(400, 'bad cursor');
  await browseLimit(c, 'discover');
  meter(c);
  const DB = c.env.DB;
  const user = !!c.user;
  const viewer = viewerOf(c);
  const since = c.now - WINDOW;
  const { cut, adult } = ages(c.user, c.now);
  const binds = [viewer, c.now, since, cut, adult, c.now - ACTIVE];          // ?1–?6 (logged out leaves ?6 unused)
  const [recent, replies = { results: [] }, boards = { results: [] }, profile = { results: [] }] = await DB.batch([
    DB.prepare(RECENT).bind(viewer, c.now, since),
    user && DB.prepare(FOLLOWED_REPLIES).bind(viewer, c.now, since),
    user && DB.prepare('SELECT id, slug, name, archived FROM boards'),
    user && DB.prepare('SELECT data FROM profiles WHERE user_id = ?').bind(viewer),
  ].filter(Boolean));
  const replied = new Map();                     // post id → [names of people I follow who replied]
  for (const r of replies.results) replied.set(r.target, [...(replied.get(r.target) || []), r.uname]);
  // the candidates (each writer's newest 3, the newest 150), and what people you follow answered that isn't one of
  // them (40 at most), read and checked in one go
  const picked = pickCandidates(recent.results, PER_AUTHOR, MAX_CANDIDATES);
  const ids = new Set(picked);
  const missing = [...replied.keys()].filter(id => !ids.has(id)).slice(0, MAX_MISSING);
  const [cand] = await DB.batch([DB.prepare(CANDIDATES(user)).bind(...binds, JSON.stringify([...picked, ...missing]))]);

  const rows = new Map(cand.results.map(r => [r.id, r]));
  const friendsOf = new Map();                   // author id → [my friends who follow them, closest first]
  const followsMe = new Set();
  let interest = new Map();                      // board id → the term that points there
  if (user) {
    // the writers of every candidate, for "your friends follow them" and "follows you": point lookups on the follows'
    // key (your ≤ 25 friends × the writers, and you × the writers), never anybody's whole list
    const authors = JSON.stringify([...new Set([...rows.values()].map(r => r.a_id))]);
    const [friends, back] = await DB.batch([
      DB.prepare(`WITH mine AS MATERIALIZED (${FRIENDS})
        SELECT f.followee_id AS author, mu.name, a.eff, a.updated FROM mine m
          CROSS JOIN json_each(?2) w CROSS JOIN follows f ON f.follower_id = m.id AND f.followee_id = w.value AND f.status = 'accepted'
          JOIN users mu ON mu.id = m.id LEFT JOIN affinity a ON a.from_id = ?1 AND a.to_id = m.id`).bind(viewer, authors),
      DB.prepare(`SELECT f.follower_id AS id FROM json_each(?2) w CROSS JOIN follows f ON f.follower_id = w.value AND f.followee_id = ?1
        WHERE f.status = 'accepted'`).bind(viewer, authors),
    ]);
    const sorted = friends.results.map(r => ({ ...r, s: r.eff == null ? 0 : decay(r.eff, r.updated, c.now) }))
      .sort((x, y) => y.s - x.s || x.name.localeCompare(y.name));
    for (const r of sorted) friendsOf.set(r.author, [...(friendsOf.get(r.author) || []), r.name]);
    for (const r of back.results) followsMe.add(r.id);
    const { matches } = await interestMatches(c, profile.results[0] && profile.results[0].data, boards.results);
    interest = new Map(matches.map(m => [m.board_id, m.terms[0]]));
  }

  const ranked = [...rows.values()].map(r => {
    const who = (replied.get(r.id) || []).sort((x, y) => x.localeCompare(y));
    const friends = friendsOf.get(r.a_id) || [];
    const term = r.kind === 'thread' ? interest.get(r.k_board) || null : null;
    return {
      id: r.id, author: r.a_id, board: r.k_board, row: r,
      score: discoveryScore(postHot({ ...r, hot: r.k_hot }), { replied: who.length, friends: friends.length, interest: !!term }),
      reason: reasonFor({ kind: r.kind, author: r.a_name, board: r.b_name, replied: who, friends, term }),
    };
  }).sort(byScore);
  const { rows: shown, next } = discoveryPage(ranked, cursor, CAPS);
  const h = await hydrate(c, shown.map(s => s.row));
  return answer(c, {
    items: shown.map(s => ({
      item: item(c, s.row, h, EXCERPT), reason: s.reason.kind, why: s.reason.why,
      relation: user ? { following: 'none', followsMe: followsMe.has(s.author), friends: false, blockedByMe: false, canComment: false, canMessage: s.row.a_dm === 'everyone' } : null,
    })),
    next: next ? writeCursor(next) : null,
  });
}

/* ---------------------------------------------------- not interested */

const KINDS = ['person', 'board', 'post'];
const NOTHING = 'nothing like that to hide.';

// the thing a "not interested" names (:ref: a user's or a post's id, a board's slug), checked: somebody else who
// exists, a board. A post isn't looked up: any id is taken as it is (a row about a post that isn't there, or that you
// can't see, hides nothing), so the answer never tells whether a private or hidden post exists. Answers { kind, id }.
async function hideTarget(c) {
  const kind = c.params.kind;
  if (!KINDS.includes(kind)) fail(404, NOTHING);
  const r = String(c.params.ref);
  const id = /^\d{1,15}$/.test(r) ? Number(r) : null;
  if (kind === 'post') {
    if (!id) fail(404, NOTHING);
    return { kind, id };
  }
  const row = kind === 'board' ? await c.env.DB.prepare('SELECT id FROM boards WHERE slug = ?').bind(r.toLowerCase()).first()
    : id && await c.env.DB.prepare('SELECT id FROM users WHERE id = ?1 AND id != ?2').bind(id, c.user.id).first();
  if (!row) fail(404, NOTHING);
  return { kind, id: row.id };
}

// POST /api/browse/hidden/:kind/:ref — "not interested": person (:ref their id; out of Mutuals and Who to follow, their
// posts out of discovery), board (:ref its slug; out of the board suggestions, its threads out of discovery) or post
// (:ref its id, any id: out of discovery). Nobody is told. 300 a day, counted before anything is looked up (a miss
// counts too). → { hidden: { kind, id } }
export async function hideSuggestion(c) {
  await limit(c, 'hide:' + c.user.id, [[300, 86400000]], 'that\'s a lot of hiding for one day.');
  const t = await hideTarget(c);
  await c.env.DB.prepare('INSERT OR IGNORE INTO browse_hidden (user_id, kind, ref_id, created) VALUES (?, ?, ?, ?)').bind(c.user.id, t.kind, t.id, c.now).run();
  return json({ hidden: t });
}

// DELETE /api/browse/hidden/:kind/:ref — undo it → { hidden: null }
export async function unhideSuggestion(c) {
  const t = await hideTarget(c);
  await c.env.DB.prepare('DELETE FROM browse_hidden WHERE user_id = ? AND kind = ? AND ref_id = ?').bind(c.user.id, t.kind, t.id).run();
  return json({ hidden: null });
}
